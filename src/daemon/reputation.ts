import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentReputation, Session, Task } from "../shared/types.js";
import type { Registry } from "./registry.js";

// V3 #5 — agent reputation, keyed by stable agent identity (not per-session
// id), persisted in the project's .meetroom/ dir so it travels with the repo.
// Purely observational: no automatic penalties, just data.

function repPath(cwd: string): string {
  return join(cwd, ".meetroom", "reputation.json");
}

export function loadReputation(cwd: string): AgentReputation[] {
  const p = repPath(cwd);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as AgentReputation[];
  } catch {
    return [];
  }
}

function saveReputation(cwd: string, reps: AgentReputation[]): void {
  mkdirSync(join(cwd, ".meetroom"), { recursive: true });
  writeFileSync(repPath(cwd), JSON.stringify(reps, null, 2));
}

/** Update stats when a task completes, from the session's Review/Task records. */
export function updateReputationOnTaskDone(reg: Registry, session: Session, task: Task): void {
  const agent = session.agents.find((a) => a.id === task.assignedAgentId);
  if (!agent) return;
  const reviews = session.reviews.filter((r) => r.taskId === task.id);
  const rework = reviews.filter((r) => r.status === "changes-requested").length;
  const cleanPass = rework === 0 && reviews.some((r) => r.status === "approved");
  const turnaround =
    task.claimedAt && task.doneAt
      ? (new Date(task.doneAt).getTime() - new Date(task.claimedAt).getTime()) / 60_000
      : undefined;

  const reps = loadReputation(session.cwd);
  let rep = reps.find((r) => r.agentIdentity === agent.identity);
  if (!rep) {
    rep = { agentIdentity: agent.identity, tasksCompleted: 0, reviewPassRate: 0, avgReworkCount: 0, avgTurnaroundMinutes: 0 };
    reps.push(rep);
  }
  const n = rep.tasksCompleted;
  rep.reviewPassRate = round2((rep.reviewPassRate * n + (cleanPass ? 100 : 0)) / (n + 1));
  rep.avgReworkCount = round2((rep.avgReworkCount * n + rework) / (n + 1));
  if (turnaround !== undefined) {
    rep.avgTurnaroundMinutes = round2((rep.avgTurnaroundMinutes * n + turnaround) / (n + 1));
  }
  rep.tasksCompleted = n + 1;
  saveReputation(session.cwd, reps);
  reg.event(session, "reputation-updated", agent.id, { identity: agent.identity, taskId: task.id });
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
