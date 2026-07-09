import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Epic, PendingAction, Session, Task } from "../shared/types.js";
import { entityId, now } from "../shared/ids.js";
import type { Registry } from "./registry.js";
import { resolveProposal } from "./resolution.js";
import { generateBrief } from "./brief.js";
import { estimateComplexity } from "./routing.js";

// V8 — the self-improving org: autonomy levels (#1), meta-agent (#2),
// retrospectives (#3), simulation (#4), fleet learning (#5), self-healing
// detectors (#6), outcome verification (#7), epics (#8).
//
// Governing rule: autonomy is granted per capability, per track record —
// never globally, never by default.

// ---- #1 autonomy levels ---------------------------------------------------------

export function autonomyLevel(session: Session): number {
  return session.config.autonomy?.level ?? 1; // L1 assisted ≈ the V1–V3 default
}

/** At L0 (observe), agents discuss but don't act; humans drive all work. */
export function agentActionAllowed(session: Session, agentId: string | undefined): { ok: boolean; error?: string } {
  if (!agentId || agentId === "human") return { ok: true };
  if (autonomyLevel(session) === 0 && session.agents.some((a) => a.id === agentId)) {
    return { ok: false, error: "room is at autonomy L0 (observe): agents may say/propose/vote, but only humans claim or move work" };
  }
  return { ok: true };
}

// ---- #2 meta-agent operator -----------------------------------------------------

/**
 * Feed open attention items to MEETROOM_OPERATOR (JSON in → JSON action out)
 * and queue the returned action behind the veto window. Only runs at L3+.
 */
export function sweepMetaAgent(reg: Registry, session: Session): void {
  const cmd = process.env.MEETROOM_OPERATOR;
  if (!cmd || autonomyLevel(session) < 3 || session.status !== "active") return;
  session.pendingActions ??= [];
  const items = reg.listAttention().filter((i) => i.sessionId === session.id && i.status === "open");
  for (const item of items) {
    if (session.pendingActions.some((a) => a.data.attentionItemId === item.id && a.status === "pending")) continue;
    try {
      const input = JSON.stringify({
        item,
        brief: generateBrief(session),
        instructions:
          'Return JSON: {"kind":"resolve-proposal","proposalId":"..."} | {"kind":"reassign-task","taskId":"..."} | {"kind":"pause-room"} | {"kind":"wake-human"}, plus a "reason" string.',
      });
      const out = execFileSync("sh", ["-c", cmd], { input, encoding: "utf8", timeout: 120_000 });
      const parsed = JSON.parse(out) as { kind: PendingAction["kind"]; reason?: string; proposalId?: string; taskId?: string };
      if (!["resolve-proposal", "reassign-task", "pause-room", "wake-human"].includes(parsed.kind)) continue;
      queueAction(reg, session, parsed.kind, { attentionItemId: item.id, proposalId: parsed.proposalId, taskId: parsed.taskId }, parsed.reason ?? "(no reason given)");
    } catch {
      // A broken operator model must never break the room.
    }
  }
}

export function queueAction(reg: Registry, session: Session, kind: PendingAction["kind"], data: Record<string, unknown>, reason: string): PendingAction {
  const windowMin = session.config.autonomy?.vetoWindowMinutes ?? 10;
  session.pendingActions ??= [];
  const action: PendingAction = {
    id: entityId("act"),
    kind,
    data,
    reason,
    executeAt: new Date(Date.now() + windowMin * 60_000).toISOString(),
    status: "pending",
  };
  session.pendingActions.push(action);
  reg.event(session, "meta-agent-queued", "meta-agent", { actionId: action.id, kind, reason });
  reg.notice(session, `meta-agent will ${kind} in ${windowMin}m unless vetoed (meetroom veto ${action.id}): ${reason}`);
  return action;
}

