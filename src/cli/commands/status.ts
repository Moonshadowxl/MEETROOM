import type { Session } from "../../shared/types.js";
import { api, requireContext, resolveAgentId, type Parsed, DEFAULT_PORT } from "../client.js";

export async function fetchState(parsed: Parsed): Promise<Session> {
  const ctx = requireContext(parsed.flags);
  const data = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
  return data.session as Session;
}

export async function cmdStatus(parsed: Parsed): Promise<void> {
  const s = await fetchState(parsed);
  console.log(`session ${s.id} — ${s.status}${s.forkedFrom ? ` (forked from ${s.forkedFrom})` : ""}`);
  console.log(`project: ${s.cwd}`);
  console.log("");
  console.log("agents:");
  if (!s.agents.length) console.log("  (none)");
  for (const a of s.agents) {
    console.log(`  ${a.name} — ${a.role} [${a.status}]${a.costTier ? ` tier:${a.costTier}` : ""}`);
  }
  console.log("");
  console.log("file claims:");
  if (!s.claims.length) console.log("  (none)");
  for (const c of s.claims) {
    const holder = s.agents.find((a) => a.id === c.agentId)?.name ?? c.agentId;
    const waiting = s.waitlists.find((w) => w.filepath === c.filepath)?.waitingAgentIds.length ?? 0;
    console.log(`  ${c.filepath} → ${holder} (${c.status}, since ${c.claimedAt})${waiting ? ` — ${waiting} waiting` : ""}`);
  }
  const open = s.proposals.filter((p) => ["open", "contested", "voting", "escalated"].includes(p.status));
  console.log("");
  console.log("open proposals:");
  if (!open.length) console.log("  (none)");
  for (const p of open) {
    const author = s.agents.find((a) => a.id === p.authorId)?.name ?? p.authorId;
    console.log(`  [${p.status}] ${p.id} by ${author}: ${p.content}`);
    for (const o of p.objections) {
      console.log(`      objection (${s.agents.find((a) => a.id === o.agentId)?.name ?? o.agentId}): ${o.reason}`);
    }
  }
  const pending = s.reviews.filter((r) => r.status === "pending");
  if (pending.length) {
    console.log("");
    console.log("pending reviews:");
    for (const r of pending) console.log(`  ${r.id} — task ${r.taskId}${r.authorConfidence ? ` (confidence: ${r.authorConfidence})` : ""}`);
  }
}

/** V2 #1 — print the kanban board. */
export async function cmdBoard(parsed: Parsed): Promise<void> {
  const s = await fetchState(parsed);
  const columns: Array<{ key: string; label: string }> = [
    { key: "todo", label: "TODO" },
    { key: "in-progress", label: "IN PROGRESS" },
    { key: "review", label: "REVIEW" },
    { key: "blocked", label: "BLOCKED" },
    { key: "done", label: "DONE" },
  ];
  if (s.tasks.some((t) => t.status === "cancelled")) columns.push({ key: "cancelled", label: "CANCELLED" });
  console.log(`task board — session ${s.id}${s.status === "paused" ? " (PAUSED)" : ""}`);
  for (const col of columns) {
    const tasks = s.tasks.filter((t) => t.status === col.key);
    console.log(`\n${col.label} (${tasks.length})`);
    for (const t of tasks) {
      const assignee = t.assignedAgentId ? s.agents.find((a) => a.id === t.assignedAgentId)?.name ?? t.assignedAgentId : "unassigned";
      const suggested =
        !t.assignedAgentId && t.suggestedAgentId
          ? ` → suggested: ${s.agents.find((a) => a.id === t.suggestedAgentId)?.name ?? t.suggestedAgentId}`
          : "";
      const gates = [t.requiresCI ? "CI" : null, t.requiresTests ? "tests" : null].filter(Boolean).join("+");
      console.log(`  ${t.id} ${t.title} [${assignee}]${t.estimatedComplexity ? ` (${t.estimatedComplexity})` : ""}${gates ? ` gates:${gates}` : ""}${suggested}`);
      if (t.dependsOn?.length) console.log(`      depends on: ${t.dependsOn.join(", ")}`);
    }
  }
}

export async function cmdBrief(parsed: Parsed): Promise<void> {
  const ctx = requireContext(parsed.flags);
  // V5 #8 — `brief --since <ts|last>`: the delta, not the world.
  let since = parsed.flags.since === true ? "last" : (parsed.flags.since as string | undefined);
  if (since === "last") {
    const agentId = resolveAgentId(parsed.flags);
    const state = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
    since = (state.session as Session).agents.find((a) => a.id === agentId)?.lastSeenAt;
  }
  const data = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/brief${since ? `?since=${encodeURIComponent(since)}` : ""}`);
  console.log(data.brief);
}

export async function cmdSessions(parsed: Parsed): Promise<void> {
  const port = parsed.flags.port ? Number(parsed.flags.port) : Number(process.env.MEETROOM_PORT ?? DEFAULT_PORT);
  const host = (parsed.flags.host as string) ?? "127.0.0.1";
  const data = await api({ host, port }, "GET", "/api/sessions");
  if (!data.sessions.length) return console.log("no sessions");
  for (const s of data.sessions) {
    console.log(`${s.id} [${s.status}] ${s.cwd} — ${s.agents} agents, ${s.tasks} tasks${s.forkedFrom ? ` (fork of ${s.forkedFrom})` : ""}`);
  }
}

/** Polling inbox for agents: new messages since a timestamp. */
export async function cmdInbox(parsed: Parsed): Promise<void> {
  const ctx = requireContext(parsed.flags);
  const agentId = resolveAgentId(parsed.flags);
  const since = (parsed.flags.since as string) ?? "";
  const data = await api(
    ctx,
    "GET",
    `/api/sessions/${ctx.sessionId}/messages?agentId=${encodeURIComponent(agentId)}${since ? `&since=${encodeURIComponent(since)}` : ""}`
  );
  if (data.paused) console.log("(room is paused)");
  for (const m of data.messages) {
    console.log(`${m.ts} ${m.agentId}${m.to ? ` → ${m.to} (private)` : ""}: ${m.message}`);
  }
}
