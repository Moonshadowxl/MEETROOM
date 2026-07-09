import { api, fail, requireContext, resolveAgentId, type Parsed } from "../client.js";

export async function cmdRelease(parsed: Parsed): Promise<void> {
  const filepath = parsed.positional[0];
  if (!filepath) fail("usage: meetroom release <filepath> [--as <agent-name>]");
  const ctx = requireContext(parsed.flags);
  const agentId = resolveAgentId(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/release`, { agentId, filepath });
  console.log(`released ${filepath}`);
}
