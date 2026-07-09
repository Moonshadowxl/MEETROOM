import { api, fail, requireContext, resolveAgentId, type Parsed } from "../client.js";

export async function cmdClaim(parsed: Parsed): Promise<void> {
  const filepath = parsed.positional[0];
  if (!filepath) fail("usage: meetroom claim <filepath> [--wait] [--lines A-B] [--timeout M] [--as <agent-name>]");
  const ctx = requireContext(parsed.flags);
  const agentId = resolveAgentId(parsed.flags);
  const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/claim`, {
    agentId,
    filepath,
    wait: !!parsed.flags.wait, // V2 #2 — queue FIFO instead of hard-rejecting
    lines: parsed.flags.lines, // V5 #1 — line-range claim
    timeoutMinutes: parsed.flags.timeout, // V5 #7 — explicit override
  });
  if (data.granted) {
    console.log(`claimed ${filepath}${parsed.flags.lines ? `:${parsed.flags.lines}` : ""}`);
  } else {
    console.log(`queued for ${filepath} (position ${data.position}) — you'll be granted it when the holder releases`);
  }
  // V5 #5 — memory that mentions this file, delivered when it matters.
  for (const m of data.relatedMemory ?? []) console.log(`  relevant memory: ${m}`);
}

/** Mark activity on a claim so it doesn't hit the idle timeout. */
export async function cmdTouch(parsed: Parsed): Promise<void> {
  const filepath = parsed.positional[0];
  if (!filepath) fail("usage: meetroom touch <filepath>");
  const ctx = requireContext(parsed.flags);
  const agentId = resolveAgentId(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/touch`, { agentId, filepath });
  console.log(`activity recorded on ${filepath}`);
}
