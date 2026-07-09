import { api, fail, requireContext, resolveAgentId, type Parsed } from "../client.js";

export async function cmdSay(parsed: Parsed): Promise<void> {
  const message = parsed.positional.join(" ");
  if (!message) fail('usage: meetroom say "<message>" [--as <agent-name>]');
  const ctx = requireContext(parsed.flags);
  const agentId = resolveAgentId(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/say`, { agentId, message });
  console.log("sent");
}

/** Human broadcast to every agent in the room (V1) — logged to shared chat. */
export async function cmdPromptAll(parsed: Parsed): Promise<void> {
  const message = parsed.positional.join(" ");
  if (!message) fail('usage: meetroom prompt-all "<message>"');
  const ctx = requireContext(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/say`, { agentId: "human", message });
  console.log("broadcast sent to the room");
}

/**
 * V2 #8 — selective broadcast: `meetroom prompt @<agent> "<msg>"` goes to one
 * agent privately (still logged for the human's audit trail).
 */
export async function cmdPrompt(parsed: Parsed): Promise<void> {
  const [target, ...rest] = parsed.positional;
  const message = rest.join(" ");
  if (!target?.startsWith("@") || !message) {
    fail('usage: meetroom prompt @<agent-name> "<message>"   (or use prompt-all for a broadcast)');
  }
  const ctx = requireContext(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/say`, {
    agentId: "human",
    message,
    to: target.slice(1),
  });
  console.log(`private message sent to ${target.slice(1)}`);
}
