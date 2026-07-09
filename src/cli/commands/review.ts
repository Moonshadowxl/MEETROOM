import { execFileSync } from "node:child_process";
import type { Session, Task } from "../../shared/types.js";
import { api, fail, requireContext, resolveAgentId, type Parsed } from "../client.js";
import { resolveSecrets } from "../../daemon/trust.js";

// V2 #3 — review gate CLI. `submit` auto-generates the diff via git against
// the task's claimed files; `--pr` (V3 #2) pushes the branch and opens a real
// PR through `gh`/`glab` (or a MEETROOM_PR_CMD template).

function git(args: string[], cwd = process.cwd()): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export async function cmdReview(parsed: Parsed): Promise<void> {
  const [sub, ...rest] = parsed.positional;
  const ctx = requireContext(parsed.flags);

  if (sub === "submit") {
    const taskId = rest[0];
    if (!taskId) fail("usage: meetroom review submit <task-id> [--confidence low|medium|high] [--pr]");
    const agentId = resolveAgentId(parsed.flags);
    const state = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
    const session = state.session as Session;
    const task = session.tasks.find((t: Task) => t.id === taskId);
    if (!task) fail(`no task ${taskId} in this session`);

    // Diff scoped to the task's files when it has any; whole tree otherwise.
    let diff: string;
    try {
      const scope = task!.files.length ? ["--", ...task!.files] : [];
      diff = git(["diff", "HEAD", ...scope]);
      if (!diff.trim()) diff = git(["diff", `${session.baseCommit ?? "HEAD"}`, ...scope]);
    } catch (err) {
      fail(`could not generate diff via git: ${(err as Error).message}`);
    }
    if (!diff!.trim()) fail("git diff is empty — nothing to submit for review");

    let prUrl: string | undefined;
    if (parsed.flags.pr) {
      prUrl = openPr(session.id, taskId, task!.title);
      console.log(`PR opened: ${prUrl}`);
    }

    const confidence = parsed.flags.confidence as string | undefined;
    if (confidence && !["low", "medium", "high"].includes(confidence)) fail("--confidence must be low|medium|high");
    const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/reviews`, {
      taskId,
      authorAgentId: agentId,
      diff,
      authorConfidence: confidence,
      prUrl,
    });
    console.log(`review ${data.review.id} submitted for task ${taskId} (${diff!.split("\n").length} diff lines)`);
    console.log(`another agent approves with: meetroom review approve ${data.review.id}`);
    return;
  }

  if (sub === "approve" || sub === "request-changes") {
    const reviewId = rest[0];
    const comment = rest.slice(1).join(" ") || undefined;
    if (!reviewId) fail(`usage: meetroom review ${sub} <review-id> ["comment"]`);
    if (sub === "request-changes" && !comment) fail('request-changes needs a comment: meetroom review request-changes <review-id> "<what to fix>"');
    const agentId = resolveAgentId(parsed.flags);
    await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/reviews/${reviewId}/decide`, {
      agentId,
      decision: sub === "approve" ? "approved" : "changes-requested",
      comment,
    });
    console.log(`review ${reviewId}: ${sub === "approve" ? "approved" : "changes requested"}`);
    return;
  }

  if (sub === "comment") {
    const reviewId = rest[0];
    const text = rest.slice(1).join(" ");
    if (!reviewId || !text) fail('usage: meetroom review comment <review-id> "<text>" [--line N]');
    const agentId = resolveAgentId(parsed.flags);
    await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/reviews/${reviewId}/comment`, {
      agentId,
      text,
      line: parsed.flags.line ? Number(parsed.flags.line) : undefined,
    });
    console.log("comment added");
    return;
  }

  if (sub === "show") {
    const reviewId = rest[0];
    if (!reviewId) fail("usage: meetroom review show <review-id>");
    const state = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
    const review = (state.session as Session).reviews.find((r) => r.id === reviewId);
    if (!review) fail(`no review ${reviewId}`);
    console.log(`review ${review!.id} — task ${review!.taskId} — ${review!.status}${review!.authorConfidence ? ` (confidence: ${review!.authorConfidence})` : ""}`);
    if (review!.prUrl) console.log(`PR: ${review!.prUrl}`);
    for (const c of review!.comments) console.log(`  [${c.agentId}${c.line ? ` L${c.line}` : ""}] ${c.text}`);
    console.log("");
    console.log(review!.diff);
    return;
  }

  // V3 #2 — sync PR state back into the room (webhook relays can hit the API directly).
  if (sub === "pr-sync") {
    const [reviewId, state] = rest;
    if (!reviewId || !["approved", "changes-requested", "merged"].includes(state)) {
      fail("usage: meetroom review pr-sync <review-id> approved|changes-requested|merged");
    }
    await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/reviews/${reviewId}/pr-sync`, { state });
    console.log(`PR state "${state}" synced to review ${reviewId}`);
    return;
  }

  fail(`unknown review subcommand "${sub}" (submit | approve | request-changes | comment | show | pr-sync)`);
}

/**
 * Push the current branch under the meetroom naming convention and open a PR.
 * Uses MEETROOM_PR_CMD as a template when set ({branch}/{title} placeholders);
 * otherwise tries `gh` then `glab`.
 */
function openPr(sessionId: string, taskId: string, title: string): string {
  const branch = `meetroom/${sessionId}/${taskId}`;
  try {
    const current = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    if (current !== branch) git(["checkout", "-B", branch]);
    git(["push", "-u", "origin", branch]);
  } catch (err) {
    fail(`could not push branch ${branch}: ${(err as Error).message}`);
  }
  const template = process.env.MEETROOM_PR_CMD;
  const cmds = template
    ? [resolveSecrets(template.replaceAll("{branch}", branch).replaceAll("{title}", title))]
    : [
        `gh pr create --head ${branch} --title ${JSON.stringify(`[meetroom] ${title}`)} --body "Automated meetroom review PR for task ${taskId}"`,
        `glab mr create --source-branch ${branch} --title ${JSON.stringify(`[meetroom] ${title}`)} --description "Automated meetroom review MR for task ${taskId}" -y`,
      ];
  for (const cmd of cmds) {
    try {
      const out = execFileSync("sh", ["-c", cmd], { encoding: "utf8" });
      const url = out.match(/https?:\/\/\S+/)?.[0];
      if (url) return url;
    } catch {
      continue;
    }
  }
  fail("branch pushed, but opening the PR failed — install `gh`/`glab` or set MEETROOM_PR_CMD (placeholders: {branch}, {title})");
}
