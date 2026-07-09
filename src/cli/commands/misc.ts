import { execFileSync } from "node:child_process";
import type { Plugin, Session } from "../../shared/types.js";
import { listRoles } from "../../shared/roles.js";
import { api, fail, requireContext, resolveAgentId, type Parsed, csv } from "../client.js";

// usage tracking (V2 #10), plugins (V3 #1), notifications (V2 #4 / V3 #11),
// draft plans (V3 #13), roles, memory & reputation views.

export async function cmdUsage(parsed: Parsed): Promise<void> {
  const [sub] = parsed.positional;
  const ctx = requireContext(parsed.flags);
  if (sub === "report") {
    const agentId = resolveAgentId(parsed.flags);
    await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/usage`, {
      agentId,
      tokensIn: Number(parsed.flags.in ?? parsed.flags["tokens-in"] ?? 0),
      tokensOut: Number(parsed.flags.out ?? parsed.flags["tokens-out"] ?? 0),
      costUsd: Number(parsed.flags.cost ?? 0),
    });
    console.log("usage recorded");
    return;
  }
  if (sub === "show" || sub === undefined) {
    const data = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
    const s = data.session as Session;
    const byAgent = new Map<string, { tokensIn: number; tokensOut: number; costUsd: number }>();
    for (const u of s.usage) {
      const agg = byAgent.get(u.agentId) ?? { tokensIn: 0, tokensOut: 0, costUsd: 0 };
      agg.tokensIn += u.tokensIn;
      agg.tokensOut += u.tokensOut;
      agg.costUsd += u.costUsd;
      byAgent.set(u.agentId, agg);
    }
    if (byAgent.size === 0) return console.log("no usage reported yet (agents report with: meetroom usage report --in N --out N --cost X)");
    for (const [agentId, u] of byAgent) {
      const name = s.agents.find((a) => a.id === agentId)?.name ?? agentId;
      console.log(`${name}: ${u.tokensIn} in / ${u.tokensOut} out · $${u.costUsd.toFixed(4)}`);
    }
    return;
  }
  fail(`unknown usage subcommand "${sub}" (report | show)`);
}

export async function cmdPlugin(parsed: Parsed): Promise<void> {
  const [sub, name, ...args] = parsed.positional;
  const ctx = requireContext(parsed.flags);

  if (sub === "install") {
    const command = parsed.flags.command as string;
    if (!name || !command) fail('usage: meetroom plugin install <name> --command "<shell cmd>" [--project]');
    const agentId = resolveAgentId(parsed.flags);
    await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/plugins`, {
      name,
      command,
      installedBy: agentId,
      scope: parsed.flags.project ? "project" : "session",
    });
    console.log(`plugin "${name}" installed (${parsed.flags.project ? "project scope — persists via .meetroom/plugins.json" : "session scope"})`);
    return;
  }

  const data = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
  const plugins = (data.session as Session).plugins;

  if (sub === "list" || sub === undefined) {
    if (!plugins.length) return console.log("no plugins installed");
    for (const p of plugins) console.log(`${p.name} [${p.scope}] — ${p.command}`);
    return;
  }

  if (sub === "run") {
    if (!name) fail("usage: meetroom plugin run <name> [args...]");
    const plugin = plugins.find((p: Plugin) => p.name === name);
    if (!plugin) fail(`no plugin "${name}" — see \`meetroom plugin list\``);
    // Plugins are named shell command templates run locally by whoever invokes
    // them; {args} is substituted, otherwise args are appended.
    const cmd = plugin!.command.includes("{args}")
      ? plugin!.command.replaceAll("{args}", args.join(" "))
      : [plugin!.command, ...args].join(" ");
    console.log(`$ ${cmd}`);
    try {
      execFileSync("sh", ["-c", cmd], { stdio: "inherit" });
    } catch (err) {
      process.exit((err as { status?: number }).status ?? 1);
    }
    return;
  }

  fail(`unknown plugin subcommand "${sub}" (install | list | run)`);
}

