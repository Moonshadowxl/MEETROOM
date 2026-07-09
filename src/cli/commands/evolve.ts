import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import type { Session, SessionTemplate } from "../../shared/types.js";
import { api, csv, fail, requireContext, resolveAgentId, type Parsed } from "../client.js";
import { resolveSecrets } from "../../daemon/trust.js";
import { loadPolicy } from "../../daemon/trust.js";

// V7 (adapters, integrations, sync, bundles) + V8 (autonomy, veto, verify,
// retro, simulate, epics) CLI.

// ---- V7 #1 — agent adapter kit ---------------------------------------------------

const ADAPTER_BODIES: Record<string, (name: string, role: string) => string> = {
  claude: (name, role) => `#!/bin/sh
# meetroom adapter: Claude Code as agent "${name}" (${role})
set -e
meetroom join --name "${name}" --role "${role}" >/dev/null
export MEETROOM_AGENT="${name}"
trap 'meetroom leave --as "${name}" >/dev/null 2>&1' EXIT
BRIEF="$(meetroom brief)"
claude -p "You are agent '${name}' (${role}) in a meetroom session. Coordinate ONLY via the meetroom CLI:
- meetroom say/inbox for chat, meetroom board/status for state
- claim files BEFORE editing (meetroom claim <file> --wait), release when done
- work through tasks: task claim/move; submit diffs: meetroom review submit <task-id>
- report usage when you finish: meetroom usage report --in <tokens> --out <tokens>
Current room brief:
$BRIEF" "$@"
`,
  codex: (name, role) => `#!/bin/sh
# meetroom adapter: Codex CLI as agent "${name}" (${role})
set -e
meetroom join --name "${name}" --role "${role}" >/dev/null
export MEETROOM_AGENT="${name}"
trap 'meetroom leave --as "${name}" >/dev/null 2>&1' EXIT
BRIEF="$(meetroom brief)"
codex exec "You are agent '${name}' (${role}) in a meetroom session. Use the meetroom CLI for ALL coordination (say, claim, task, review, usage report). Brief:
$BRIEF" "$@"
`,
  generic: (name, role) => `#!/bin/sh
# meetroom adapter: generic agent "${name}" (${role})
# Usage: this-script <your-agent-command...>  — the brief is exported as $MEETROOM_BRIEF
set -e
meetroom join --name "${name}" --role "${role}" >/dev/null
export MEETROOM_AGENT="${name}"
export MEETROOM_BRIEF="$(meetroom brief)"
trap 'meetroom leave --as "${name}" >/dev/null 2>&1' EXIT
exec "$@"
`,
};

export async function cmdAdapter(parsed: Parsed): Promise<void> {
  const [sub, kind] = parsed.positional;
  if (sub !== "generate" || !ADAPTER_BODIES[kind]) {
    fail(`usage: meetroom adapter generate <claude|codex|generic> --name "Agent-1" [--role Implementer] [--out ./run-agent.sh]`);
  }
  const name = (parsed.flags.name as string) ?? "Agent-1";
  const role = (parsed.flags.role as string) ?? "Implementer";
  const out = (parsed.flags.out as string) ?? `./meetroom-${kind}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.sh`;
  writeFileSync(out, ADAPTER_BODIES[kind](name, role));
  chmodSync(out, 0o755);
  console.log(`adapter written: ${out}`);
  console.log(`run it in the project dir after \`meetroom start\` — it joins, injects the brief, and cleans up on exit`);
  console.log(`pair with the runner: meetroom agent spawn ${name} --cmd "${out}"`);
}

// ---- V7 #3 — inbound integrations -----------------------------------------------------

