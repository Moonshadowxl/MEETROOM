import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentRunner, Artifact, Budget, Routine, Session, SessionTemplate } from "../shared/types.js";
import { entityId, now } from "../shared/ids.js";
import type { Registry } from "./registry.js";
import { releaseAgentPresence } from "./fileClaims.js";
import { aggregateUsage } from "./exporter.js";

// V4 — operations & autonomy: agent runner/supervisor (#1), budget
// guardrails (#2), routines (#3), liveness & reassignment (#4), shared
// artifacts (#6), escalation policy sweep (#7), templates (#8).

// ---- #1 agent runner / supervisor -------------------------------------------

const children = new Map<string, ChildProcess>(); // key: sessionId/agentName

function runnerKey(sessionId: string, agentName: string): string {
  return `${sessionId}/${agentName}`;
}

/** Runner names become log filenames — keep them path-safe. */
export function isSafeRunnerName(name: string): boolean {
  return /^[A-Za-z0-9._@-]+$/.test(name) && !name.includes("..");
}

export function runnerLogPath(dataDir: string, sessionId: string, agentName: string): string {
  if (!isSafeRunnerName(agentName)) throw new Error(`unsafe runner name "${agentName}"`);
  const dir = join(dataDir, "..", "agent-logs", sessionId);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${agentName}.log`);
}

export function spawnRunner(
  reg: Registry,
  session: Session,
  dataDir: string,
  opts: { agentName: string; command: string; cwd?: string; restartPolicy?: AgentRunner["restartPolicy"]; maxRestarts?: number }
): { ok: boolean; error?: string; runner?: AgentRunner } {
  if (!isSafeRunnerName(opts.agentName)) {
    return { ok: false, error: "runner name may only contain letters, digits, and . _ @ -" };
  }
  let runner = session.runners.find((r) => r.agentName === opts.agentName);
  if (runner && (runner.state === "running" || runner.state === "restarting")) {
    return { ok: false, error: `runner "${opts.agentName}" is already ${runner.state}${runner.pid ? ` (pid ${runner.pid})` : ""}` };
  }
  if (!runner) {
    runner = {
      agentName: opts.agentName,
      command: opts.command,
      cwd: opts.cwd ?? session.cwd,
      restartPolicy: opts.restartPolicy ?? "on-crash",
      maxRestarts: opts.maxRestarts ?? 3,
      restarts: 0,
      state: "stopped",
    };
    session.runners.push(runner);
  } else {
    runner.command = opts.command;
    runner.cwd = opts.cwd ?? runner.cwd;
    runner.restartPolicy = opts.restartPolicy ?? runner.restartPolicy;
    if (opts.maxRestarts !== undefined) runner.maxRestarts = opts.maxRestarts;
    // A manual respawn is a fresh start: without this, a runner that once
    // exhausted maxRestarts keeps the stale counter and never auto-restarts again.
    runner.restarts = 0;
  }
  launch(reg, session, dataDir, runner);
  return { ok: true, runner };
}

function launch(reg: Registry, session: Session, dataDir: string, runner: AgentRunner): void {
  const log = createWriteStream(runnerLogPath(dataDir, session.id, runner.agentName), { flags: "a" });
  log.write(`\n--- launch ${now()} ---\n`);
  const child = spawn("sh", ["-c", runner.command], {
    cwd: runner.cwd,
    env: {
      ...process.env,
      MEETROOM_AGENT: runner.agentName,
      MEETROOM_SESSION: session.id,
      ...(session.token ? { MEETROOM_TOKEN: session.token } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  runner.pid = child.pid;
  runner.state = "running";
  runner.startedAt = now();
  children.set(runnerKey(session.id, runner.agentName), child);
  reg.event(session, "runner-started", undefined, { agentName: runner.agentName, pid: child.pid });

  child.on("exit", (code) => {
    // `agent restart` stops the old child and launches a new one before the old
    // exit event lands. Only the runner's *current* child may touch its state —
    // otherwise this handler would mark the fresh child "crashed" and deregister it.
    if (children.get(runnerKey(session.id, runner.agentName)) !== child) return;
    children.delete(runnerKey(session.id, runner.agentName));
    // stopRunner marks the runner "stopped" before killing it; an explicit stop
    // must neither count as a crash nor trigger the restart policy.
    const explicitStop = runner.state === "stopped";
    const crashed = code !== 0 && !explicitStop;
    runner.state = crashed ? "crashed" : "stopped";
    reg.event(session, crashed ? "runner-crashed" : "runner-exited", undefined, { agentName: runner.agentName, code });
    const shouldRestart =
      !explicitStop &&
      session.status === "active" &&
      (runner.restartPolicy === "always" || (runner.restartPolicy === "on-crash" && crashed)) &&
      runner.restarts < runner.maxRestarts;
    if (shouldRestart) {
      runner.restarts++;
      runner.state = "restarting";
      reg.notice(session, `runner ${runner.agentName} ${crashed ? "crashed" : "exited"} — restarting (${runner.restarts}/${runner.maxRestarts})`);
      setTimeout(() => {
        if (session.status === "active") launch(reg, session, dataDir, runner);
      }, 2000).unref();
    } else if (crashed) {
      reg.addAttention(session.id, "stalled-room", `runner ${runner.agentName} crashed and won't restart (exit ${code})`);
    }
  });
}

