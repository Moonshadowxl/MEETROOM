import type { Session } from "../../shared/types.js";
import { api, csv, fail, requireContext, resolveAgentId, type Parsed } from "../client.js";

// V2 #1 — task board CLI: create / claim / move (board lives in status.ts).

export async function cmdTask(parsed: Parsed): Promise<void> {
  const [sub, ...rest] = parsed.positional;
  const ctx = requireContext(parsed.flags);

  if (sub === "create") {
    const title = rest.join(" ");
    if (!title) fail('usage: meetroom task create "<title>" [--files a.ts,b.ts] [--depends-on <id>,<id>] [--requires-ci] [--requires-tests] [--description "..."]');
    const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/tasks`, {
      title,
      description: parsed.flags.description,
      files: csv(parsed.flags.files) ?? [],
      dependsOn: csv(parsed.flags["depends-on"]),
      requiresCI: !!parsed.flags["requires-ci"],
      requiresTests: !!parsed.flags["requires-tests"],
      // V8 #7 — the acceptance test, declared before implementation starts.
      verify: parsed.flags.verify ? { command: parsed.flags.verify as string } : undefined,
      epicId: parsed.flags.epic, // V8 #8
    });
    const t = data.task;
    console.log(`task ${t.id} created (${t.estimatedComplexity})${t.suggestedAgentId ? ` — routing suggests agent ${t.suggestedAgentId}` : ""}`);
    for (const w of t.conflictWarnings ?? []) console.log(`  warning: ${w}`);
    return;
  }

  if (sub === "claim") {
    const taskId = rest[0];
    if (!taskId) fail("usage: meetroom task claim <task-id>");
    const agentId = resolveAgentId(parsed.flags);
    const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/tasks/${taskId}/claim`, { agentId });
    console.log(`task ${taskId} claimed — its files were auto-claimed for you`);
    if (data.queuedFiles) console.log(`  queued (held by someone else, you're on the waitlist): ${data.queuedFiles.join(", ")}`);
    return;
  }

  if (sub === "move") {
    const [taskId, status] = rest;
    if (!taskId || !status) fail("usage: meetroom task move <task-id> <todo|in-progress|review|done|blocked>");
    const agentId = resolveAgentId(parsed.flags);
    const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/tasks/${taskId}/move`, { agentId, status });
    console.log(`task ${taskId} is now: ${data.status}`);
    return;
  }

  if (sub === "assign") {
    const [taskId, assignee] = rest;
    if (!taskId || !assignee) fail("usage: meetroom task assign <task-id> <agent-name>");
    const agentId = resolveAgentId(parsed.flags);
    await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/tasks/${taskId}/assign`, { agentId, assignee: assignee.replace(/^@/, "") });
    console.log(`task ${taskId} assigned to ${assignee}`);
    return;
  }

  if (sub === "drop") {
    const taskId = rest[0];
    if (!taskId) fail("usage: meetroom task drop <task-id>   (unassigns it; files stay claimed until released)");
    const agentId = resolveAgentId(parsed.flags);
    await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/tasks/${taskId}/assign`, { agentId, assignee: undefined });
    console.log(`task ${taskId} unassigned — back on the board`);
    return;
  }

  if (sub === "edit") {
    const taskId = rest[0];
    const { title, description, verify } = parsed.flags;
    const files = csv(parsed.flags.files);
    if (!taskId || (title === undefined && description === undefined && files === undefined && verify === undefined)) {
      fail('usage: meetroom task edit <task-id> [--title "..."] [--description "..."] [--files a,b] [--verify "<cmd>" | --verify ""]');
    }
    const agentId = resolveAgentId(parsed.flags);
    await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/tasks/${taskId}/edit`, {
      agentId,
      title,
      description,
      files,
      // --verify "" clears the goal test; --verify "<cmd>" replaces it.
      verify: verify === undefined ? undefined : typeof verify === "string" && verify.trim() ? { command: verify } : null,
    });
    console.log(`task ${taskId} updated`);
    return;
  }

  if (sub === "cancel") {
    const taskId = rest[0];
    if (!taskId) fail("usage: meetroom task cancel <task-id>   (reopen later with: meetroom task move <task-id> todo)");
    const agentId = resolveAgentId(parsed.flags);
    await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/tasks/${taskId}/cancel`, { agentId });
    console.log(`task ${taskId} cancelled — dependents were unblocked`);
    return;
  }

  if (sub === "show") {
    const taskId = rest[0];
    if (!taskId) fail("usage: meetroom task show <task-id>");
    const state = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
    const s = state.session as Session;
    const t = s.tasks.find((x) => x.id === taskId);
    if (!t) fail(`no task ${taskId} in this session`);
    const name = (id?: string) => (id ? s.agents.find((a) => a.id === id)?.name ?? id : "unassigned");
    console.log(`${t!.id} — ${t!.title} [${t!.status}]`);
    if (t!.description) console.log(`  ${t!.description}`);
    console.log(`  assignee: ${name(t!.assignedAgentId)}${t!.suggestedAgentId && !t!.assignedAgentId ? ` (suggested: ${name(t!.suggestedAgentId)})` : ""}`);
    console.log(`  complexity: ${t!.estimatedComplexity ?? "—"} · created ${t!.createdAt}${t!.doneAt ? ` · done ${t!.doneAt}` : ""}`);
    if (t!.files.length) console.log(`  files: ${t!.files.join(", ")}`);
    if (t!.dependsOn?.length) console.log(`  depends on: ${t!.dependsOn.map((d) => `${d} [${s.tasks.find((x) => x.id === d)?.status ?? "?"}]`).join(", ")}`);
    if (t!.epicId) console.log(`  epic: ${t!.epicId}`);
    const gates = [t!.requiresCI ? "CI" : null, t!.requiresTests ? "tests" : null, t!.verify ? "verify" : null].filter(Boolean);
    if (gates.length) console.log(`  gates: ${gates.join(" + ")}`);
    if (t!.verify) console.log(`  verify: ${t!.verify.command} → ${t!.verifyResult ? (t!.verifyResult.passed ? "PASSED" : "FAILED") + ` at ${t!.verifyResult.at}` : "not run"}`);
    if (t!.testResult) console.log(`  tests: ${t!.testResult}`);
    const ci = s.ciStatuses.find((c) => c.taskId === t!.id);
    if (ci) console.log(`  ci: ${ci.status} (${ci.provider})${ci.url ? ` — ${ci.url}` : ""}`);
    const reviews = s.reviews.filter((r) => r.taskId === t!.id);
    for (const r of reviews) {
      console.log(`  review ${r.id}: ${r.status}${r.reviewerAgentId ? ` by ${name(r.reviewerAgentId)}` : ""}${r.authorConfidence ? ` (confidence: ${r.authorConfidence})` : ""} · ${r.comments.length} comments`);
    }
    for (const w of t!.conflictWarnings ?? []) console.log(`  warning: ${w}`);
    if (t!.reassignedFrom?.length) console.log(`  previously assigned to: ${t!.reassignedFrom.map(name).join(", ")}`);
    return;
  }

  fail(`unknown task subcommand "${sub}" (create | claim | move | assign | drop | edit | cancel | show)`);
}

/** V3 #7 — QA gate: attach a test result to a task. */
export async function cmdTest(parsed: Parsed): Promise<void> {
  const [sub, taskId, result] = parsed.positional;
  if (sub !== "report" || !taskId || !["passed", "failed"].includes(result)) {
    fail("usage: meetroom test report <task-id> passed|failed");
  }
  const ctx = requireContext(parsed.flags);
  const agentId = resolveAgentId(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/tasks/${taskId}/tests`, { agentId, result });
  console.log(`test result "${result}" recorded for ${taskId}`);
}

/** V3 #3 — CI status (manual report; CI systems can POST the same endpoint). */
export async function cmdCI(parsed: Parsed): Promise<void> {
  const [sub, taskId, status] = parsed.positional;
  if (sub === "webhook-url") {
    const ctx = requireContext(parsed.flags);
    console.log(`POST http://<daemon-host>:${ctx.port}/api/sessions/${ctx.sessionId}/tasks/<task-id>/ci`);
    console.log(`body: {"status": "passed|failed|pending", "provider": "github-actions|gitlab-ci|generic-webhook", "url": "<run url>"}`);
    if (ctx.token) console.log(`header: x-meetroom-token: ${ctx.token}`);
    return;
  }
  if (sub !== "report" || !taskId || !["passed", "failed", "pending"].includes(status)) {
    fail("usage: meetroom ci report <task-id> passed|failed|pending [--url <run-url>] [--provider <name>]  |  meetroom ci webhook-url");
  }
  const ctx = requireContext(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/tasks/${taskId}/ci`, {
    status,
    provider: parsed.flags.provider ?? "generic-webhook",
    url: parsed.flags.url,
  });
  console.log(`CI status "${status}" recorded for ${taskId}`);
}