export async function cmdNotify(parsed: Parsed): Promise<void> {
  const [sub] = parsed.positional;
  if (sub !== "configure") fail("usage: meetroom notify configure --webhook <url> | --slack-webhook <url> | --discord-webhook <url> [--events escalation,review-requested,...]");
  const ctx = requireContext(parsed.flags);
  const configs: Array<{ url: string; kind: string }> = [];
  if (typeof parsed.flags.webhook === "string") configs.push({ url: parsed.flags.webhook, kind: "generic" });
  if (typeof parsed.flags["slack-webhook"] === "string") configs.push({ url: parsed.flags["slack-webhook"] as string, kind: "slack" });
  if (typeof parsed.flags["discord-webhook"] === "string") configs.push({ url: parsed.flags["discord-webhook"] as string, kind: "discord" });
  if (!configs.length) fail("provide at least one of --webhook / --slack-webhook / --discord-webhook");
  for (const c of configs) {
    await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/notify`, { ...c, events: csv(parsed.flags.events) });
    console.log(`${c.kind} webhook configured`);
  }
}

export async function cmdPlan(parsed: Parsed): Promise<void> {
  const [first, ...rest] = parsed.positional;
  const ctx = requireContext(parsed.flags);

  if (first === "approve" || first === "discard") {
    const planId = rest[0];
    if (!planId) fail(`usage: meetroom plan ${first} <plan-id>`);
    const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/plan/${planId}/${first}`);
    console.log(first === "approve" ? `plan approved — tasks created: ${data.taskIds.join(", ")}` : "plan discarded");
    return;
  }

  const description = [first, ...rest].filter(Boolean).join(" ");
  if (!description) fail('usage: meetroom plan "<feature description>"  |  meetroom plan approve|discard <plan-id>');
  const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/plan`, { description });
  console.log(`draft plan ${data.plan.id} — ${data.plan.tasks.length} tasks (NOT live until approved):`);
  data.plan.tasks.forEach((t: { title: string; dependsOnIndex?: number[] }, i: number) => {
    console.log(`  ${i + 1}. ${t.title}${t.dependsOnIndex?.length ? ` (after step ${t.dependsOnIndex.map((x) => x + 1).join(", ")})` : ""}`);
  });
  console.log(`\napprove with: meetroom plan approve ${data.plan.id}`);
  console.log(`discard with: meetroom plan discard ${data.plan.id}`);
}

export function cmdRoles(): void {
  console.log("prebuilt roles (freehand roles are also allowed at join):\n");
  for (const r of listRoles()) {
    console.log(`${r.name}`);
    console.log(`  ${r.description}\n`);
  }
}

export async function cmdMemory(parsed: Parsed): Promise<void> {
  const ctx = requireContext(parsed.flags);
  const data = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/memory`);
  const m = data.memory;
  console.log(`project memory for ${m.projectPath} (.meetroom/memory.json — hand-editable)`);
  if (m.conventions.length) {
    console.log("\nconventions:");
    for (const c of m.conventions) console.log(`  - ${c}`);
  }
  console.log("\ndecisions:");
  if (!m.decisions.length) console.log("  (none yet — recorded at session end)");
  for (const d of m.decisions) console.log(`  - ${d.summary} (${d.date.slice(0, 10)}, ${d.sourceSessionId})`);
}

export async function cmdReputation(parsed: Parsed): Promise<void> {
  const ctx = requireContext(parsed.flags);
  const data = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/reputation`);
  if (!data.reputation.length) return console.log("no reputation data yet — stats accrue as tasks complete");
  console.log("agent reputation (informational only):\n");
  for (const r of data.reputation) {
    console.log(`${r.agentIdentity}: ${r.tasksCompleted} tasks · ${r.reviewPassRate}% clean review pass · avg rework ${r.avgReworkCount} · avg turnaround ${r.avgTurnaroundMinutes}m`);
  }
}

export async function cmdLeave(parsed: Parsed): Promise<void> {
  const ctx = requireContext(parsed.flags);
  const agentId = resolveAgentId(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/leave`, { agentId });
  console.log("left the room (your claims were released)");
}
