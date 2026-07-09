import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttentionItem, ChatMessage, Session, SessionConfig, SessionType } from "../shared/types.js";
import { entityId, now, sessionId, sessionToken } from "../shared/ids.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function defaultDataDir(): string {
  return process.env.MEETROOM_DATA_DIR ?? join(PKG_ROOT, "data", "sessions");
}

export const DEFAULT_CONFIG: SessionConfig = {
  claimTimeoutMinutes: 10,
  objectionTimeoutMinutes: 5,
  requirePrMergeForDone: false,
  stallMinutes: 15,
};

/**
 * Source of truth for all session state. In-memory maps persisted as one JSON
 * file per session under data/sessions/. Emits "event" and "chat" so the
 * broadcast (SSE) and notification layers can fan out without the mutation
 * code knowing about transports.
 */
export class Registry extends EventEmitter {
  readonly sessions = new Map<string, Session>();
  readonly dataDir: string;

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
        // Migrate sessions persisted by older versions: fill fields added since.
        session.runners ??= [];
        session.budgets ??= [];
        session.artifacts ??= [];
        session.semanticClaims ??= [];
        session.integrations ??= [];
        session.config.stallMinutes ??= DEFAULT_CONFIG.stallMinutes;
        // Runner processes don't survive a daemon restart.
        for (const r of session.runners) if (r.state === "running" || r.state === "restarting") r.state = "stopped";
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
      runners: [],
      budgets: [],
      artifacts: [],
      semanticClaims: [],
      integrations: [],
      notify: { webhooks: [], events: ["escalation", "review-requested", "session-ended", "ci-failed", "budget-breached"] },
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

  /**
   * Append a timeline event, persist, and notify listeners. Each event is
   * hash-chained to the previous one (V6 #4) so `meetroom audit verify` can
   * detect any after-the-fact edit to the record.
   */
  event(session: Session, type: string, agentId?: string, data?: Record<string, unknown>): void {
    const prevHash = session.events.length ? session.events[session.events.length - 1].hash ?? "" : "genesis";
    const ev: Session["events"][number] = { ts: now(), type, agentId, data };
    ev.hash = createHash("sha256").update(prevHash + JSON.stringify([ev.ts, ev.type, ev.agentId ?? "", ev.data ?? {}])).digest("hex");
    session.events.push(ev);
    this.save(session);
    this.emit("event", session, ev);
  }

  /** Walk the event hash chain; returns the index of the first broken link, or -1. */
  static verifyAuditChain(session: Session): number {
    let prevHash = "genesis";
    for (let i = 0; i < session.events.length; i++) {
      const ev = session.events[i];
      const expected = createHash("sha256")
        .update(prevHash + JSON.stringify([ev.ts, ev.type, ev.agentId ?? "", ev.data ?? {}]))
        .digest("hex");
      if (ev.hash !== expected) return i;
      prevHash = ev.hash;
    }
    return -1;
  }

  // ---- attention queue (V4 #5): one cross-session inbox for the human -------

  private attentionPath(): string {
    return join(this.dataDir, "..", "attention.json");
  }

  listAttention(): AttentionItem[] {
    if (!existsSync(this.attentionPath())) return [];
    try {
      return JSON.parse(readFileSync(this.attentionPath(), "utf8")) as AttentionItem[];
    } catch {
      return [];
    }
  }

  saveAttention(items: AttentionItem[]): void {
    writeFileSync(this.attentionPath(), JSON.stringify(items, null, 2));
  }

  addAttention(sessionId: string, kind: AttentionItem["kind"], summary: string): AttentionItem {
    const items = this.listAttention();
    // Dedup: an identical open item shouldn't pile up on every sweep.
    const existing = items.find((i) => i.sessionId === sessionId && i.kind === kind && i.summary === summary && i.status === "open");
    if (existing) return existing;
    const item: AttentionItem = { id: entityId("attn"), sessionId, kind, summary, createdAt: now(), status: "open" };
    items.push(item);
    this.saveAttention(items);
    this.emit("attention", item);
    return item;
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
