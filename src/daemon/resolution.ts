import type { Proposal, Session } from "../shared/types.js";
import { entityId, now } from "../shared/ids.js";
import type { Registry } from "./registry.js";

// Propose → object → resolve → escalate (V1 rule 3), plus voting (V2 #9).
//
// Lifecycle:
//   open        — accepting objections; auto-resolves after the objection
//                 timeout if nobody objects
//   contested   — has objections; the author gets one response round
//   voting      — 3+ active agents: contested proposals go to a vote instead
//                 of straight to the human
//   resolved / rejected / escalated — terminal

export function createProposal(reg: Registry, session: Session, authorId: string, content: string): Proposal {
  const proposal: Proposal = {
    id: entityId("prop"),
    authorId,
    content,
    objections: [],
    status: "open",
    createdAt: now(),
  };
  session.proposals.push(proposal);
  reg.event(session, "proposal-created", authorId, { proposalId: proposal.id });
  reg.chat(session, { agentId: authorId, message: `[proposal ${proposal.id}] ${content}` });
  return proposal;
}

export function objectToProposal(
  reg: Registry,
  session: Session,
  proposalId: string,
  agentId: string,
  reason: string
): { ok: boolean; error?: string } {
  const p = session.proposals.find((x) => x.id === proposalId);
  if (!p) return { ok: false, error: "no such proposal" };
  if (p.status !== "open" && p.status !== "contested") return { ok: false, error: `proposal is ${p.status}` };
  if (p.authorId === agentId) return { ok: false, error: "cannot object to your own proposal" };
  p.objections.push({ agentId, reason, ts: now() });
  // Objecting after the author already used their one response round means no
  // consensus: escalate or vote — no endless back-and-forth (V1 rule 3).
  if (p.authorResponse !== undefined) {
    concludeContested(reg, session, p);
  } else {
    p.status = "contested";
  }
  reg.event(session, "proposal-objection", agentId, { proposalId, reason });
  reg.chat(session, { agentId, message: `[objection to ${proposalId}] ${reason}` });
  return { ok: true };
}

/**
 * Author resolves: clean proposals resolve immediately; contested ones record
 * the author's single response and either go to a vote (3+ active agents) or
 * escalate to the human.
 */
export function resolveProposal(
  reg: Registry,
  session: Session,
  proposalId: string,
  agentId: string,
  response?: string
): { ok: boolean; status?: Proposal["status"]; error?: string } {
  const p = session.proposals.find((x) => x.id === proposalId);
  if (!p) return { ok: false, error: "no such proposal" };
  if (agentId !== "human" && p.authorId !== agentId) return { ok: false, error: "only the author (or the human) can resolve" };
  if (p.status === "resolved" || p.status === "rejected") return { ok: false, error: `proposal already ${p.status}` };
  // Once a proposal is in voting or escalated, the author is out of moves:
  // re-resolving would wipe votes / undo the escalation. Only the human decides.
  if (agentId !== "human" && (p.status === "voting" || p.status === "escalated")) {
    return { ok: false, error: `proposal is ${p.status} — only the human can resolve it now` };
  }

  if (agentId === "human" || p.objections.length === 0) {
    finishProposal(reg, session, p, "resolved");
    return { ok: true, status: p.status };
  }
  p.authorResponse = response ?? "(no response)";
  reg.chat(session, { agentId, message: `[response on ${proposalId}] ${p.authorResponse}` });
  concludeContested(reg, session, p);
  return { ok: true, status: p.status };
}

/**
 * Reject a proposal outright. The human can reject any non-terminal proposal
 * (the missing half of force-resolve); the author can reject their own
 * proposal to withdraw it, but only before it reaches voting/escalated.
 */
