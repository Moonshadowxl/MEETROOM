import type { ServerResponse } from "node:http";
import type { ChatMessage, Session, SessionEvent } from "../shared/types.js";
import type { Registry } from "./registry.js";

// Fan-out layer: Server-Sent Events keep the CLI dependency-light (plain
// HTTP, no websocket library) while still giving agents and the web viewer a
// live push stream. `meetroom listen` and the viewer both subscribe here.

type Subscriber = {
  res: ServerResponse;
  sessionId: string;
  agentId?: string; // when set, private messages to other agents are filtered out
};

const subscribers = new Set<Subscriber>();

export function subscribe(res: ServerResponse, sessionId: string, agentId?: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
  res.write(`: connected\n\n`);
  const sub: Subscriber = { res, sessionId, agentId };
  subscribers.add(sub);
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(`: ping\n\n`);
  }, 25_000);
  res.on("close", () => {
    clearInterval(ping);
    subscribers.delete(sub);
  });
}

function send(sub: Subscriber, event: string, data: unknown): void {
  if (sub.res.writableEnded) return;
  sub.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function wireBroadcast(reg: Registry): void {
  reg.on("chat", (session: Session, msg: ChatMessage) => {
    for (const sub of subscribers) {
      if (sub.sessionId !== session.id) continue;
      // Private messages (V2 #8) only reach sender, recipient, and the
      // human/viewer audit trail (subscribers with no agentId filter).
      if (msg.to && sub.agentId && sub.agentId !== msg.to && sub.agentId !== msg.agentId) continue;
      send(sub, "chat", msg);
    }
  });
  reg.on("event", (session: Session, ev: SessionEvent) => {
    for (const sub of subscribers) {
      if (sub.sessionId !== session.id) continue;
      send(sub, "event", ev);
    }
  });
}
