import type { Session } from "../shared/types.js";
import { loadMemory } from "./memory.js";
import { unmetDependencies } from "./tasks.js";

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

  // V2 #6 — project memory auto-loads into the brief.
  const memory = loadMemory(session.cwd);
  if (memory.decisions.length > 0 || memory.conventions.length > 0) {
    lines.push("## Project memory (from previous sessions)");
    for (const c of memory.conventions) lines.push(`- convention: ${c}`);
    for (const d of memory.decisions.slice(-15)) lines.push(`- ${d.summary} (${d.date.slice(0, 10)})`);
    lines.push("");
  }

  return lines.join("\n");
}
