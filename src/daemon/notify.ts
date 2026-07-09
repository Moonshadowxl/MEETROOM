import type { Session, SessionEvent } from "../shared/types.js";
import type { Registry } from "./registry.js";

// V2 #4 webhook notifications + V3 #11 Slack/Discord adapters. Escalations,
// review requests, CI failures, and session-complete events reach the human
// wherever they actually are.

export function wireNotifications(reg: Registry): void {
  reg.on("event", (session: Session, ev: SessionEvent) => {
    if (!session.notify.webhooks.length) return;
    if (!session.notify.events.includes(ev.type)) return;
    const text = formatEvent(session, ev);
    for (const hook of session.notify.webhooks) {
      void post(hook.url, payloadFor(hook.kind, session, ev, text));
    }
  });
}

function formatEvent(session: Session, ev: SessionEvent): string {
  const who = ev.agentId ? session.agents.find((a) => a.id === ev.agentId)?.name ?? ev.agentId : "";
  const detail = ev.data ? ` ${JSON.stringify(ev.data)}` : "";
  return `[meetroom ${session.id}] ${ev.type}${who ? ` (${who})` : ""}${detail}`;
}

function payloadFor(kind: "generic" | "slack" | "discord", session: Session, ev: SessionEvent, text: string): unknown {
  switch (kind) {
    case "slack":
      return { text };
    case "discord":
      return { content: text };
    default:
      return { sessionId: session.id, event: ev, text };
  }
}

async function post(url: string, body: unknown): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Notification failures must never take down the room.
  }
}