export async function cmdIntegration(parsed: Parsed): Promise<void> {
  const [sub, source] = parsed.positional;
  const ctx = requireContext(parsed.flags);
  if (sub !== "add" || !source) fail('usage: meetroom integration add <source> --secret "<shared secret>"');
  const secret = parsed.flags.secret as string;
  if (!secret) fail("--secret required (the sender signs message text with HMAC-SHA256 using it)");
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/integrations`, { source, secret });
  const example = createHmac("sha256", secret).update("hello room").digest("hex");
  console.log(`integration "${source}" configured. Senders POST:`);
  console.log(`  http://<daemon>:${ctx.port}/api/sessions/${ctx.sessionId}/inbound`);
  console.log(`  {"source":"${source}","author":"dana","text":"hello room","signature":"<hmac-sha256(text, secret)>"}`);
  console.log(`  (example signature for "hello room": ${example})`);
}

// ---- V7 #4 — GitHub issue sync (label-scoped, one-shot) -----------------------------------

export async function cmdSync(parsed: Parsed): Promise<void> {
  const [provider] = parsed.positional;
  if (provider !== "github") fail('usage: meetroom sync github --repo owner/name [--label meetroom]  (needs secret GITHUB_TOKEN)');
  const repo = parsed.flags.repo as string;
  if (!repo?.includes("/")) fail("--repo owner/name required");
  const label = (parsed.flags.label as string) ?? "meetroom";
  let token: string;
  try {
    token = resolveSecrets("{secret:GITHUB_TOKEN}");
  } catch (err) {
    fail((err as Error).message);
  }
  const ctx = requireContext(parsed.flags);
  const state = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
  const session = state.session as Session;
  const gh = async (path: string, init?: RequestInit) => {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token!}`, accept: "application/vnd.github+json", "user-agent": "meetroom", ...(init?.headers ?? {}) },
    });
    if (!res.ok) fail(`GitHub API ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };

  // Pull: labeled open issues that aren't on the board yet become tasks.
  const issues = (await gh(`/repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=50`)) as any[];
  let pulled = 0;
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const marker = `[gh-${issue.number}]`;
    if (session.tasks.some((t) => t.title.startsWith(marker))) continue;
    await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/tasks`, {
      title: `${marker} ${issue.title}`,
      description: (issue.body ?? "").slice(0, 2000),
    });
    pulled++;
  }

  // Push: done tasks that map to issues get a status comment (tracker stays the record).
  let pushed = 0;
  for (const task of session.tasks) {
    const m = task.title.match(/^\[gh-(\d+)\]/);
    if (!m || task.status !== "done") continue;
    const already = session.events.some((e) => e.type === "sync-pushed" && e.data?.taskId === task.id);
    if (already) continue;
    await gh(`/repos/${repo}/issues/${m[1]}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: `meetroom: task **${task.title}** completed in session \`${session.id}\` (review-gated).` }),
    });
    await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/say`, { agentId: "system", message: `synced done status of ${task.id} to ${repo}#${m[1]}` });
    pushed++;
  }
  console.log(`sync complete: ${pulled} issues pulled as tasks, ${pushed} done-statuses pushed to ${repo}`);
}

// ---- V7 #7 — blueprint bundles ---------------------------------------------------------------

