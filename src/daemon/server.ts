import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, Session, SessionType } from "../shared/types.js";
import { entityId, now } from "../shared/ids.js";
import { Registry } from "./registry.js";
import { claimFile, claimLines, releaseAgentPresence, releaseFile, releaseLines, sweepClaimTimeouts, touchClaim } from "./fileClaims.js";
import { createProposal, objectToProposal, rejectProposal, resolveProposal, sweepProposalTimeouts, voteOnProposal } from "./resolution.js";
import { assignTask, cancelTask, claimTask, createTask, editTask, moveTask, reportCIStatus, reportTestResult } from "./tasks.js";
import { commentOnReview, decideReview, submitReview, syncPrStatus } from "./reviews.js";
import { subscribe, wireBroadcast } from "./broadcast.js";
import { wireNotifications } from "./notify.js";
import { generateBrief, generateDeltaBrief } from "./brief.js";
import { exportSession } from "./exporter.js";
import { distillSessionIntoMemory, loadMemory, memoryForFile, promoteMemoryNode, recallMemory } from "./memory.js";
import { loadReputation } from "./reputation.js";
import { approvePlan, createDraftPlan, discardPlan } from "./plan.js";
import {
  inviteOperator,
  loadOperators,
  loadPolicy,
  operatorAllowed,
  policyViolations,
  purgeSession,
  rulesForTask,
  saveOperators,
  type OperatorRole,
} from "./trust.js";
import {
  agentActionAllowed,
  createEpic,
  epicStatus,
  generateRetro,
  loadEpics,
  queueAction,
  saveRetro,
  simulatePlan,
  sweepMetaAgent,
  sweepPendingActions,
  sweepSelfHealing,
  vetoAction,
} from "./evolve.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  agentBudgetBlocked,
  checkBudgets,
  cronMatches,
  heartbeat,
  isSafeRunnerName,
  loadRoutines,
  loadTemplate,
  runnerLogPath,
  saveRoutines,
  setBudget,
  spawnRunner,
  stopAllRunners,
  stopRunner,
  sweepEscalations,
  sweepLiveness,
  writeArtifact,
} from "./ops.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DEFAULT_PORT = 7433;

// Accepted inbound-integration signatures, kept until their freshness window
// closes (replay protection): key `${sessionId}:${signature}` → expiry epoch ms.
const seenInboundSignatures = new Map<string, number>();

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

