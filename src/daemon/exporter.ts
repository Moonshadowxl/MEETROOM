import type { Session } from "../shared/types.js";

// V2 #10 — exportable session log: a clean, shareable record of what
// happened (decisions, tasks, reviews, timing, per-agent cost).

export function exportSession(session: Session, format: "md" | "json"): string {
  if (format === "json") {
    return JSON.stringify(buildReport(session), null, 2);
  }
  return renderMarkdown(session);
}

function buildReport(session: Session) {
  return {
    session: { id: session.id, cwd: session.cwd, createdAt: session.createdAt, status: session.status },
    agents: session.agents.map((a) => ({ id: a.id, name: a.name, role: a.role, identity: a.identity })),
    decisions: session.proposals.filter((p) => p.status === "resolved").map((p) => p.content),
    escalations: session.proposals.filter((p) => p.status === "escalated").map((p) => p.content),
    tasks: session.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      assignee: agentName(session, t.assignedAgentId),
      claimedAt: t.claimedAt,
      doneAt: t.doneAt,
      turnaroundMinutes: turnaround(t.claimedAt, t.doneAt),
    })),
    reviews: session.reviews.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      author: agentName(session, r.authorAgentId),
      reviewer: agentName(session, r.reviewerAgentId),
      status: r.status,
      confidence: r.authorConfidence,
      turnaroundMinutes: turnaround(r.createdAt, r.updatedAt),
      prUrl: r.prUrl,
    })),
    usage: session.usage,
    timeline: session.events,
  };
}

function renderMarkdown(session: Session): string {
  const r = buildReport(session);
  const lines: string[] = [];
  lines.push(`# Meetroom session report — ${session.id}`);
  lines.push(`Project: ${session.cwd} · started ${session.createdAt} · status: ${session.status}`);
  lines.push("");
  lines.push("## Agents");
  for (const a of r.agents) lines.push(`- ${a.name} — ${a.role}`);
  lines.push("");
  lines.push("## Decisions");
  lines.push(...(r.decisions.length ? r.decisions.map((d) => `- ${d}`) : ["- (none)"]));
  if (r.escalations.length) {
    lines.push("", "## Escalated (unresolved)");
    lines.push(...r.escalations.map((d) => `- ${d}`));
  }
  lines.push("", "## Tasks");
  lines.push("| Task | Status | Assignee | Turnaround (min) |");
  lines.push("|---|---|---|---|");
  for (const t of r.tasks) lines.push(`| ${t.title} | ${t.status} | ${t.assignee} | ${t.turnaroundMinutes ?? "—"} |`);
  lines.push("", "## Reviews");
  lines.push("| Review | Task | Author | Reviewer | Status | Turnaround (min) |");
  lines.push("|---|---|---|---|---|---|");
  for (const v of r.reviews) {
    lines.push(`| ${v.id} | ${v.taskId} | ${v.author} | ${v.reviewer} | ${v.status} | ${v.turnaroundMinutes ?? "—"} |`);
  }
  // Per-agent cost summary (V2 #10): who's pulling their weight vs burning budget.
  lines.push("", "## Usage / cost per agent");
  lines.push("| Agent | Tokens in | Tokens out | Est. cost (USD) |");
  lines.push("|---|---|---|---|");
  for (const u of aggregateUsage(session)) {
    lines.push(`| ${agentName(session, u.agentId)} | ${u.tokensIn} | ${u.tokensOut} | ${u.costUsd.toFixed(4)} |`);
  }
  lines.push("", "## Timeline");
  for (const e of session.events) {
    const who = e.agentId ? ` [${agentName(session, e.agentId)}]` : "";
    lines.push(`- ${e.ts} — ${e.type}${who}${e.data ? ` ${JSON.stringify(e.data)}` : ""}`);
  }
  return lines.join("\n");
}

export function aggregateUsage(session: Session) {
  const byAgent = new Map<string, { agentId: string; tokensIn: number; tokensOut: number; costUsd: number }>();
  for (const u of session.usage) {
    const agg = byAgent.get(u.agentId) ?? { agentId: u.agentId, tokensIn: 0, tokensOut: 0, costUsd: 0 };
    agg.tokensIn += u.tokensIn;
    agg.tokensOut += u.tokensOut;
    agg.costUsd += u.costUsd;
    byAgent.set(u.agentId, agg);
  }
  return [...byAgent.values()];
}

function agentName(session: Session, agentId?: string): string {
  if (!agentId) return "—";
  return session.agents.find((a) => a.id === agentId)?.name ?? agentId;
}

function turnaround(from?: string, to?: string): number | undefined {
  if (!from || !to) return undefined;
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000);
}
