import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, Session, SessionType } from "../shared/types.js";
import { entityId, now } from "../shared/ids.js";
import { Registry } from "./registry.js";
import { claimFile, releaseFile, sweepClaimTimeouts, touchClaim } from "./fileClaims.js";
import { createProposal, objectToProposal, resolveProposal, sweepProposalTimeouts, voteOnProposal } from "./resolution.js";
import { claimTask, createTask, moveTask, reportCIStatus, reportTestResult } from "./tasks.js";
import { commentOnReview, decideReview, submitReview, syncPrStatus } from "./reviews.js";
import { subscribe, wireBroadcast } from "./broadcast.js";
import { wireNotifications } from "./notify.js";
import { generateBrief } from "./brief.js";
import { exportSession } from "./exporter.js";
import { distillSessionIntoMemory, loadMemory } from "./memory.js";
import { loadReputation } from "./reputation.js";
import { approvePlan, createDraftPlan, discardPlan } from "./plan.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DEFAULT_PORT = 7433;

type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  reg: Registry;
  body: any;
  params: Record<string, string>;
  query: URLSearchParams;
};

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(data));
}

function bad(res: ServerResponse, error: string, status = 400): void {
  json(res, status, { ok: false, error });
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Remote sessions require the session token for non-localhost callers (V2 #4). */
function authorized(req: IncomingMessage, session: Session): boolean {
  if (!session.token || isLoopback(req)) return true;
  const header = req.headers["x-meetroom-token"];
  return header === session.token;
}

// Mutations that represent *work* are gated while a room is paused (V2 #7).
// Chat, join, and status stay available so agents can see the paused state.
function ensureWritable(session: Session, res: ServerResponse): boolean {
  if (session.status === "paused") {
    bad(res, "room paused — no new claims or task moves until `meetroom resume`", 409);
    return false;
  }
  if (session.status === "ended") {
    bad(res, "session has ended", 410);
    return false;
  }
  return true;
}

function projectPluginsPath(cwd: string): string {
  return join(cwd, ".meetroom", "plugins.json");
}

function loadProjectPlugins(cwd: string): Plugin[] {
  const p = projectPluginsPath(cwd);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Plugin[];
  } catch {
    return [];
  }
}

function saveProjectPlugins(cwd: string, plugins: Plugin[]): void {
  mkdirSync(join(cwd, ".meetroom"), { recursive: true });
  writeFileSync(projectPluginsPath(cwd), JSON.stringify(plugins, null, 2));
}

type Route = {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: (ctx: Ctx) => void | Promise<void>;
  /** Routes that mutate work-state and must respect pause/ended gating. */
  gated?: boolean;
};

function route(method: string, path: string, handler: Route["handler"], gated = false): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path
        .split("/")
        .map((seg) => {
          if (seg.startsWith(":")) {
            keys.push(seg.slice(1));
            return "([^/]+)";
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/") +
      "$"
  );
  return { method, pattern, keys, handler, gated };
}

export function buildServer(reg: Registry) {
  wireBroadcast(reg);
  wireNotifications(reg);

  const withSession = (ctx: Ctx): Session | undefined => {
    const session = reg.get(ctx.params.id);
    if (!session) {
      bad(ctx.res, "no such session", 404);
      return undefined;
    }
    if (!authorized(ctx.req, session)) {
      bad(ctx.res, "invalid or missing session token (x-meetroom-token)", 401);
      return undefined;
    }
    return session;
  };

  const routes: Route[] = [
    route("GET", "/api/health", (c) => json(c.res, 200, { ok: true, service: "meetroom", version: "3.0.0", pid: process.pid })),

    route("GET", "/api/sessions", (c) => {
      const list = [...reg.sessions.values()].map((s) => ({
        id: s.id,
        cwd: s.cwd,
        status: s.status,
        createdAt: s.createdAt,
        agents: s.agents.length,
        tasks: s.tasks.length,
        forkedFrom: s.forkedFrom,
      }));
      json(c.res, 200, { ok: true, sessions: list });
    }),

    route("POST", "/api/sessions", (c) => {
      const { type, cwd, remote, config, guild, baseCommit, roster } = c.body;
      if (!["mmm", "sxx", "sxl"].includes(type)) return bad(c.res, "type must be one of mmm|sxx|sxl");
      if (!cwd) return bad(c.res, "cwd required");
      const session = reg.createSession({ type: type as SessionType, cwd, remote, config, guild, baseCommit });
      session.plugins.push(...loadProjectPlugins(cwd)); // project-scope plugins persist across sessions (V3 #1)
      // V3 #10 — guild roster pre-populates profiles; members flip to active
      // when they actually join.
      if (Array.isArray(roster)) {
        for (const m of roster) {
          if (!m?.name || !m?.role) continue;
          session.agents.push({
            id: entityId("agent"),
            name: m.name,
            role: m.role,
            costTier: m.costTier,
            strengths: m.strengths,
            identity: m.identity ?? m.name,
            status: "waiting",
            joinedAt: now(),
            lastSeenAt: now(),
          });
        }
      }
      reg.save(session);
      json(c.res, 201, { ok: true, session: { id: session.id, token: session.token } });
    }),

    route("GET", "/api/sessions/:id/state", (c) => {
      const s = withSession(c);
      if (s) json(c.res, 200, { ok: true, session: s });
    }),

    route("POST", "/api/sessions/:id/join", (c) => {
      const s = withSession(c);
      if (!s) return;
      if (s.status === "ended") return bad(c.res, "session has ended", 410);
      const { name, role, age, personality, vibe, costTier, strengths, identity } = c.body;
      if (!name || !role) return bad(c.res, "name and role required");
      let agent = s.agents.find((a) => a.name === name);
      if (agent) {
        agent.status = "active";
        agent.lastSeenAt = now();
        agent.role = role ?? agent.role;
      } else {
        agent = {
          id: entityId("agent"),
          name,
          role,
          age,
          personality,
          vibe,
          costTier,
          strengths,
          identity: identity ?? name,
          status: "active",
          joinedAt: now(),
          lastSeenAt: now(),
        };
        s.agents.push(agent);
      }
      reg.event(s, "agent-joined", agent.id, { name, role });
      reg.notice(s, `${name} joined as ${role}`);
      json(c.res, 200, { ok: true, agent, brief: generateBrief(s) }); // auto-brief on join (V2 #5)
    }),

    route("POST", "/api/sessions/:id/leave", (c) => {
      const s = withSession(c);
      if (!s) return;
      const agent = s.agents.find((a) => a.id === c.body.agentId);
      if (!agent) return bad(c.res, "no such agent", 404);
      agent.status = "disconnected";
      for (const claim of [...s.claims].filter((cl) => cl.agentId === agent.id)) {
        releaseFile(reg, s, agent.id, claim.filepath);
      }
      reg.event(s, "agent-left", agent.id, {});
      reg.notice(s, `${agent.name} left the room`);
      json(c.res, 200, { ok: true });
    }),

    route("POST", "/api/sessions/:id/say", (c) => {
      const s = withSession(c);
      if (!s) return;
      if (s.status === "ended") return bad(c.res, "session has ended", 410);
      const { agentId, message, to } = c.body;
      if (!agentId || !message) return bad(c.res, "agentId and message required");
      let toAgentId: string | undefined;
      if (to) {
        const target = s.agents.find((a) => a.name === to || a.id === to);
        if (!target) return bad(c.res, `no agent named "${to}" in the room`, 404);
        toAgentId = target.id;
      }
      const msg = reg.chat(s, { agentId, message, to: toAgentId });
      json(c.res, 200, { ok: true, message: msg });
    }),

    // Polling inbox for agents without a live SSE stream; private messages
    // are filtered to sender/recipient (the human sees everything).
    route("GET", "/api/sessions/:id/messages", (c) => {
      const s = withSession(c);
      if (!s) return;
      const since = c.query.get("since");
      const agentId = c.query.get("agentId");
      let msgs = s.chatLog;
      if (since) msgs = msgs.filter((m) => m.ts > since);
      if (agentId && agentId !== "human") {
        msgs = msgs.filter((m) => !m.to || m.to === agentId || m.agentId === agentId);
      }
      json(c.res, 200, { ok: true, messages: msgs, paused: s.status === "paused" });
    }),

    route("GET", "/api/sessions/:id/events", (c) => {
      const s = withSession(c);
      if (!s) return;
      subscribe(c.res, s.id, c.query.get("agentId") ?? undefined);
    }),

    // ---- file claims -----------------------------------------------------
    route(
      "POST",
      "/api/sessions/:id/claim",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res)) return;
        const { agentId, filepath, wait } = c.body;
        if (!agentId || !filepath) return bad(c.res, "agentId and filepath required");
        const result = claimFile(reg, s, agentId, filepath, !!wait);
        reg.save(s);
        json(c.res, result.ok ? 200 : 409, result);
      },
      true
    ),

    route(
      "POST",
      "/api/sessions/:id/release",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res)) return;
        const result = releaseFile(reg, s, c.body.agentId, c.body.filepath);
        reg.save(s);
        json(c.res, result.ok ? 200 : 409, result);
      },
      true
    ),

    route("POST", "/api/sessions/:id/touch", (c) => {
      const s = withSession(c);
      if (!s) return;
      const ok = touchClaim(s, c.body.agentId, c.body.filepath);
      reg.save(s);
      json(c.res, ok ? 200 : 404, { ok });
    }),

    // ---- proposals / voting ---------------------------------------------
    route(
      "POST",
      "/api/sessions/:id/propose",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res)) return;
        const { agentId, content } = c.body;
        if (!agentId || !content) return bad(c.res, "agentId and content required");
        const proposal = createProposal(reg, s, agentId, content);
        json(c.res, 201, { ok: true, proposal });
      },
      true
    ),

    route(
      "POST",
      "/api/sessions/:id/proposals/:pid/object",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res)) return;
        const result = objectToProposal(reg, s, c.params.pid, c.body.agentId, c.body.reason ?? "");
        json(c.res, result.ok ? 200 : 409, result);
      },
      true
    ),

    route(
      "POST",
      "/api/sessions/:id/proposals/:pid/resolve",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res)) return;
        const result = resolveProposal(reg, s, c.params.pid, c.body.agentId, c.body.response);
        json(c.res, result.ok ? 200 : 409, result);
      },
      true
    ),

    route(
      "POST",
      "/api/sessions/:id/proposals/:pid/vote",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res)) return;
        const result = voteOnProposal(reg, s, c.params.pid, c.body.agentId, c.body.vote);
        json(c.res, result.ok ? 200 : 409, result);
      },
      true
    ),

    // ---- tasks ------------------------------------------------------------
    route(
      "POST",
      "/api/sessions/:id/tasks",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res)) return;
        const { title, description, files, dependsOn, requiresCI, requiresTests } = c.body;
        if (!title) return bad(c.res, "title required");
        const result = createTask(reg, s, { title, description, files, dependsOn, requiresCI, requiresTests });
        json(c.res, result.ok ? 201 : 400, result);
      },
      true
    ),

    route(
      "POST",
      "/api/sessions/:id/tasks/:tid/claim",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res)) return;
        const result = claimTask(reg, s, c.params.tid, c.body.agentId);
        json(c.res, result.ok ? 200 : 409, result);
      },
      true
    ),

    route(
      "POST",
      "/api/sessions/:id/tasks/:tid/move",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res)) return;
        const result = moveTask(reg, s, c.params.tid, c.body.status, c.body.agentId);
        json(c.res, result.ok ? 200 : 409, result);
      },
      true
    ),

    route("POST", "/api/sessions/:id/tasks/:tid/tests", (c) => {
      const s = withSession(c);
      if (!s || !ensureWritable(s, c.res)) return;
      const result = reportTestResult(reg, s, c.params.tid, c.body.result, c.body.agentId);
      json(c.res, result.ok ? 200 : 404, result);
    }),

    // Generic CI webhook (V3 #3): any CI system that can POST a status works.
    route("POST", "/api/sessions/:id/tasks/:tid/ci", (c) => {
      const s = withSession(c);
      if (!s) return;
      const result = reportCIStatus(reg, s, c.params.tid, c.body.status, c.body.provider, c.body.url);
      json(c.res, result.ok ? 200 : 404, result);
    }),

    // ---- reviews -----------------------------------------------------------
    route(
      "POST",
      "/api/sessions/:id/reviews",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res)) return;
        const { taskId, authorAgentId, diff, authorConfidence, prUrl } = c.body;
        if (!taskId || !authorAgentId) return bad(c.res, "taskId and authorAgentId required");
        const result = submitReview(reg, s, { taskId, authorAgentId, diff: diff ?? "", authorConfidence, prUrl });
        json(c.res, result.ok ? 201 : 400, result);
      },
      true
    ),

    route(
      "POST",
      "/api/sessions/:id/reviews/:rid/decide",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res)) return;
        const result = decideReview(reg, s, c.params.rid, c.body.agentId, c.body.decision, c.body.comment);
        json(c.res, result.ok ? 200 : 409, result);
      },
      true
    ),

    route("POST", "/api/sessions/:id/reviews/:rid/comment", (c) => {
      const s = withSession(c);
      if (!s) return;
      const result = commentOnReview(reg, s, c.params.rid, c.body.agentId, c.body.text, c.body.line);
      json(c.res, result.ok ? 200 : 404, result);
    }),

    // PR review/merge sync endpoint (V3 #2) — point a GitHub/GitLab webhook
    // relay here, or report manually via `meetroom review pr-sync`.
    route("POST", "/api/sessions/:id/reviews/:rid/pr-sync", (c) => {
      const s = withSession(c);
      if (!s) return;
      const result = syncPrStatus(reg, s, c.params.rid, c.body.state);
      json(c.res, result.ok ? 200 : 404, result);
    }),

    // ---- plugins (V3 #1) ---------------------------------------------------
    route("POST", "/api/sessions/:id/plugins", (c) => {
      const s = withSession(c);
      if (!s || !ensureWritable(s, c.res)) return;
      const { name, command, installedBy, scope } = c.body;
      if (!name || !command) return bad(c.res, "name and command required");
      if (s.plugins.some((p) => p.name === name)) return bad(c.res, `plugin "${name}" already installed`, 409);
      const plugin: Plugin = { id: entityId("plug"), name, command, installedBy: installedBy ?? "human", scope: scope === "project" ? "project" : "session" };
      s.plugins.push(plugin);
      if (plugin.scope === "project") {
        const persisted = loadProjectPlugins(s.cwd).filter((p) => p.name !== name);
        persisted.push(plugin);
        saveProjectPlugins(s.cwd, persisted);
      }
      reg.event(s, "plugin-installed", installedBy, { name, scope: plugin.scope });
      json(c.res, 201, { ok: true, plugin });
    }),

    // ---- session lifecycle ---------------------------------------------------
    route("POST", "/api/sessions/:id/pause", (c) => {
      const s = withSession(c);
      if (!s) return;
      if (s.status !== "active") return bad(c.res, `session is ${s.status}`, 409);
      s.status = "paused";
      reg.event(s, "session-paused");
      reg.notice(s, "room PAUSED — claims and task moves are frozen until resume");
      json(c.res, 200, { ok: true });
    }),

    route("POST", "/api/sessions/:id/resume", (c) => {
      const s = withSession(c);
      if (!s) return;
      if (s.status !== "paused") return bad(c.res, `session is ${s.status}`, 409);
      s.status = "active";
      // Don't let every claim instantly time out after a long pause.
      for (const claim of s.claims) claim.lastActivityAt = now();
      reg.event(s, "session-resumed");
      reg.notice(s, "room RESUMED — pick up where you left off");
      json(c.res, 200, { ok: true });
    }),

    route("POST", "/api/sessions/:id/end", (c) => {
      const s = withSession(c);
      if (!s) return;
      if (s.status === "ended") return bad(c.res, "session already ended", 409);
      s.status = "ended";
      const memory = distillSessionIntoMemory(s); // V2 #6
      reg.event(s, "session-ended", undefined, { decisions: memory.decisions.length });
      json(c.res, 200, { ok: true, memory });
    }),

    // ---- fork (V3 #8) ---------------------------------------------------------
    route("POST", "/api/sessions/:id/fork", (c) => {
      const s = withSession(c);
      if (!s) return;
      const type = (s.id.split("-")[0] as SessionType) ?? "sxl";
      const fork = reg.createSession({ type, cwd: s.cwd, remote: s.remote, config: { ...s.config }, guild: s.guild, baseCommit: s.baseCommit, forkedFrom: s.id });
      fork.agents = structuredClone(s.agents);
      fork.tasks = structuredClone(s.tasks);
      fork.plugins = structuredClone(s.plugins);
      fork.notify = structuredClone(s.notify);
      reg.save(fork);
      reg.event(s, "session-forked", undefined, { forkId: fork.id });
      reg.notice(s, `session forked → ${fork.id} (parallel approaches; compare later, archive the loser)`);
      json(c.res, 201, { ok: true, fork: { id: fork.id, token: fork.token } });
    }),

    // ---- draft plans (V3 #13) ---------------------------------------------------
    route(
      "POST",
      "/api/sessions/:id/plan",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res)) return;
        if (!c.body.description) return bad(c.res, "description required");
        const plan = createDraftPlan(reg, s, c.body.description);
        json(c.res, 201, { ok: true, plan });
      },
      true
    ),

    route(
      "POST",
      "/api/sessions/:id/plan/:pid/approve",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res)) return;
        const result = approvePlan(reg, s, c.params.pid);
        json(c.res, result.ok ? 200 : 409, result);
      },
      true
    ),

    route("POST", "/api/sessions/:id/plan/:pid/discard", (c) => {
      const s = withSession(c);
      if (!s) return;
      const result = discardPlan(reg, s, c.params.pid);
      json(c.res, result.ok ? 200 : 404, result);
    }),

    // ---- misc -------------------------------------------------------------------
    route("POST", "/api/sessions/:id/usage", (c) => {
      const s = withSession(c);
      if (!s) return;
      const { agentId, tokensIn, tokensOut, costUsd } = c.body;
      if (!agentId) return bad(c.res, "agentId required");
      s.usage.push({ agentId, tokensIn: Number(tokensIn) || 0, tokensOut: Number(tokensOut) || 0, costUsd: Number(costUsd) || 0 });
      reg.save(s);
      json(c.res, 200, { ok: true });
    }),

    route("POST", "/api/sessions/:id/notify", (c) => {
      const s = withSession(c);
      if (!s) return;
      const { url, kind, events } = c.body;
      if (!url) return bad(c.res, "url required");
      s.notify.webhooks.push({ url, kind: kind === "slack" || kind === "discord" ? kind : "generic" });
      if (Array.isArray(events) && events.length) s.notify.events = events;
      reg.save(s);
      json(c.res, 200, { ok: true, notify: s.notify });
    }),

    route("GET", "/api/sessions/:id/brief", (c) => {
      const s = withSession(c);
      if (s) json(c.res, 200, { ok: true, brief: generateBrief(s) });
    }),

    route("GET", "/api/sessions/:id/export", (c) => {
      const s = withSession(c);
      if (!s) return;
      const format = c.query.get("format") === "json" ? "json" : "md";
      const body = exportSession(s, format);
      c.res.writeHead(200, { "content-type": format === "json" ? "application/json" : "text/markdown" });
      c.res.end(body);
    }),

    route("GET", "/api/sessions/:id/memory", (c) => {
      const s = withSession(c);
      if (s) json(c.res, 200, { ok: true, memory: loadMemory(s.cwd) });
    }),

    route("GET", "/api/sessions/:id/reputation", (c) => {
      const s = withSession(c);
      if (s) json(c.res, 200, { ok: true, reputation: loadReputation(s.cwd) });
    }),
  ];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type,x-meetroom-token",
        });
        return res.end();
      }

      // Web viewer static assets.
      if (req.method === "GET" && (path === "/" || path === "/index.html")) return serveStatic(res, "index.html", "text/html");
      if (req.method === "GET" && path === "/app.js") return serveStatic(res, "app.js", "text/javascript");
      if (req.method === "GET" && path === "/styles.css") return serveStatic(res, "styles.css", "text/css");

      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(path);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        const body = req.method === "GET" ? {} : await readBody(req);
        await r.handler({ req, res, reg, body, params, query: url.searchParams });
        return;
      }
      bad(res, "not found", 404);
    } catch (err) {
      bad(res, `internal error: ${(err as Error).message}`, 500);
    }
  });

  // V1 rule 2 + rule 3 timers: claim timeouts and proposal auto-resolution.
  const sweeper = setInterval(() => {
    for (const session of reg.sessions.values()) {
      sweepClaimTimeouts(reg, session);
      sweepProposalTimeouts(reg, session);
    }
  }, 30_000);
  sweeper.unref();

  return server;
}

function serveStatic(res: ServerResponse, file: string, type: string): void {
  const p = join(PKG_ROOT, "src", "web", file);
  if (!existsSync(p)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(p));
}

export function daemonInfoPath(): string {
  return join(PKG_ROOT, "data", "daemon.json");
}

// Entry point: `node dist/src/daemon/server.js [--port N] [--bind HOST]`
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf("--port");
  const bindIdx = args.indexOf("--bind");
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : Number(process.env.MEETROOM_PORT ?? DEFAULT_PORT);
  // Localhost-only by default; `meetroom start --remote` binds all interfaces (V2 #4).
  const bind = bindIdx >= 0 ? args[bindIdx + 1] : process.env.MEETROOM_BIND ?? "127.0.0.1";
  const reg = new Registry();
  const server = buildServer(reg);
  server.listen(port, bind, () => {
    mkdirSync(dirname(daemonInfoPath()), { recursive: true });
    writeFileSync(daemonInfoPath(), JSON.stringify({ port, bind, pid: process.pid, startedAt: now() }, null, 2));
    console.log(`meetroom daemon listening on http://${bind}:${port}`);
  });
}