export function stopRunner(reg: Registry, session: Session, agentName: string): { ok: boolean; error?: string } {
  const runner = session.runners.find((r) => r.agentName === agentName);
  if (!runner) return { ok: false, error: "no such runner" };
  // Mark stopped BEFORE killing: the exit handler reads this to know the stop
  // was explicit (no auto-restart, not a crash). The policy itself is kept so
  // a later `agent restart` behaves as originally configured.
  runner.state = "stopped";
  const child = children.get(runnerKey(session.id, agentName));
  if (child) child.kill("SIGTERM");
  reg.event(session, "runner-stopped", undefined, { agentName });
  return { ok: true };
}

export function stopAllRunners(reg: Registry, session: Session): void {
  for (const r of session.runners) if (r.state === "running") stopRunner(reg, session, r.agentName);
}

// ---- #2 budget guardrails ---------------------------------------------------

export function setBudget(reg: Registry, session: Session, budget: Omit<Budget, "breachedAt">): Budget {
  session.budgets = session.budgets.filter((b) => !(b.scope === budget.scope && b.agentId === budget.agentId));
  const b: Budget = { ...budget };
  session.budgets.push(b);
  reg.event(session, "budget-set", budget.agentId, { ...budget });
  return b;
}

/** Called after every usage report; enforces caps. */
export function checkBudgets(reg: Registry, session: Session): void {
  const totals = aggregateUsage(session);
  const sessionCost = totals.reduce((s, u) => s + u.costUsd, 0);
  const sessionTokens = totals.reduce((s, u) => s + u.tokensIn + u.tokensOut, 0);
  for (const b of session.budgets) {
    if (b.breachedAt) continue;
    let cost = sessionCost;
    let tokens = sessionTokens;
    if (b.scope === "agent") {
      const t = totals.find((u) => u.agentId === b.agentId);
      cost = t?.costUsd ?? 0;
      tokens = t ? t.tokensIn + t.tokensOut : 0;
    }
    const over =
      (b.maxCostUsd !== undefined && cost >= b.maxCostUsd) || (b.maxTokens !== undefined && tokens >= b.maxTokens);
    if (!over) continue;
    b.breachedAt = now();
    const who = b.scope === "agent" ? session.agents.find((a) => a.id === b.agentId)?.name ?? b.agentId : "session";
    reg.event(session, "budget-breached", b.agentId, { scope: b.scope, cost, tokens });
    reg.addAttention(session.id, "budget-breach", `budget breached (${who}): $${cost.toFixed(2)} / ${tokens} tokens`);
    if (b.onBreach === "pause-room" && session.status === "active") {
      session.status = "paused";
      reg.notice(session, `room auto-PAUSED: budget breached (${who})`);
    } else if (b.onBreach === "pause-agent") {
      reg.notice(session, `agent ${who} exceeded its budget — its claims and task moves are now rejected`);
    }
  }
}

/** True if this agent is blocked by a breached pause-agent budget. */
export function agentBudgetBlocked(session: Session, agentId: string): boolean {
  return session.budgets.some((b) => b.scope === "agent" && b.agentId === agentId && b.breachedAt && b.onBreach === "pause-agent");
}

// ---- #4 liveness, heartbeats & reassignment ------------------------------------

/** Any authenticated agent call counts as a heartbeat. */
export function heartbeat(session: Session, agentId: string): void {
  const agent = session.agents.find((a) => a.id === agentId);
  if (!agent) return;
  agent.lastSeenAt = now();
  if (agent.status === "idle" || agent.status === "disconnected") agent.status = "active";
}

export function sweepLiveness(reg: Registry, session: Session): void {
  if (session.status !== "active") return;
  const stallMs = session.config.stallMinutes * 60_000;
  for (const agent of session.agents) {
    if (agent.status === "waiting" || agent.status === "disconnected") continue;
    const silentMs = Date.now() - new Date(agent.lastSeenAt).getTime();
    if (silentMs > 2 * stallMs) {
      agent.status = "disconnected";
      reg.event(session, "agent-disconnected", agent.id, { silentMinutes: Math.round(silentMs / 60_000) });
      reg.notice(session, `${agent.name} appears dead (${Math.round(silentMs / 60_000)}m silent) — releasing claims, returning tasks`);
      releaseAgentPresence(reg, session, agent.id);
      for (const task of session.tasks) {
        if (task.assignedAgentId === agent.id && (task.status === "in-progress" || task.status === "todo")) {
          task.reassignedFrom = [...(task.reassignedFrom ?? []), agent.id];
          task.assignedAgentId = undefined;
          task.status = "todo";
          task.updatedAt = now();
          reg.event(session, "task-reassigned", agent.id, { taskId: task.id, reason: "agent-disconnected" });
        }
      }
    } else if (silentMs > stallMs && agent.status === "active") {
      agent.status = "idle";
      reg.event(session, "agent-stalled", agent.id, { silentMinutes: Math.round(silentMs / 60_000) });
      reg.notice(session, `${agent.name} has been silent for ${Math.round(silentMs / 60_000)}m — marked idle`);
    }
  }
}