export async function cmdBundle(parsed: Parsed): Promise<void> {
  const [sub, file] = parsed.positional;
  if (sub === "export") {
    if (!file) fail("usage: meetroom bundle export <file.mrb>");
    const ctx = requireContext(parsed.flags);
    const state = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
    const s = state.session as Session;
    const template: SessionTemplate = {
      name: (parsed.flags.name as string) ?? `bundle-${s.id}`,
      config: s.config,
      roster: s.agents.map((a) => ({ name: a.name, role: a.role, costTier: a.costTier, strengths: a.strengths })),
      budgets: s.budgets.map(({ breachedAt, ...b }) => b),
      notify: { webhooks: [], events: s.notify.events }, // webhook URLs are environment-specific: not exported
    };
    const bundle = {
      meetroomBundle: 1,
      template,
      policy: loadPolicy(s.cwd),
      plugins: s.plugins.map(({ id, installedBy, ...p }) => p), // never secrets, never memory
    };
    writeFileSync(file, JSON.stringify(bundle, null, 2));
    console.log(`bundle exported: ${file} (template + policy + ${bundle.plugins.length} plugins; no secrets, no memory)`);
    return;
  }
  if (sub === "import") {
    if (!file || !existsSync(file)) fail("usage: meetroom bundle import <file.mrb> [--confirm]");
    const bundle = JSON.parse(readFileSync(file, "utf8"));
    if (bundle.meetroomBundle !== 1) fail("not a meetroom bundle");
    console.log("bundle contents (dry run):");
    console.log(`  template: ${bundle.template?.name} (${bundle.template?.roster?.length ?? 0} roster slots)`);
    console.log(`  policy rules: ${bundle.policy?.length ?? 0}`);
    for (const p of bundle.plugins ?? []) {
      const perms = p.manifest?.permissions?.join(",") ?? "none declared";
      console.log(`  plugin: ${p.name} [${perms}] — ${p.command}`);
    }
    if (!parsed.flags.confirm) {
      console.log("\nre-run with --confirm to install into this project");
      return;
    }
    const cwd = process.cwd();
    const { saveTemplate } = await import("../../daemon/ops.js");
    if (bundle.template) saveTemplate(cwd, bundle.template, false);
    if (bundle.policy?.length) {
      writeFileSync(join(cwd, ".meetroom", "policy.json"), JSON.stringify(bundle.policy, null, 2));
    }
    if (bundle.plugins?.length) {
      writeFileSync(join(cwd, ".meetroom", "plugins.json"), JSON.stringify(bundle.plugins.map((p: any, i: number) => ({ ...p, id: `plug-import${i}`, installedBy: "bundle" })), null, 2));
    }
    console.log(`installed. start a room from it with: meetroom start --template ${bundle.template?.name}`);
    return;
  }
  fail(`unknown bundle subcommand "${sub}" (export | import)`);
}

// ---- V8 CLI ---------------------------------------------------------------------------------

export async function cmdAutonomy(parsed: Parsed): Promise<void> {
  const [sub, level] = parsed.positional;
  if (sub !== "set" || !["0", "1", "2", "3", "4"].includes(level)) {
    fail("usage: meetroom autonomy set <0-4> [--veto-window 10]\n  L0 observe · L1 assisted (default) · L2 supervised · L3 managed (meta-agent) · L4 delegated");
  }
  const ctx = requireContext(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/autonomy`, {
    level: Number(level),
    vetoWindowMinutes: parsed.flags["veto-window"] ? Number(parsed.flags["veto-window"]) : undefined,
  });
  console.log(`autonomy set to L${level}`);
  if (Number(level) >= 3 && !process.env.MEETROOM_OPERATOR) {
    console.log("note: L3+ meta-agent needs MEETROOM_OPERATOR set on the daemon to actually act");
  }
}

export async function cmdVeto(parsed: Parsed): Promise<void> {
  const actionId = parsed.positional[0];
  if (!actionId) fail("usage: meetroom veto <action-id>");
  const ctx = requireContext(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/actions/${actionId}/veto`);
  console.log(`action ${actionId} vetoed`);
}

/** V8 #7 — run the task's goal test locally, report the outcome to the room. */
export async function cmdVerify(parsed: Parsed): Promise<void> {
  const [sub, taskId] = parsed.positional;
  if (sub !== "run" || !taskId) fail("usage: meetroom verify run <task-id>");
  const ctx = requireContext(parsed.flags);
  const state = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
  const session = state.session as Session;
  const task = session.tasks.find((t) => t.id === taskId);
  if (!task) fail(`no task ${taskId}`);
  if (!task!.verify) fail(`task ${taskId} has no verify command (set one at creation with --verify "<cmd>")`);

  // Prefer the task's sandbox worktree when one exists (V3 #14).
  const sandbox = join(process.cwd(), ".meetroom", "worktrees", taskId);
  const cwd = existsSync(sandbox) ? sandbox : process.cwd();
  let passed = false;
  let output = "";
  try {
    output = execFileSync("sh", ["-c", task!.verify.command], {
      cwd,
      encoding: "utf8",
      timeout: (task!.verify.timeoutSeconds ?? 120) * 1000,
    });
    passed = true;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    output = `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message;
  }
  const agentId = resolveAgentId(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/tasks/${taskId}/verify`, { passed, output, agentId });
  console.log(`verify ${passed ? "PASSED" : "FAILED"} for ${taskId} (ran in ${cwd})`);
  if (!passed) {
    console.log(output.slice(0, 2000));
    process.exit(1);
  }
}

