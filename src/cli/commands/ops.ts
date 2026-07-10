import { readFileSync } from "node:fs";
import type { Session, SessionTemplate } from "../../shared/types.js";
import { api, baseUrl, fail, requireContext, resolveAgentId, type Parsed, DEFAULT_PORT } from "../client.js";

// V4 CLI — agent runners, budgets, attention queue, artifacts, routines, templates.

export async function cmdAgent(parsed: Parsed): Promise<void> {
  const [sub, name] = parsed.positional;
  const ctx = requireContext(parsed.flags);

  if (sub === "spawn") {
    const command = parsed.flags.cmd as string;
    if (!name || !command) fail('usage: meetroom agent spawn <name> --cmd "<shell cmd>" [--restart never|on-crash|always] [--max-restarts N] [--cwd dir]');
    const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/runners`, {
      agentName: name,
      command,
      cwd: parsed.flags.cwd,
      restartPolicy: parsed.flags.restart,
      maxRestarts: parsed.flags["max-restarts"] ? Number(parsed.flags["max-restarts"]) : undefined,
    });
    console.log(`runner "${name}" started (pid ${data.runner.pid}) — logs: meetroom agent logs ${name}`);
    return;
  }
  if (sub === "stop" || sub === "restart") {
    if (!name) fail(`usage: meetroom agent ${sub} <name>`);
    await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/runners/${name}/stop`);
    if (sub === "restart") {
      const state = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
      const runner = (state.session as Session).runners.find((r) => r.agentName === name);
      if (!runner) fail(`no runner "${name}"`);
      await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/runners`, { agentName: name, command: runner!.command, restartPolicy: runner!.restartPolicy });
      console.log(`runner "${name}" restarted`);
    } else {
      console.log(`runner "${name}" stopped`);
    }
    return;
  }
  if (sub === "logs") {
    if (!name) fail("usage: meetroom agent logs <name>");
    const url = `${baseUrl(ctx)}/api/sessions/${ctx.sessionId}/runners/${name}/logs`;
    const res = await fetch(url, { headers: ctx.token ? { "x-meetroom-token": ctx.token } : {} });
    console.log(await res.text());
    return;
  }
  if (sub === "list" || sub === undefined) {
    const state = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
    const runners = (state.session as Session).runners;
    if (!runners.length) return console.log("no runners (spawn one with: meetroom agent spawn <name> --cmd \"...\")");
    for (const r of runners) console.log(`${r.agentName} [${r.state}]${r.pid ? ` pid ${r.pid}` : ""} restarts ${r.restarts}/${r.maxRestarts} — ${r.command}`);
    return;
  }
  fail(`unknown agent subcommand "${sub}" (spawn | stop | restart | logs | list)`);
}

export async function cmdBudget(parsed: Parsed): Promise<void> {
  const [sub] = parsed.positional;
  const ctx = requireContext(parsed.flags);
  if (sub === "set") {
    const agentName = parsed.flags.agent as string | undefined;
    let agentId: string | undefined;
    if (agentName) {
      const state = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
      agentId = (state.session as Session).agents.find((a) => a.name === agentName || a.id === agentName)?.id;
      if (!agentId) fail(`no agent "${agentName}" in the room`);
    }
    if (!parsed.flags["max-cost"] && !parsed.flags["max-tokens"]) fail("usage: meetroom budget set [--agent <name>] --max-cost USD | --max-tokens N [--on-breach pause-room|pause-agent|notify-only]");
    await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/budgets`, {
      scope: agentId ? "agent" : "session",
      agentId,
      maxCostUsd: parsed.flags["max-cost"] ? Number(parsed.flags["max-cost"]) : undefined,
      maxTokens: parsed.flags["max-tokens"] ? Number(parsed.flags["max-tokens"]) : undefined,
      onBreach: parsed.flags["on-breach"] ?? (agentId ? "pause-agent" : "pause-room"),
    });
    console.log("budget set — enforced as usage is reported");
    return;
  }
  if (sub === "show" || sub === undefined) {
    const state = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
    const s = state.session as Session;
    if (!s.budgets.length) return console.log("no budgets set");
    for (const b of s.budgets) {
      const who = b.scope === "agent" ? s.agents.find((a) => a.id === b.agentId)?.name ?? b.agentId : "session";
      const caps = [b.maxCostUsd !== undefined ? `$${b.maxCostUsd}` : null, b.maxTokens !== undefined ? `${b.maxTokens} tokens` : null].filter(Boolean).join(" / ");
      console.log(`${who}: max ${caps} → ${b.onBreach}${b.breachedAt ? ` [BREACHED ${b.breachedAt}]` : ""}`);
    }
    return;
  }
  fail(`unknown budget subcommand "${sub}" (set | show)`);
}