export function vetoAction(reg: Registry, session: Session, actionId: string): { ok: boolean; error?: string } {
  const action = session.pendingActions?.find((a) => a.id === actionId);
  if (!action) return { ok: false, error: "no such pending action" };
  if (action.status !== "pending") return { ok: false, error: `action already ${action.status}` };
  action.status = "vetoed";
  reg.event(session, "meta-agent-vetoed", "human", { actionId });
  reg.notice(session, `meta-agent action ${actionId} vetoed`);
  return { ok: true };
}

/** Execute pending actions whose veto window has closed. */
export function sweepPendingActions(reg: Registry, session: Session): void {
  for (const action of session.pendingActions ?? []) {
    if (action.status !== "pending" || action.executeAt > now()) continue;
    action.status = "executed";
    reg.event(session, "meta-agent-executed", "meta-agent", { actionId: action.id, kind: action.kind });
    switch (action.kind) {
      case "resolve-proposal":
        if (typeof action.data.proposalId === "string") resolveProposal(reg, session, action.data.proposalId, "human");
        break;
      case "reassign-task": {
        const task = session.tasks.find((t) => t.id === action.data.taskId);
        if (task && task.status !== "done") {
          task.reassignedFrom = [...(task.reassignedFrom ?? []), task.assignedAgentId ?? "unassigned"];
          task.assignedAgentId = undefined;
          task.status = "todo";
          task.updatedAt = now();
        }
        break;
      }
      case "pause-room":
        if (session.status === "active") {
          session.status = "paused";
          reg.notice(session, "meta-agent paused the room");
        }
        break;
      case "wake-human":
        reg.addAttention(session.id, "meta-agent-action", `meta-agent asks for a human: ${action.reason}`);
        break;
    }
    // Close out the attention item the action addressed.
    const items = reg.listAttention();
    const item = items.find((i) => i.id === action.data.attentionItemId);
    if (item && item.status === "open" && action.kind !== "wake-human") {
      item.status = "done";
      reg.saveAttention(items);
    }
  }
}

// ---- #3 retrospective engine -------------------------------------------------------

export type Retro = {
  sessionId: string;
  generatedAt: string;
  stats: {
    tasksDone: number;
    tasksTotal: number;
    reviewBounceRate: number; // % of reviews that got changes-requested
    escalations: number;
    claimTimeouts: number;
    avgTaskTurnaroundMinutes?: number;
    totalCostUsd: number;
  };
  suggestions: string[];
};

export function generateRetro(session: Session): Retro {
  const done = session.tasks.filter((t) => t.status === "done");
  const bounced = session.reviews.filter((r) => r.status === "changes-requested").length;
  const timeouts = session.events.filter((e) => e.type === "claim-timeout").length;
  const turnarounds = done
    .filter((t) => t.claimedAt && t.doneAt)
    .map((t) => (new Date(t.doneAt!).getTime() - new Date(t.claimedAt!).getTime()) / 60_000);
  const suggestions: string[] = [];
  if (timeouts >= 3) {
    suggestions.push(`claim timeout hit ${timeouts}× — consider a higher --claim-timeout or per-claim --timeout for the affected files`);
  }
  const bounceRate = session.reviews.length ? Math.round((bounced / session.reviews.length) * 100) : 0;
  if (bounceRate > 40) {
    suggestions.push(`review bounce rate ${bounceRate}% — consider requiring --confidence on submissions or a QA gate (--requires-tests)`);
  }
  const escalations = session.proposals.filter((p) => p.status === "escalated").length;
  if (escalations >= 2 && session.agents.length < 3) {
    suggestions.push(`${escalations} escalations with <3 agents — a third agent would enable voting instead of paging you`);
  }
  const blocked = session.tasks.filter((t) => t.status === "blocked").length;
  if (blocked > 0) suggestions.push(`${blocked} tasks still blocked at session end — check dependency ordering in planning`);
  return {
    sessionId: session.id,
    generatedAt: now(),
    stats: {
      tasksDone: done.length,
      tasksTotal: session.tasks.length,
      reviewBounceRate: bounceRate,
      escalations,
      claimTimeouts: timeouts,
      avgTaskTurnaroundMinutes: turnarounds.length ? Math.round(turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length) : undefined,
      totalCostUsd: session.usage.reduce((s, u) => s + u.costUsd, 0),
    },
    suggestions,
  };
}