export function rejectProposal(
  reg: Registry,
  session: Session,
  proposalId: string,
  agentId: string,
  reason?: string
): { ok: boolean; status?: Proposal["status"]; error?: string } {
  const p = session.proposals.find((x) => x.id === proposalId);
  if (!p) return { ok: false, error: "no such proposal" };
  if (p.status === "resolved" || p.status === "rejected") return { ok: false, error: `proposal already ${p.status}` };
  if (agentId !== "human") {
    if (p.authorId !== agentId) return { ok: false, error: "only the author (withdraw) or the human can reject" };
    if (p.status === "voting" || p.status === "escalated") {
      return { ok: false, error: `proposal is ${p.status} — only the human can reject it now` };
    }
  }
  if (reason) reg.chat(session, { agentId, message: `[rejecting ${p.id}] ${reason}` });
  finishProposal(reg, session, p, "rejected");
  return { ok: true, status: p.status };
}

function activeAgents(session: Session) {
  return session.agents.filter((a) => a.status === "active" || a.status === "waiting" || a.status === "idle");
}

function concludeContested(reg: Registry, session: Session, p: Proposal): void {
  if (activeAgents(session).length >= 3) {
    p.status = "voting";
    p.votes = [];
    reg.event(session, "proposal-voting", p.authorId, { proposalId: p.id });
    reg.notice(session, `proposal ${p.id} is now open for voting (meetroom vote ${p.id} yes|no)`);
  } else {
    escalate(reg, session, p);
  }
}

export function voteOnProposal(
  reg: Registry,
  session: Session,
  proposalId: string,
  agentId: string,
  vote: "yes" | "no"
): { ok: boolean; status?: Proposal["status"]; error?: string } {
  const p = session.proposals.find((x) => x.id === proposalId);
  if (!p) return { ok: false, error: "no such proposal" };
  if (p.status !== "voting") return { ok: false, error: `proposal is ${p.status}, not voting` };
  p.votes = p.votes ?? [];
  const existing = p.votes.find((v) => v.agentId === agentId);
  if (existing) existing.vote = vote;
  else p.votes.push({ agentId, vote });
  reg.event(session, "proposal-vote", agentId, { proposalId, vote });

  const eligible = activeAgents(session).length;
  if (p.votes.length >= eligible) tallyVotes(reg, session, p);
  else reg.save(session);
  return { ok: true, status: p.status };
}

export function tallyVotes(reg: Registry, session: Session, p: Proposal): void {
  const votes = p.votes ?? [];
  let yes = votes.filter((v) => v.vote === "yes").length;
  let no = votes.filter((v) => v.vote === "no").length;
  if (yes === no && session.config.leadAgentId) {
    // Rotating lead gets tie-break weight instead of a full escalation.
    const leadVote = votes.find((v) => v.agentId === session.config.leadAgentId);
    if (leadVote) leadVote.vote === "yes" ? yes++ : no++;
  }
  if (yes > no) finishProposal(reg, session, p, "resolved");
  else if (no > yes) finishProposal(reg, session, p, "rejected");
  else escalate(reg, session, p); // tie → human (V1 behavior as fallback)
}

function finishProposal(reg: Registry, session: Session, p: Proposal, status: "resolved" | "rejected"): void {
  p.status = status;
  p.resolvedAt = now();
  reg.event(session, `proposal-${status}`, p.authorId, { proposalId: p.id });
  reg.notice(session, `proposal ${p.id} ${status}`);
}

function escalate(reg: Registry, session: Session, p: Proposal): void {
  p.status = "escalated";
  reg.event(session, "escalation", p.authorId, { proposalId: p.id, content: p.content });
  reg.notice(session, `proposal ${p.id} ESCALATED to human — no consensus`);
}

/** Auto-resolve open proposals nobody objected to within the window (V1 rule 3). */
export function sweepProposalTimeouts(reg: Registry, session: Session): void {
  if (session.status !== "active") return;
  const cutoff = Date.now() - session.config.objectionTimeoutMinutes * 60_000;
  for (const p of session.proposals) {
    if (p.status === "open" && p.objections.length === 0 && new Date(p.createdAt).getTime() < cutoff) {
      finishProposal(reg, session, p, "resolved");
    }
  }
}
