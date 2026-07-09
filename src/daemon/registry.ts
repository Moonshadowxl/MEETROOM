import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatMessage, Session, SessionConfig, SessionType } from "../shared/types.js";
import { now, sessionId, sessionToken } from "../shared/ids.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function defaultDataDir(): string {
  return process.env.MEETROOM_DATA_DIR ?? join(PKG_ROOT, "data", "sessions");
}

export const DEFAULT_CONFIG: SessionConfig = {
  claimTimeoutMinutes: 10,
  objectionTimeoutMinutes: 5,
  requirePrMergeForDone: false,
};

/**
 * Source of truth for all session state. In-memory maps persisted as one JSON
 * file per session under data/sessions/. Emits "event" and "chat" so the
 * broadcast (SSE) and notification layers can fan out without the mutation
 * code knowing about transports.
 */
export class Registry extends EventEmitter {
  readonly sessions = new Map<string, Session>();
  private readonly dataDir: string;

  constructor(dataDir = defaultDataDir()) {
    super();
    this.dataDir = dataDir;
    mkdirSync(this.dataDir, { recursive: true });
    this.loadAll();
  }

  private loadAll(): void {
    for (const f of readdirSync(this.dataDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const session = JSON.parse(readFileSync(join(this.dataDir, f), "utf8")) as Session;
        this.sessions.set(session.id, session);
      } catch {
        // Corrupt session file: skip rather than crash the daemon.
      }
    }
  }

  save(session: Session): void {
    writeFileSync(join(this.dataDir, `${session.id}.json`), JSON.stringify(session, null, 2));
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  createSession(opts: {
    type: SessionType;
    cwd: string;
    remote?: boolean;
    config?: Partial<SessionConfig>;
    baseCommit?: string;
    guild?: string;
    forkedFrom?: string;
  }): Session {
    let id = sessionId(opts.type);
    while (this.sessions.has(id)) id = sessionId(opts.type);
    const session: Session = {
      id,
      createdAt: now(),
      cwd: opts.cwd,
      status: "active",
      agents: [],
      claims: [],
      waitlists: [],
      proposals: [],
      tasks: [],
      reviews: [],
      ciStatuses: [],
      plugins: [],
      chatLog: [],
      events: [],
      usage: [],
      draftPlans: [],
      notify: { webhooks: [], events: ["escalation", "review-requested", "session-ended", "ci-failed"] },
      config: { ...DEFAULT_CONFIG, ...opts.config },
      remote: opts.remote ?? false,
      token: opts.remote ? sessionToken() : undefined,
      baseCommit: opts.baseCommit,
      guild: opts.guild,
      forkedFrom: opts.forkedFrom,
    };
    this.sessions.set(session.id, session);
    this.save(session);
    this.event(session, "session-created", undefined, { type: opts.type });
    return session;
  }

  /** Append a timeline event, persist, and notify listeners. */
  event(session: Session, type: string, agentId?: string, data?: Record<string, unknown>): void {
    const ev = { ts: now(), type, agentId, data };
    session.events.push(ev);
    this.save(session);
    this.emit("event", session, ev);
  }

  /** Append a chat message (optionally private via msg.to), persist, notify. */
  chat(session: Session, msg: Omit<ChatMessage, "ts">): ChatMessage {
    const full: ChatMessage = { ...msg, ts: now() };
    session.chatLog.push(full);
    this.save(session);
    this.emit("chat", session, full);
    return full;
  }

  /** System notice: goes to chat so agents polling the log see it. */
  notice(session: Session, message: string): void {
    this.chat(session, { agentId: "system", message });
  }
}