// ---- #6 shared artifacts --------------------------------------------------------

export function writeArtifact(
  reg: Registry,
  session: Session,
  opts: { name: string; content: string; agentId: string; expectedVersion?: number }
): { ok: true; artifact: Artifact } | { ok: false; error: string; current?: Artifact } {
  let artifact = session.artifacts.find((a) => a.name === opts.name);
  if (artifact) {
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== artifact.version) {
      return { ok: false, error: `version conflict: expected ${opts.expectedVersion}, current is ${artifact.version}`, current: artifact };
    }
    artifact.content = opts.content;
    artifact.version++;
    artifact.updatedBy = opts.agentId;
    artifact.updatedAt = now();
  } else {
    artifact = { id: entityId("art"), name: opts.name, content: opts.content, version: 1, updatedBy: opts.agentId, updatedAt: now() };
    session.artifacts.push(artifact);
  }
  reg.event(session, "artifact-written", opts.agentId, { name: opts.name, version: artifact.version });
  return { ok: true, artifact };
}

// ---- #7 escalation policy sweep ---------------------------------------------------

export function sweepEscalations(reg: Registry, session: Session): void {
  const timeout = session.config.escalation?.humanResponseTimeoutMinutes;
  if (!timeout || session.status !== "active") return;
  const cutoff = Date.now() - timeout * 60_000;
  for (const p of session.proposals) {
    if (p.status !== "escalated") continue;
    const escalatedAt = session.events.find((e) => e.type === "escalation" && e.data?.proposalId === p.id)?.ts;
    if (!escalatedAt || new Date(escalatedAt).getTime() > cutoff) continue;
    const acted = session.events.some((e) => e.type === "escalation-timeout" && e.data?.proposalId === p.id);
    if (acted) continue;
    reg.event(session, "escalation-timeout", undefined, { proposalId: p.id });
    reg.addAttention(session.id, "escalation", `escalation ${p.id} unanswered for ${timeout}m: ${p.content.slice(0, 120)}`);
    if (session.config.escalation?.pauseRoomOnUnanswered) {
      session.status = "paused";
      reg.notice(session, `room auto-PAUSED: escalation ${p.id} unanswered for ${timeout}m`);
    }
  }
}

// ---- #8 session templates + #3 routines ----------------------------------------------

export function templateDirs(cwd: string): string[] {
  return [join(cwd, ".meetroom", "templates"), join(process.env.MEETROOM_HOME ?? join(homedir(), ".meetroom"), "templates")];
}

export function loadTemplate(cwd: string, name: string): SessionTemplate | undefined {
  for (const dir of templateDirs(cwd)) {
    const p = join(dir, `${name}.json`);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf8")) as SessionTemplate;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function saveTemplate(cwd: string, template: SessionTemplate, userScope: boolean): string {
  const dir = templateDirs(cwd)[userScope ? 1 : 0];
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${template.name}.json`);
  writeFileSync(p, JSON.stringify(template, null, 2));
  return p;
}

// Routines are daemon-global (they outlive sessions), stored next to attention.json.
export function routinesPath(dataDir: string): string {
  return join(dataDir, "..", "routines.json");
}

export function loadRoutines(dataDir: string): Routine[] {
  const p = routinesPath(dataDir);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Routine[];
  } catch {
    return [];
  }
}

export function saveRoutines(dataDir: string, routines: Routine[]): void {
  writeFileSync(routinesPath(dataDir), JSON.stringify(routines, null, 2));
}

// Minimal 5-field cron matcher: numbers, "*", "*/n" steps, and comma lists.
export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
  const fieldMin = [0, 0, 1, 1, 0]; // cron steps count from the field's minimum (dom/month are 1-based)
  return fields.every((field, i) =>
    field.split(",").some((part) => {
      if (part === "*") return true;
      const step = part.match(/^\*\/(\d+)$/);
      if (step) return Number(step[1]) > 0 && (values[i] - fieldMin[i]) % Number(step[1]) === 0;
      if (i === 4 && Number(part) === 7) return values[i] === 0; // cron allows 0 or 7 for Sunday
      return Number(part) === values[i];
    })
  );
}