export function saveRetro(session: Session, retro: Retro): string {
  const dir = join(session.cwd, ".meetroom", "retros");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${session.id}.json`);
  writeFileSync(p, JSON.stringify(retro, null, 2));
  return p;
}

// ---- #5 fleet learning ---------------------------------------------------------------

type FleetRecord = { identity: string; complexity: string; turnaroundMinutes?: number; rework: number; at: string };

function fleetPath(): string {
  return join(process.env.MEETROOM_HOME ?? join(homedir(), ".meetroom"), "fleet-stats.json");
}

export function loadFleetStats(): FleetRecord[] {
  if (!existsSync(fleetPath())) return [];
  try {
    return JSON.parse(readFileSync(fleetPath(), "utf8")) as FleetRecord[];
  } catch {
    return [];
  }
}

/** Opt-in per session; strictly stats, strictly local disk — never code or filenames. */
export function recordFleetStat(session: Session, task: Task, rework: number): void {
  if (!session.config.fleetLearning) return;
  const agent = session.agents.find((a) => a.id === task.assignedAgentId);
  if (!agent) return;
  const records = loadFleetStats();
  records.push({
    identity: agent.identity,
    complexity: task.estimatedComplexity ?? "moderate",
    turnaroundMinutes:
      task.claimedAt && task.doneAt ? Math.round((new Date(task.doneAt).getTime() - new Date(task.claimedAt).getTime()) / 60_000) : undefined,
    rework,
    at: now(),
  });
  mkdirSync(join(fleetPath(), ".."), { recursive: true });
  writeFileSync(fleetPath(), JSON.stringify(records.slice(-500), null, 2));
}

// ---- #4 simulation / dry-run ------------------------------------------------------------

export function simulatePlan(session: Session, tasks: { title: string; description: string }[]): {
  taskCount: number;
  estTotalMinutes: number;
  estCostUsd: number;
  perTask: { title: string; complexity: string; estMinutes: number }[];
  basis: string;
} {
  // Historical turnaround by complexity: this session's done tasks first, fleet stats as fallback.
  const local = session.tasks.filter((t) => t.status === "done" && t.claimedAt && t.doneAt);
  const fleet = loadFleetStats();
  const byComplexity = (c: string): number => {
    const localSamples = local
      .filter((t) => (t.estimatedComplexity ?? "moderate") === c)
      .map((t) => (new Date(t.doneAt!).getTime() - new Date(t.claimedAt!).getTime()) / 60_000);
    const fleetSamples = fleet.filter((r) => r.complexity === c && r.turnaroundMinutes !== undefined).map((r) => r.turnaroundMinutes!);
    const samples = localSamples.length >= 2 ? localSamples : [...localSamples, ...fleetSamples];
    if (!samples.length) return c === "trivial" ? 15 : c === "complex" ? 120 : 45; // honest defaults
    return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  };
  const doneCount = local.length;
  const totalCost = session.usage.reduce((s, u) => s + u.costUsd, 0);
  const costPerTask = doneCount > 0 ? totalCost / doneCount : 0;

  const perTask = tasks.map((t) => {
    const complexity = estimateComplexity({ title: t.title, description: t.description, files: [] }) ?? "moderate";
    return { title: t.title, complexity, estMinutes: byComplexity(complexity) };
  });
  return {
    taskCount: perTask.length,
    estTotalMinutes: perTask.reduce((s, t) => s + t.estMinutes, 0),
    estCostUsd: Math.round(costPerTask * perTask.length * 100) / 100,
    perTask,
    basis: doneCount > 0 ? `${doneCount} completed local tasks${fleet.length ? ` + ${fleet.length} fleet records` : ""}` : fleet.length ? `${fleet.length} fleet records` : "defaults (no history yet)",
  };
}

// ---- #6 self-healing detectors -------------------------------------------------------------

export function sweepSelfHealing(reg: Registry, session: Session): void {
  if (session.status !== "active") return;
  // Fully-blocked board: everything open is blocked → nobody can make progress.
  const open = session.tasks.filter((t) => t.status !== "done");
  if (open.length > 0 && open.every((t) => t.status === "blocked")) {
    reg.addAttention(session.id, "deadlock", `all ${open.length} open tasks are blocked — the dependency graph has a knot`);
  }
  // Waitlist cycle: A waits on a file held by B while B waits on a file held by A.
  for (const wl of session.waitlists) {
    const holder = session.claims.find((c) => c.filepath === wl.filepath)?.agentId;
    if (!holder) continue;
    for (const waiter of wl.waitingAgentIds) {
      const reverse = session.waitlists.some(
        (other) => other.waitingAgentIds.includes(holder) && session.claims.find((c) => c.filepath === other.filepath)?.agentId === waiter
      );
      if (reverse) {
        reg.addAttention(session.id, "deadlock", `claim deadlock: ${agentName(session, waiter)} ⇄ ${agentName(session, holder)} are waiting on each other's files`);
      }
    }
  }
  // Regression tripwire: CI went red on a task already done.
  for (const ci of session.ciStatuses) {
    const task = session.tasks.find((t) => t.id === ci.taskId);
    if (task?.status === "done" && ci.status === "failed" && ci.updatedAt > (task.doneAt ?? "")) {
      reg.addAttention(session.id, "regression", `CI failed AFTER task ${task.id} ("${task.title}") was done — likely regression`);
    }
  }
}