export async function cmdRetro(parsed: Parsed): Promise<void> {
  const sessionId = parsed.positional[0];
  const flags = sessionId ? { ...parsed.flags, session: sessionId } : parsed.flags;
  const ctx = requireContext(flags);
  const data = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/retro`);
  const r = data.retro;
  console.log(`retro — session ${r.sessionId}`);
  console.log(`tasks: ${r.stats.tasksDone}/${r.stats.tasksTotal} done · review bounce ${r.stats.reviewBounceRate}% · escalations ${r.stats.escalations} · claim timeouts ${r.stats.claimTimeouts}`);
  if (r.stats.avgTaskTurnaroundMinutes !== undefined) console.log(`avg task turnaround: ${r.stats.avgTaskTurnaroundMinutes}m`);
  console.log(`total cost: $${r.stats.totalCostUsd.toFixed(2)}`);
  console.log("\nsuggestions:");
  if (!r.suggestions.length) console.log("  (none — clean session)");
  for (const s of r.suggestions) console.log(`  - ${s}`);
}

export async function cmdSimulate(parsed: Parsed): Promise<void> {
  const description = parsed.positional.join(" ");
  if (!description) fail('usage: meetroom simulate "<feature description>"');
  const ctx = requireContext(parsed.flags);
  const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/simulate`, { description });
  const sim = data.simulation;
  console.log(`simulation (basis: ${sim.basis}):`);
  for (const t of sim.perTask) console.log(`  [${t.complexity}] ~${t.estMinutes}m — ${t.title}`);
  console.log(`\ntotal: ${sim.taskCount} tasks, ~${Math.round(sim.estTotalMinutes / 60 * 10) / 10} agent-hours${sim.estCostUsd ? `, ~$${sim.estCostUsd}` : ""}`);
  console.log(`plan drafted as ${data.plan.id} — approve with \`meetroom plan approve ${data.plan.id}\` or discard it`);
}

export async function cmdEpic(parsed: Parsed): Promise<void> {
  const [sub, ...rest] = parsed.positional;
  const ctx = requireContext(parsed.flags);

  if (sub === "create") {
    const title = rest.join(" ");
    if (!title) fail('usage: meetroom epic create "<title>" [--north-star "<the outcome>"]');
    const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/epics`, {
      title,
      northStar: parsed.flags["north-star"] ?? "",
    });
    console.log(`epic ${data.epic.id} created — attach tasks with: meetroom task create "..." --epic ${data.epic.id}`);
    return;
  }
  if (sub === "status") {
    const epicId = rest[0];
    if (epicId) {
      const data = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/epics/${epicId}/status`);
      console.log(`${data.epic.title} — ${data.epic.northStar}`);
      console.log(`progress: ${data.done}/${data.total} tasks done across sessions`);
      for (const line of data.open) console.log(`  ${line}`);
      return;
    }
  }
  if (sub === "list" || sub === "status" || sub === undefined) {
    const data = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/epics`);
    if (!data.epics.length) return console.log("no epics (create one with: meetroom epic create \"...\")");
    for (const e of data.epics) console.log(`${e.id} [${e.status}] ${e.title} — ${e.taskRefs.length} tasks`);
    return;
  }
  fail(`unknown epic subcommand "${sub}" (create | list | status [epic-id])`);
}
