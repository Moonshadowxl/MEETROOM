import { api, fail, requireContext, resolveAgentId, type Parsed } from "../client.js";

export async function cmdPropose(parsed: Parsed): Promise<void> {
  const content = parsed.positional.join(" ");
  if (!content) fail('usage: meetroom propose "<plan>" [--as <agent-name>]');
  const ctx = requireContext(parsed.flags);
  const agentId = resolveAgentId(parsed.flags);
  const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/propose`, { agentId, content });
  console.log(`proposal ${data.proposal.id} created — auto-resolves if nobody objects within the objection window`);
}

export async function cmdObject(parsed: Parsed): Promise<void> {
  const [proposalId, ...rest] = parsed.positional;
  const reason = rest.join(" ");
  if (!proposalId || !reason) fail('usage: meetroom object <proposal-id> "<reason>"');
  const ctx = requireContext(parsed.flags);
  const agentId = resolveAgentId(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/proposals/${proposalId}/object`, { agentId, reason });
  console.log(`objection recorded on ${proposalId}`);
}

export async function cmdResolve(parsed: Parsed): Promise<void> {
  const [proposalId, ...rest] = parsed.positional;
  if (!proposalId) fail('usage: meetroom resolve <proposal-id> ["response to objections"]');
  const ctx = requireContext(parsed.flags);
  const agentId = resolveAgentId(parsed.flags);
  const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/proposals/${proposalId}/resolve`, {
    agentId,
    response: rest.join(" ") || undefined,
  });
  console.log(`proposal ${proposalId} is now: ${data.status}`);
}

/** V2 #9 — voting. */
export async function cmdVote(parsed: Parsed): Promise<void> {
  const [proposalId, vote] = parsed.positional;
  if (!proposalId || !["yes", "no"].includes(vote)) fail("usage: meetroom vote <proposal-id> yes|no");
  const ctx = requireContext(parsed.flags);
  const agentId = resolveAgentId(parsed.flags);
  const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/proposals/${proposalId}/vote`, { agentId, vote });
  console.log(`vote recorded — proposal is now: ${data.status}`);
}