function agentName(session: Session, agentId: string): string {
  return session.agents.find((a) => a.id === agentId)?.name ?? agentId;
}

// ---- #8 epics (.meetroom/epics.json, travels with the repo) ----------------------------------

function epicsPath(cwd: string): string {
  return join(cwd, ".meetroom", "epics.json");
}

export function loadEpics(cwd: string): Epic[] {
  if (!existsSync(epicsPath(cwd))) return [];
  try {
    return JSON.parse(readFileSync(epicsPath(cwd), "utf8")) as Epic[];
  } catch {
    return [];
  }
}

export function saveEpics(cwd: string, epics: Epic[]): void {
  mkdirSync(join(cwd, ".meetroom"), { recursive: true });
  writeFileSync(epicsPath(cwd), JSON.stringify(epics, null, 2));
}

export function createEpic(cwd: string, title: string, northStar: string): Epic {
  const epics = loadEpics(cwd);
  const epic: Epic = { id: entityId("epic"), title, northStar, taskRefs: [], status: "active", createdAt: now() };
  epics.push(epic);
  saveEpics(cwd, epics);
  return epic;
}

export function linkTaskToEpic(cwd: string, epicId: string, sessionId: string, taskId: string): boolean {
  const epics = loadEpics(cwd);
  const epic = epics.find((e) => e.id === epicId);
  if (!epic) return false;
  epic.taskRefs.push({ sessionId, taskId });
  saveEpics(cwd, epics);
  return true;
}

/** Cross-session progress: resolve each taskRef against the registry. */
export function epicStatus(reg: Registry, cwd: string, epicId: string): { epic: Epic; done: number; total: number; open: string[] } | undefined {
  const epic = loadEpics(cwd).find((e) => e.id === epicId);
  if (!epic) return undefined;
  let done = 0;
  const open: string[] = [];
  for (const ref of epic.taskRefs) {
    const task = reg.get(ref.sessionId)?.tasks.find((t) => t.id === ref.taskId);
    if (!task) continue;
    if (task.status === "done") done++;
    else open.push(`[${task.status}] ${task.title} (${ref.sessionId})`);
  }
  return { epic, done, total: epic.taskRefs.length, open };
}