export async function cmdAttention(parsed: Parsed): Promise<void> {
  const [sub, id] = parsed.positional;
  const port = parsed.flags.port ? Number(parsed.flags.port) : Number(process.env.MEETROOM_PORT ?? DEFAULT_PORT);
  const host = (parsed.flags.host as string) ?? "127.0.0.1";
  const ctx = { host, port };

  if (sub === undefined || sub === "list") {
    const data = await api(ctx, "GET", "/api/attention");
    if (!data.items.length) return console.log("nothing needs you right now");
    for (const i of data.items) console.log(`${i.id} [${i.kind}] (${i.sessionId}) ${i.summary} — ${i.createdAt}`);
    return;
  }
  if (["ack", "done", "snooze", "reopen"].includes(sub)) {
    if (!id) fail(`usage: meetroom attention ${sub} <item-id>`);
    let snoozeUntil: string | undefined;
    if (sub === "snooze") {
      const until = (parsed.flags.until as string) ?? "2h";
      const m = until.match(/^(\d+)([hmd])$/);
      const ms = m ? Number(m[1]) * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000) : 2 * 3_600_000;
      snoozeUntil = new Date(Date.now() + ms).toISOString();
    }
    await api(ctx, "POST", `/api/attention/${id}`, { status: sub === "ack" ? "acked" : sub === "reopen" ? "open" : sub === "snooze" ? "snoozed" : "done", snoozeUntil });
    console.log(`attention item ${id}: ${sub}`);
    return;
  }
  fail(`unknown attention subcommand "${sub}" (list | ack | done | snooze [--until 2h] | reopen)`);
}

export async function cmdArtifact(parsed: Parsed): Promise<void> {
  const [sub, name] = parsed.positional;
  const ctx = requireContext(parsed.flags);

  if (sub === "write") {
    if (!name) fail('usage: meetroom artifact write <name> --file <path> | --content "..." [--expect-version N]');
    const content = parsed.flags.file ? readFileSync(parsed.flags.file as string, "utf8") : (parsed.flags.content as string);
    if (content === undefined) fail("provide --file <path> or --content \"...\"");
    const agentId = resolveAgentId(parsed.flags);
    const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/artifacts`, {
      name,
      content,
      agentId,
      expectedVersion: parsed.flags["expect-version"] ? Number(parsed.flags["expect-version"]) : undefined,
    });
    console.log(`artifact "${name}" written (version ${data.artifact.version})`);
    return;
  }
  if (sub === "read") {
    if (!name) fail("usage: meetroom artifact read <name>");
    const data = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/artifacts?name=${encodeURIComponent(name)}`);
    console.log(data.artifact.content);
    return;
  }
  if (sub === "list" || sub === undefined) {
    const data = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/artifacts`);
    if (!data.artifacts.length) return console.log("no artifacts");
    for (const a of data.artifacts) console.log(`${a.name} v${a.version} — last by ${a.updatedBy} at ${a.updatedAt}`);
    return;
  }
  fail(`unknown artifact subcommand "${sub}" (write | read | list)`);
}

export async function cmdRoutine(parsed: Parsed): Promise<void> {
  const [sub, arg] = parsed.positional;
  const port = parsed.flags.port ? Number(parsed.flags.port) : Number(process.env.MEETROOM_PORT ?? DEFAULT_PORT);
  const ctx = { host: (parsed.flags.host as string) ?? "127.0.0.1", port };

  if (sub === "create") {
    if (!arg || !parsed.flags.cron) fail('usage: meetroom routine create "<name>" --cron "0 2 * * *" [--template <name>] [--guild <name>]');
    const data = await api(ctx, "POST", "/api/routines", {
      name: arg,
      cron: parsed.flags.cron,
      cwd: process.cwd(),
      template: parsed.flags.template,
      guild: parsed.flags.guild,
    });
    console.log(`routine ${data.routine.id} created — fires on "${parsed.flags.cron}" in ${process.cwd()}`);
    return;
  }
  if (sub === "list" || sub === undefined) {
    const data = await api(ctx, "GET", "/api/routines");
    if (!data.routines.length) return console.log("no routines");
    for (const r of data.routines) console.log(`${r.id} "${r.name}" cron(${r.cron}) ${r.cwd}${r.template ? ` template:${r.template}` : ""}${r.enabled ? "" : " [disabled]"}${r.lastFiredAt ? ` last: ${r.lastFiredAt}` : ""}`);
    return;
  }
  if (sub === "delete") {
    if (!arg) fail("usage: meetroom routine delete <routine-id>");
    await api(ctx, "DELETE", `/api/routines/${arg}`);
    console.log("routine deleted");
    return;
  }
  fail(`unknown routine subcommand "${sub}" (create | list | delete)`);
}

/** Snapshot the current session's setup as a reusable blueprint (V4 #8). */
export async function cmdTemplate(parsed: Parsed): Promise<void> {
  const [sub, name] = parsed.positional;
  if (sub !== "save" || !name) fail('usage: meetroom template save <name> [--user]  (snapshots current session config/roster/budgets/notify)');
  const ctx = requireContext(parsed.flags);
  const state = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
  const s = state.session as Session;
  const template: SessionTemplate = {
    name,
    config: s.config,
    roster: s.agents.map((a) => ({ name: a.name, role: a.role, costTier: a.costTier, strengths: a.strengths })),
    budgets: s.budgets.map(({ breachedAt, ...b }) => b),
    notify: s.notify,
    runners: s.runners.map((r) => ({ agentName: r.agentName, command: r.command, restartPolicy: r.restartPolicy })),
  };
  const { saveTemplate } = await import("../../daemon/ops.js");
  const p = saveTemplate(process.cwd(), template, !!parsed.flags.user);
  console.log(`template saved: ${p}`);
  console.log(`start a room from it with: meetroom start --template ${name}`);
}