/** Returns the parsed body, {} for an empty body, or undefined for malformed JSON. */
async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return undefined; // caller answers 400 instead of silently acting on {}
  }
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Remote sessions require the session token for non-localhost callers (V2 #4). */
export function authorized(req: IncomingMessage, session: Session): boolean {
  if (!session.token || isLoopback(req)) return true;
  const header = req.headers["x-meetroom-token"];
  if (header === session.token) return true;
  // EventSource cannot set request headers, so the SSE stream (and any other
  // GET) may pass the token as a query parameter instead.
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("token") === session.token;
}

// Mutations that represent *work* are gated while a room is paused (V2 #7).
// Chat, join, and status stay available so agents can see the paused state.
function ensureWritable(session: Session, res: ServerResponse, agentId?: string, discussionOnly = false): boolean {
  if (session.status === "paused") {
    bad(res, "room paused — no new claims or task moves until `meetroom resume`", 409);
    return false;
  }
  if (session.status === "ended") {
    bad(res, "session has ended", 410);
    return false;
  }
  // V4 #2 — an agent past its budget cap can talk but not take new work.
  if (agentId && agentBudgetBlocked(session, agentId)) {
    bad(res, "your budget is exhausted — a human must raise it (`meetroom budget set`) before you take new work", 402);
    return false;
  }
  // V8 #1 — at autonomy L0, agents observe and discuss (propose/object/vote)
  // but don't act on work (claims, tasks, reviews).
  if (!discussionOnly) {
    const autonomy = agentActionAllowed(session, agentId);
    if (!autonomy.ok) {
      bad(res, autonomy.error!, 403);
      return false;
    }
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
  path: string; // original template, e.g. /api/sessions/:id/claim
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
  return { method, path, pattern, keys, handler, gated };
}

export function buildServer(reg: Registry) {
  wireBroadcast(reg);
  wireNotifications(reg);

  // V6 #1 — privileged actions need an operator key of sufficient role, but
  // only once operators have been configured (solo mode stays frictionless).
  const requireOperator = (ctx: Ctx, minRole: OperatorRole): boolean => {
    const key = ctx.req.headers["x-meetroom-operator"] as string | undefined;
    const check = operatorAllowed(reg.dataDir, key, minRole);
    if (!check.ok) {
      bad(ctx.res, check.error!, 403);
      return false;
    }
    return true;
  };

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

    // Graceful daemon shutdown (`meetroom stop`): stop every runner, persist,
    // then exit. Operator-gated once operators exist; solo mode just works.
    route("POST", "/api/shutdown", (c) => {
      if (!requireOperator(c, "maintainer")) return;
      json(c.res, 200, { ok: true, stopping: true, pid: process.pid });
      setTimeout(() => {
        for (const s of reg.sessions.values()) {
          stopAllRunners(reg, s);
          reg.save(s);
        }
        try {
          rmSync(daemonInfoPath(), { force: true });
        } catch {
          // best-effort cleanup
        }
        process.exit(0);
      }, 150).unref();
    }),

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
      const { type, cwd, remote, config, guild, baseCommit, template } = c.body;
      let { roster } = c.body;
      if (!["mmm", "sxx", "sxl"].includes(type)) return bad(c.res, "type must be one of mmm|sxx|sxl");
      if (!cwd) return bad(c.res, "cwd required");
      // V4 #8 — templates bundle config + roster + budgets + notify + a draft plan.
      let tpl;
      if (template) {
        tpl = loadTemplate(cwd, template);
        if (!tpl) return bad(c.res, `no template "${template}" in .meetroom/templates/ or ~/.meetroom/templates/`, 404);
      }
      const session = reg.createSession({
        type: type as SessionType,
        cwd,
        remote,
        config: { ...tpl?.config, ...config },
        guild: guild ?? tpl?.name,
        baseCommit,
      });
      roster = roster ?? tpl?.roster;
      if (tpl?.budgets) for (const b of tpl.budgets) setBudget(reg, session, b);
      if (tpl?.notify) session.notify = structuredClone(tpl.notify);
      if (tpl?.planDescription) createDraftPlan(reg, session, tpl.planDescription);
      if (tpl?.runners) {
        for (const r of tpl.runners) {
          spawnRunner(reg, session, reg.dataDir, { agentName: r.agentName, command: r.command, restartPolicy: r.restartPolicy });
        }
      }
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
      if (!s) return;
      // Never echo credentials back out: the session token and integration
      // HMAC secrets live in the session object but are not state consumers need.
      const { token, integrations, ...rest } = s;
      json(c.res, 200, { ok: true, session: { ...rest, integrations: integrations.map((i) => ({ source: i.source })) } });
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
      releaseAgentPresence(reg, s, agent.id);
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
      // Once operators exist, speaking AS the human requires an operator key —
      // otherwise any agent could impersonate the human's voice in the room.
      // (Solo mode: no operators configured, no ceremony.)
      if (agentId === "human" && !requireOperator(c, "reviewer")) return;
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
        if (!s || !ensureWritable(s, c.res, c.body.agentId)) return;
        const { agentId, filepath, wait, lines, timeoutMinutes } = c.body;
        if (!agentId || !filepath) return bad(c.res, "agentId and filepath required");
        // V5 #5 — surface memory about this file at the moment it matters.
        const relatedMemory = memoryForFile(s.cwd, filepath).map((n) => n.summary);
        if (lines) {
          // V5 #1 — line-range claim ("A-B")
          const m = String(lines).match(/^(\d+)-(\d+)$/);
          if (!m) return bad(c.res, 'lines must look like "120-180"');
          const result = claimLines(reg, s, agentId, filepath, Number(m[1]), Number(m[2]));
          reg.save(s);
          return json(c.res, result.ok ? 200 : 409, { ...result, granted: result.ok, relatedMemory });
        }
        const result = claimFile(reg, s, agentId, filepath, !!wait, timeoutMinutes ? Number(timeoutMinutes) : undefined);
        reg.save(s);
        json(c.res, result.ok ? 200 : 409, { ...result, relatedMemory });
      },
      true
    ),

    route(
      "POST",
      "/api/sessions/:id/release",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res, c.body.agentId)) return;
        const result = c.body.lines
          ? releaseLines(reg, s, c.body.agentId, c.body.filepath)
          : releaseFile(reg, s, c.body.agentId, c.body.filepath);
        reg.save(s);
        json(c.res, result.ok ? 200 : 409, result);
      },
      true
    ),

    route("GET", "/api/sessions/:id/recall", (c) => {
      const s = withSession(c);
      if (!s) return;
      const q = c.query.get("q") ?? "";
      json(c.res, 200, { ok: true, results: recallMemory(s.cwd, q) });
    }),

    route("POST", "/api/sessions/:id/memory/promote", (c) => {
      const s = withSession(c);
      if (!s) return;
      const result = promoteMemoryNode(s.cwd, c.body.nodeId);
      json(c.res, result.ok ? 200 : 404, result);
    }),

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
        if (!s || !ensureWritable(s, c.res, c.body.agentId, true)) return;
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
        if (!s || !ensureWritable(s, c.res, c.body.agentId, true)) return;
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
        if (!s || !ensureWritable(s, c.res, c.body.agentId, true)) return;
        const result = resolveProposal(reg, s, c.params.pid, c.body.agentId, c.body.response);
        json(c.res, result.ok ? 200 : 409, result);
      },
      true
    ),

    route(
      "POST",
      "/api/sessions/:id/proposals/:pid/reject",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res, c.body.agentId, true)) return;
        const result = rejectProposal(reg, s, c.params.pid, c.body.agentId ?? "human", c.body.reason);
        json(c.res, result.ok ? 200 : 409, result);
      },
      true
    ),

    route(
      "POST",
      "/api/sessions/:id/proposals/:pid/vote",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res, c.body.agentId, true)) return;
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
        if (!s || !ensureWritable(s, c.res, c.body.agentId)) return;
        const { title, description, files, dependsOn, requiresCI, requiresTests, verify, epicId } = c.body;
        if (!title) return bad(c.res, "title required");
        const result = createTask(reg, s, { title, description, files, dependsOn, requiresCI, requiresTests, verify, epicId });
        json(c.res, result.ok ? 201 : 400, result);
      },
      true
    ),

    route(
      "POST",
      "/api/sessions/:id/tasks/:tid/claim",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res, c.body.agentId)) return;
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
        if (!s || !ensureWritable(s, c.res, c.body.agentId)) return;
        const result = moveTask(reg, s, c.params.tid, c.body.status, c.body.agentId);
        json(c.res, result.ok ? 200 : 409, result);
      },
      true
    ),

    route(
      "POST",
      "/api/sessions/:id/tasks/:tid/assign",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res, c.body.agentId)) return;
        const { assignee } = c.body; // agent name or id; empty = unassign
        let assigneeId: string | undefined;
        if (assignee) {
          const target = s.agents.find((a) => a.name === assignee || a.id === assignee);
          if (!target) return bad(c.res, `no agent "${assignee}" in the room`, 404);
          assigneeId = target.id;
        }
        const result = assignTask(reg, s, c.params.tid, assigneeId, c.body.agentId);
        json(c.res, result.ok ? 200 : 409, result);
      },
      true
    ),

    route(
      "POST",
      "/api/sessions/:id/tasks/:tid/edit",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res, c.body.agentId)) return;
        const { title, description, files, verify } = c.body;
        const result = editTask(reg, s, c.params.tid, { title, description, files, verify }, c.body.agentId);
        json(c.res, result.ok ? 200 : 409, result);
      },
      true
    ),

    route(
      "POST",
      "/api/sessions/:id/tasks/:tid/cancel",
      (c) => {
        const s = withSession(c);
        if (!s || !ensureWritable(s, c.res, c.body.agentId)) return;
        const result = cancelTask(reg, s, c.params.tid, c.body.agentId);
        json(c.res, result.ok ? 200 : 409, result);
      },
      true
    ),

    route("POST", "/api/sessions/:id/tasks/:tid/tests", (c) => {
      const s = withSession(c);
      if (!s || !ensureWritable(s, c.res, c.body.agentId)) return;
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
        if (!s || !ensureWritable(s, c.res, c.body.agentId)) return;
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
        if (!s || !ensureWritable(s, c.res, c.body.agentId)) return;
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
      if (!s || !ensureWritable(s, c.res, c.body.agentId)) return;
      const { name, command, installedBy, scope, manifest } = c.body;
      if (!name || !command) return bad(c.res, "name and command required");
      if (s.plugins.some((p) => p.name === name)) return bad(c.res, `plugin "${name}" already installed`, 409);
      const plugin: Plugin = { id: entityId("plug"), name, command, installedBy: installedBy ?? "human", scope: scope === "project" ? "project" : "session", manifest };
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
      if (!requireOperator(c, "maintainer")) return;
      const s = withSession(c);
      if (!s) return;
      if (s.status !== "active") return bad(c.res, `session is ${s.status}`, 409);
      s.status = "paused";
      reg.event(s, "session-paused");
      reg.notice(s, "room PAUSED — claims and task moves are frozen until resume");
      json(c.res, 200, { ok: true });
    }),

    route("POST", "/api/sessions/:id/resume", (c) => {
      if (!requireOperator(c, "maintainer")) return;
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
      if (!requireOperator(c, "maintainer")) return;
      const s = withSession(c);
      if (!s) return;
      if (s.status === "ended") return bad(c.res, "session already ended", 409);
      stopAllRunners(reg, s); // V4 #1 — no orphaned agent processes
      s.status = "ended";
      const memory = distillSessionIntoMemory(s); // V2 #6
      const retro = generateRetro(s); // V8 #3 — lessons don't evaporate
      const retroPath = saveRetro(s, retro);
      reg.event(s, "session-ended", undefined, { decisions: memory.decisions.length, retroPath });
      json(c.res, 200, { ok: true, memory, retro, retroPath });
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
        if (!s || !ensureWritable(s, c.res, c.body.agentId)) return;
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
        if (!s || !ensureWritable(s, c.res, c.body.agentId)) return;
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

    // ---- V4: runners / budgets / artifacts / attention ---------------------------
    route("POST", "/api/sessions/:id/runners", (c) => {
      const s = withSession(c);
      if (!s || !ensureWritable(s, c.res)) return;
      const { agentName, command, cwd, restartPolicy, maxRestarts } = c.body;
      if (!agentName || !command) return bad(c.res, "agentName and command required");
      const result = spawnRunner(reg, s, reg.dataDir, { agentName, command, cwd, restartPolicy, maxRestarts });
      reg.save(s);
      json(c.res, result.ok ? 201 : 409, result);
    }),

    route("POST", "/api/sessions/:id/runners/:name/stop", (c) => {
      const s = withSession(c);
      if (!s) return;
      const result = stopRunner(reg, s, c.params.name);
      reg.save(s);
      json(c.res, result.ok ? 200 : 404, result);
    }),

    route("GET", "/api/sessions/:id/runners/:name/logs", (c) => {
      const s = withSession(c);
      if (!s) return;
      if (!isSafeRunnerName(c.params.name)) return bad(c.res, "no such runner", 404);
      const p = runnerLogPath(reg.dataDir, s.id, c.params.name);
      c.res.writeHead(200, { "content-type": "text/plain" });
      c.res.end(existsSync(p) ? readFileSync(p) : "(no logs yet)");
    }),

    route("POST", "/api/sessions/:id/budgets", (c) => {
      if (!requireOperator(c, "maintainer")) return;
      const s = withSession(c);
      if (!s) return;
      const { scope, agentId, maxCostUsd, maxTokens, onBreach } = c.body;
      if (scope !== "session" && scope !== "agent") return bad(c.res, "scope must be session|agent");
      if (scope === "agent" && !agentId) return bad(c.res, "agentId required for agent-scope budgets");
      const budget = setBudget(reg, s, {
        scope,
        agentId,
        maxCostUsd: maxCostUsd !== undefined ? Number(maxCostUsd) : undefined,
        maxTokens: maxTokens !== undefined ? Number(maxTokens) : undefined,
        onBreach: ["pause-agent", "pause-room", "notify-only"].includes(onBreach) ? onBreach : "notify-only",
      });
      reg.save(s);
      json(c.res, 201, { ok: true, budget });
    }),

    route("POST", "/api/sessions/:id/artifacts", (c) => {
      const s = withSession(c);
      if (!s || !ensureWritable(s, c.res, c.body.agentId)) return;
      const { name, content, agentId, expectedVersion } = c.body;
      if (!name || content === undefined) return bad(c.res, "name and content required");
      const result = writeArtifact(reg, s, { name, content, agentId: agentId ?? "human", expectedVersion });
      reg.save(s);
      json(c.res, result.ok ? 200 : 409, result);
    }),

    route("GET", "/api/sessions/:id/artifacts", (c) => {
      const s = withSession(c);
      if (!s) return;
      const name = c.query.get("name");
      if (name) {
        const artifact = s.artifacts.find((a) => a.name === name);
        if (!artifact) return bad(c.res, "no such artifact", 404);
        return json(c.res, 200, { ok: true, artifact });
      }
      json(c.res, 200, { ok: true, artifacts: s.artifacts.map(({ content, ...meta }) => meta) });
    }),

    route("GET", "/api/attention", (c) => {
      json(c.res, 200, { ok: true, items: reg.listAttention().filter((i) => i.status === "open" || (i.status === "snoozed" && (!i.snoozeUntil || i.snoozeUntil < new Date().toISOString()))) });
    }),

    route("POST", "/api/attention/:aid", (c) => {
      const items = reg.listAttention();
      const item = items.find((i) => i.id === c.params.aid);
      if (!item) return bad(c.res, "no such attention item", 404);
      const { status, snoozeUntil } = c.body;
      if (!["acked", "done", "snoozed", "open"].includes(status)) return bad(c.res, "status must be acked|done|snoozed|open");
      item.status = status;
      item.snoozeUntil = status === "snoozed" ? snoozeUntil : undefined;
      reg.saveAttention(items);
      json(c.res, 200, { ok: true, item });
    }),

    // ---- V4 #3: routines (daemon-global) -----------------------------------------
    route("GET", "/api/routines", (c) => json(c.res, 200, { ok: true, routines: loadRoutines(reg.dataDir) })),

    route("POST", "/api/routines", (c) => {
      if (!requireOperator(c, "maintainer")) return;
      const { name, cron, cwd, template, guild } = c.body;
      if (!name || !cron || !cwd) return bad(c.res, "name, cron, and cwd required");
      if (cron.trim().split(/\s+/).length !== 5) return bad(c.res, "cron must have 5 fields (min hour dom mon dow)");
      const routines = loadRoutines(reg.dataDir);
      const routine = { id: entityId("rout"), name, cron, cwd, template, guild, enabled: true };
      routines.push(routine);
      saveRoutines(reg.dataDir, routines);
      json(c.res, 201, { ok: true, routine });
    }),

    route("DELETE", "/api/routines/:rid", (c) => {
      if (!requireOperator(c, "maintainer")) return; // same bar as creating one
      const routines = loadRoutines(reg.dataDir);
      const next = routines.filter((r) => r.id !== c.params.rid);
      if (next.length === routines.length) return bad(c.res, "no such routine", 404);
      saveRoutines(reg.dataDir, next);
      json(c.res, 200, { ok: true });
    }),

    // ---- misc -------------------------------------------------------------------
    route("POST", "/api/sessions/:id/usage", (c) => {
      const s = withSession(c);
      if (!s) return;
      const { agentId, tokensIn, tokensOut, costUsd } = c.body;
      if (!agentId) return bad(c.res, "agentId required");
      s.usage.push({ agentId, tokensIn: Number(tokensIn) || 0, tokensOut: Number(tokensOut) || 0, costUsd: Number(costUsd) || 0 });
      checkBudgets(reg, s); // V4 #2 — guardrails fire the moment spend is reported
      reg.save(s);
      json(c.res, 200, { ok: true });
    }),

    route("POST", "/api/sessions/:id/notify", (c) => {
      if (!requireOperator(c, "maintainer")) return;
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
      if (!s) return;
      const since = c.query.get("since"); // V5 #8 — delta brief
      json(c.res, 200, { ok: true, brief: since ? generateDeltaBrief(s, since) : generateBrief(s) });
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

    // ---- V6: operators / audit / policy / org / purge -----------------------------
    route("POST", "/api/operators", (c) => {
      if (!requireOperator(c, "owner")) return;
      const { name, role } = c.body;
      if (!name || !["owner", "maintainer", "reviewer", "observer"].includes(role)) {
        return bad(c.res, "name and role (owner|maintainer|reviewer|observer) required");
      }
      const { operator, key } = inviteOperator(reg.dataDir, name, role);
      json(c.res, 201, { ok: true, operator: { id: operator.id, name: operator.name, role: operator.role }, key });
    }),

    route("GET", "/api/operators", (c) => {
      json(c.res, 200, { ok: true, operators: loadOperators(reg.dataDir).map(({ keyHash, ...o }) => o) });
    }),

    route("DELETE", "/api/operators/:oid", (c) => {
      if (!requireOperator(c, "owner")) return;
      const ops = loadOperators(reg.dataDir);
      const next = ops.filter((o) => o.id !== c.params.oid && o.name !== c.params.oid);
      if (next.length === ops.length) return bad(c.res, "no such operator", 404);
      saveOperators(reg.dataDir, next);
      json(c.res, 200, { ok: true });
    }),

    route("GET", "/api/sessions/:id/audit", (c) => {
      const s = withSession(c);
      if (!s) return;
      const broken = Registry.verifyAuditChain(s);
      json(c.res, 200, { ok: true, intact: broken === -1, brokenIndex: broken === -1 ? undefined : broken, events: s.events.length });
    }),

    route("GET", "/api/sessions/:id/tasks/:tid/policy", (c) => {
      const s = withSession(c);
      if (!s) return;
      const task = s.tasks.find((t) => t.id === c.params.tid);
      if (!task) return bad(c.res, "no such task", 404);
      const rules = rulesForTask(loadPolicy(s.cwd), task);
      json(c.res, 200, { ok: true, rules, violations: policyViolations(s, task, reg.dataDir) });
    }),

    // V6 #7 — the slow questions: cost, throughput, escalations, per project.
    route("GET", "/api/org/report", (c) => {
      const projects = new Map<string, { sessions: number; tasksDone: number; escalations: number; costUsd: number; tokens: number }>();
      for (const s of reg.sessions.values()) {
        const p = projects.get(s.cwd) ?? { sessions: 0, tasksDone: 0, escalations: 0, costUsd: 0, tokens: 0 };
        p.sessions++;
        p.tasksDone += s.tasks.filter((t) => t.status === "done").length;
        p.escalations += s.proposals.filter((x) => x.status === "escalated").length;
        for (const u of s.usage) {
          p.costUsd += u.costUsd;
          p.tokens += u.tokensIn + u.tokensOut;
        }
        projects.set(s.cwd, p);
      }
      json(c.res, 200, { ok: true, projects: [...projects.entries()].map(([cwd, stats]) => ({ cwd, ...stats })) });
    }),

    // V6 #8 — keep the record, drop the payloads.
    route("POST", "/api/sessions/:id/purge", (c) => {
      if (!requireOperator(c, "owner")) return;
      const s = withSession(c);
      if (!s) return;
      if (s.status !== "ended") return bad(c.res, "only ended sessions can be purged (run `meetroom end` first)", 409);
      const reportPath = purgeSession(s, reg.dataDir, exportSession(s, "md"));
      reg.event(s, "session-purged", undefined, { reportPath });
      json(c.res, 200, { ok: true, reportPath });
    }),

    // ---- V7: inbound integrations ------------------------------------------------
    route("POST", "/api/sessions/:id/integrations", (c) => {
      if (!requireOperator(c, "maintainer")) return;
      const s = withSession(c);
      if (!s) return;
      const { source, secret } = c.body;
      if (!source || !secret) return bad(c.res, "source and secret required");
      s.integrations = s.integrations.filter((i) => i.source !== source);
      s.integrations.push({ source, secret });
      reg.save(s);
      json(c.res, 200, { ok: true });
    }),

    // V7 #3 — external systems talk back: HMAC-signed messages land in chat.
    // The signature covers `${ts}.${text}` and ts must be fresh; on top of the
    // freshness window, each accepted signature is remembered until it expires
    // so a captured request can't be replayed even inside the window.
    route("POST", "/api/sessions/:id/inbound", (c) => {
      const s = reg.get(c.params.id); // signature IS the auth — no session token needed
      if (!s) return bad(c.res, "no such session", 404);
      const { source, author, text, ts, signature } = c.body;
      if (!source || !text) return bad(c.res, "source and text required");
      if (!ts) return bad(c.res, "ts required (ISO-8601 or epoch ms; signature = HMAC-SHA256 of `${ts}.${text}`)");
      const integration = s.integrations.find((i) => i.source === source);
      if (!integration) return bad(c.res, `unknown integration source "${source}" — add it with \`meetroom integration add\``, 403);
      const sentAt = new Date(typeof ts === "number" ? ts : String(ts)).getTime();
      if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 5 * 60_000) {
        return bad(c.res, "stale or invalid ts — must be within 5 minutes of the daemon clock", 403);
      }
      const expected = createHmac("sha256", integration.secret).update(`${ts}.${text}`).digest();
      const given = Buffer.from(String(signature ?? ""), "hex");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return bad(c.res, "bad signature (HMAC-SHA256 of `${ts}.${text}` with the shared secret)", 403);
      }
      const sigKey = `${s.id}:${given.toString("hex")}`;
      for (const [k, expiresAt] of seenInboundSignatures) if (expiresAt < Date.now()) seenInboundSignatures.delete(k);
      if (seenInboundSignatures.has(sigKey)) {
        return bad(c.res, "replayed request — each signed message is accepted once", 403);
      }
      seenInboundSignatures.set(sigKey, sentAt + 6 * 60_000); // outlives the freshness window
      const msg = reg.chat(s, { agentId: "system", message: `[${source}] ${author ?? "someone"}: ${text}` });
      json(c.res, 200, { ok: true, message: msg });
    }),

    // ---- V8: autonomy / veto / verify / retro / simulate / epics -------------------
    route("POST", "/api/sessions/:id/autonomy", (c) => {
      if (!requireOperator(c, "maintainer")) return;
      const s = withSession(c);
      if (!s) return;
      const level = Number(c.body.level);
      if (![0, 1, 2, 3, 4].includes(level)) return bad(c.res, "level must be 0-4");
      s.config.autonomy = { level: level as 0 | 1 | 2 | 3 | 4, vetoWindowMinutes: Number(c.body.vetoWindowMinutes) || 10 };
      reg.event(s, "autonomy-changed", undefined, { level });
      reg.notice(s, `autonomy level set to L${level}${level >= 3 ? ` (meta-agent active, ${s.config.autonomy.vetoWindowMinutes}m veto window)` : ""}`);
      json(c.res, 200, { ok: true, autonomy: s.config.autonomy });
    }),

    route("POST", "/api/sessions/:id/actions/:aid/veto", (c) => {
      const s = withSession(c);
      if (!s) return;
      const result = vetoAction(reg, s, c.params.aid);
      reg.save(s);
      json(c.res, result.ok ? 200 : 404, result);
    }),

    // V8 #7 — the CLI runs the goal test locally and reports the outcome here.
    route("POST", "/api/sessions/:id/tasks/:tid/verify", (c) => {
      const s = withSession(c);
      if (!s) return;
      const task = s.tasks.find((t) => t.id === c.params.tid);
      if (!task) return bad(c.res, "no such task", 404);
      task.verifyResult = { passed: !!c.body.passed, output: String(c.body.output ?? "").slice(0, 10_000), at: now() };
      task.updatedAt = now();
      reg.event(s, "verify-result", c.body.agentId, { taskId: task.id, passed: task.verifyResult.passed });
      if (!task.verifyResult.passed) reg.notice(s, `verify FAILED for task ${task.id} ("${task.title}")`);
      json(c.res, 200, { ok: true });
    }),

    route("GET", "/api/sessions/:id/retro", (c) => {
      const s = withSession(c);
      if (s) json(c.res, 200, { ok: true, retro: generateRetro(s) });
    }),

    // V8 #4 — price the plan before running it. Also stores the draft so a
    // good simulation can be approved directly (still approval-gated).
    route("POST", "/api/sessions/:id/simulate", (c) => {
      const s = withSession(c);
      if (!s || !ensureWritable(s, c.res, c.body.agentId)) return;
      if (!c.body.description) return bad(c.res, "description required");
      const plan = createDraftPlan(reg, s, c.body.description);
      const sim = simulatePlan(s, plan.tasks);
      json(c.res, 200, { ok: true, plan, simulation: sim });
    }),

    route("POST", "/api/sessions/:id/epics", (c) => {
      const s = withSession(c);
      if (!s) return;
      const { title, northStar } = c.body;
      if (!title) return bad(c.res, "title required");
      const epic = createEpic(s.cwd, title, northStar ?? "");
      reg.event(s, "epic-created", undefined, { epicId: epic.id, title });
      json(c.res, 201, { ok: true, epic });
    }),

    route("GET", "/api/sessions/:id/epics", (c) => {
      const s = withSession(c);
      if (s) json(c.res, 200, { ok: true, epics: loadEpics(s.cwd) });
    }),

    route("GET", "/api/sessions/:id/epics/:eid/status", (c) => {
      const s = withSession(c);
      if (!s) return;
      const status = epicStatus(reg, s.cwd, c.params.eid);
      if (!status) return bad(c.res, "no such epic", 404);
      json(c.res, 200, { ok: true, ...status });
    }),
  ];

  // V7 #6 — the API contract, generated from the live route table so drift
  // is structurally impossible.
  routes.push(
    route("GET", "/api/openapi.json", (c) => {
      const paths: Record<string, Record<string, { summary: string }>> = {};
      for (const r of routes) {
        const path = r.path.replace(/:(\w+)/g, "{$1}");
        paths[path] ??= {};
        paths[path][r.method.toLowerCase()] = { summary: `${r.method} ${path}` };
      }
      json(c.res, 200, {
        openapi: "3.0.0",
        info: { title: "meetroom API", version: "8.0.0", description: "Auth: x-meetroom-token (remote sessions), x-meetroom-operator (privileged ops)" },
        paths,
      });
    })
  );

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type,x-meetroom-token,x-meetroom-operator",
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
        if (body === undefined) return bad(res, "request body is not valid JSON", 400);
        // V4 #4 — every authenticated agent call doubles as a liveness heartbeat.
        // (Only after the token check: unauthenticated remote callers must not
        // be able to keep an agent looking alive.)
        if (params.id && body?.agentId) {
          const s = reg.get(params.id);
          if (s && authorized(req, s)) heartbeat(s, body.agentId);
        }
        await r.handler({ req, res, reg, body, params, query: url.searchParams });
        return;
      }
      bad(res, "not found", 404);
    } catch (err) {
      bad(res, `internal error: ${(err as Error).message}`, 500);
    }
  });

  // V1 rule 2 + rule 3 timers, V4 liveness/escalation sweeps.
  const sweeper = setInterval(() => {
    for (const session of reg.sessions.values()) {
      sweepClaimTimeouts(reg, session);
      sweepProposalTimeouts(reg, session);
      sweepLiveness(reg, session);
      sweepEscalations(reg, session);
      sweepSelfHealing(reg, session); // V8 #6 — deadlock/regression detectors
      sweepMetaAgent(reg, session); // V8 #2 — only acts at L3+ with MEETROOM_OPERATOR set
      sweepPendingActions(reg, session);
    }
  }, 30_000);
  sweeper.unref();

  // V4 #3 — routine scheduler: fire cron-matched routines once per minute.
  let lastCronMinute = "";
  const cronTimer = setInterval(() => {
    const nowDate = new Date();
    const minuteKey = nowDate.toISOString().slice(0, 16);
    if (minuteKey === lastCronMinute) return;
    lastCronMinute = minuteKey;
    const routines = loadRoutines(reg.dataDir);
    let dirty = false;
    for (const routine of routines) {
      if (!routine.enabled || !cronMatches(routine.cron, nowDate)) continue;
      if (routine.lastFiredAt?.slice(0, 16) === minuteKey) continue;
      routine.lastFiredAt = nowDate.toISOString();
      dirty = true;
      try {
        const tpl = routine.template ? loadTemplate(routine.cwd, routine.template) : undefined;
        if (routine.template && !tpl) throw new Error(`template "${routine.template}" not found`);
        const session = reg.createSession({ type: "sxl", cwd: routine.cwd, config: tpl?.config, guild: routine.guild ?? tpl?.name });
        if (tpl?.budgets) for (const b of tpl.budgets) setBudget(reg, session, b);
        if (tpl?.notify) session.notify = structuredClone(tpl.notify);
        if (tpl?.planDescription) createDraftPlan(reg, session, tpl.planDescription);
        if (tpl?.runners) {
          for (const r of tpl.runners) spawnRunner(reg, session, reg.dataDir, { agentName: r.agentName, command: r.command, restartPolicy: r.restartPolicy });
        }
        reg.notice(session, `session created by routine "${routine.name}" (${routine.cron})`);
        reg.save(session);
      } catch (err) {
        reg.addAttention("(routine)", "routine-failed", `routine "${routine.name}" failed: ${(err as Error).message}`);
      }
    }
    if (dirty) saveRoutines(reg.dataDir, routines);
  }, 20_000);
  cronTimer.unref();

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

