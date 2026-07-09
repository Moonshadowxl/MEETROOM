import type { Session } from "../shared/types.js";
import { activeMemoryNodes } from "./memory.js";
import { unmetDependencies } from "./tasks.js";
import { loadEpics } from "./evolve.js";

// V2 #5 — session replay / auto-brief. A structured summary for late joiners
// (and `meetroom brief` on demand) instead of a raw chat transcript.

export function generateBrief(session: Session): string {
  const lines: string[] = [];
  lines.push(`# Meetroom brief — session ${session.id}`);
  lines.push(`Project: ${session.cwd}`);
  lines.push(`Status: ${session.status} · started ${session.createdAt}`);
  if (session.guild) lines.push(`Guild: ${session.guild}`);
  lines.push("");

  lines.push("## Agents");
  if (session.agents.length === 0) lines.push("- (none joined yet)");
  for (const a of session.agents) {
    lines.push(`- ${a.name} (${a.role}, ${a.status})${a.costTier ? ` · tier: ${a.costTier}` : ""}`);
  }
  lines.push("");

  lines.push("## Task board");
  if (session.tasks.length === 0) lines.push("- (no tasks)");
  for (const t of session.tasks) {
    const assignee = t.assignedAgentId ? session.agents.find((a) => a.id === t.assignedAgentId)?.name ?? t.assignedAgentId : "unassigned";
    const unmet = t.status === "blocked" ? ` — blocked on ${unmetDependencies(session, t).join(", ")}` : "";
    lines.push(`- [${t.status}] ${t.id}: ${t.title} (${assignee})${unmet}`);
  }
  lines.push("");

  lines.push("## Active file claims");
  if (session.claims.length === 0) lines.push("- (none)");
  for (const c of session.claims) {
    const holder = session.agents.find((a) => a.id === c.agentId)?.name ?? c.agentId;
    const waiters = session.waitlists.find((w) => w.filepath === c.filepath)?.waitingAgentIds.length ?? 0;
    lines.push(`- ${c.filepath} → ${holder}${waiters ? ` (${waiters} waiting)` : ""}`);
  }
  lines.push("");

  const decided = session.proposals.filter((p) => p.status === "resolved");
  lines.push("## Decisions made this session");
  if (decided.length === 0) lines.push("- (none yet)");
  for (const p of decided) lines.push(`- ${p.content}`);
  lines.push("");

  const open = session.proposals.filter((p) => ["open", "contested", "voting", "escalated"].includes(p.status));
  lines.push("## Open / escalated items");
  if (open.length === 0) lines.push("- (none)");
  for (const p of open) lines.push(`- [${p.status}] ${p.id}: ${p.content}`);
  const pendingReviews = session.reviews.filter((r) => r.status === "pending");
  for (const r of pendingReviews) lines.push(`- [review pending] ${r.id} for task ${r.taskId}`);
  lines.push("");

  // V8 #8 — active epics orient every session toward the long-horizon goal.
  const epics = loadEpics(session.cwd).filter((e) => e.status === "active");
  if (epics.length) {
    lines.push("## Active epics");
    for (const e of epics) lines.push(`- ${e.id}: ${e.title} — ${e.northStar} (${e.taskRefs.length} tasks so far)`);
    lines.push("");
  }

  // V2 #6 / V5 #5-#6 — active memory (project + promoted global, superseded
  // nodes filtered) auto-loads into the brief.
  const nodes = activeMemoryNodes(session.cwd);
  if (nodes.length > 0) {
    lines.push("## Project memory (from previous sessions — query with `meetroom recall`)");
    for (const n of nodes.slice(-15)) lines.push(`- [${n.kind}] ${n.summary} (${n.date.slice(0, 10)})`);
    lines.push("");
  }

  return lines.join("\n");
}

/** V5 #8 — delta brief: what changed since a timestamp, for returning agents. */
export function generateDeltaBrief(session: Session, since: string): string {
  const lines: string[] = [];
  lines.push(`# Since ${since} — session ${session.id} (${session.status})`);
  const events = session.events.filter((e) => e.ts > since);
  const chat = session.chatLog.filter((m) => m.ts > since && !m.to);
  if (events.length === 0 && chat.length === 0) return lines.concat("", "Nothing happened. You're up to date.").join("\n");

  const interesting = events.filter((e) =>
    ["task-move", "task-created", "task-reassigned", "review-approved", "review-changes-requested", "proposal-resolved", "proposal-rejected", "escalation", "claim-timeout", "budget-breached", "agent-joined", "agent-disconnected", "session-paused", "session-resumed"].includes(e.type)
  );
  lines.push("", `## Events (${interesting.length} notable of ${events.length} total)`);
  for (const e of interesting.slice(-40)) {
    const who = e.agentId ? session.agents.find((a) => a.id === e.agentId)?.name ?? e.agentId : "";
    lines.push(`- ${e.ts.slice(11, 19)} ${e.type}${who ? ` (${who})` : ""}${e.data ? ` ${JSON.stringify(e.data)}` : ""}`);
  }
  lines.push("", `## Chat (${chat.length} messages)`);
  for (const m of chat.slice(-30)) {
    const who = session.agents.find((a) => a.id === m.agentId)?.name ?? m.agentId;
    lines.push(`- ${who}: ${m.message}`);
  }
  return lines.join("\n");
}
