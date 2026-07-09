import { api, fail, requireContext, resolveAgentId, type Parsed } from "../client.js";

export async function cmdRelease(parsed: Parsed): Promise<void> {
  const filepath = parsed.positional[0];
  if (!filepath) fail("usage: meetroom release <filepath> [--lines] [--as <agent-name>]");
  const ctx = requireContext(parsed.flags);
  const agentId = resolveAgentId(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/release`, { agentId, filepath, lines: !!parsed.flags.lines });
  console.log(`released ${filepath}${parsed.flags.lines ? " (line claims)" : ""}`);
}