// Entry point: `node dist/src/daemon/server.js [--port N] [--bind HOST] [--tls-cert F --tls-key F]`
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const argOf = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = Number(argOf("--port") ?? process.env.MEETROOM_PORT ?? DEFAULT_PORT);
  // Localhost-only by default; `meetroom start --remote` binds all interfaces (V2 #4).
  const bind = argOf("--bind") ?? process.env.MEETROOM_BIND ?? "127.0.0.1";
  const certPath = argOf("--tls-cert") ?? process.env.MEETROOM_TLS_CERT;
  const keyPath = argOf("--tls-key") ?? process.env.MEETROOM_TLS_KEY;
  const reg = new Registry();
  const httpServer = buildServer(reg);
  let server: import("node:net").Server = httpServer;
  let scheme = "http";
  if (certPath && keyPath) {
    // V6 #2 — TLS for remote rooms; the plain-HTTP localhost path pays no ceremony.
    const { createServer: createHttps } = await import("node:https");
    server = createHttps(
      { cert: readFileSync(certPath), key: readFileSync(keyPath) },
      httpServer.listeners("request")[0] as (req: IncomingMessage, res: ServerResponse) => void
    );
    scheme = "https";
  }
  server.listen(port, bind, () => {
    mkdirSync(dirname(daemonInfoPath()), { recursive: true });
    writeFileSync(daemonInfoPath(), JSON.stringify({ port, bind, scheme, pid: process.pid, startedAt: now() }, null, 2));
    console.log(`meetroom daemon listening on ${scheme}://${bind}:${port}`);
  });
}
