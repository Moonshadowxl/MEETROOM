import type { Session, Task, TaskStatus } from "../shared/types.js";
import { entityId, now } from "../shared/ids.js";
import type { Registry } from "./registry.js";
import { claimFile } from "./fileClaims.js";
import { estimateComplexity, suggestAgent } from "./routing.js";
import { updateReputationOnTaskDone } from "./reputation.js";
import { predictConflicts } from "./intelligence.js";
import { policyViolations } from "./trust.js";
import { linkTaskToEpic, recordFleetStat } from "./evolve.js";

// V2 #1 — task board: agents claim *work*, not just paths. File claims stay
// the low-level primitive underneath.

// "cancelled" is deliberately absent: tasks are cancelled only through
// cancelTask (which also voids dependency references), never via move.
// A cancelled task can be reopened with `task move <id> todo`.
const VALID_STATUSES: TaskStatus[] = ["todo", "in-progress", "review", "done", "blocked"];

export function createTask(
  reg: Registry,
  session: Session,
  opts: {
    title: string;
    description?: string;
    files?: string[];
    dependsOn?: string[];
    requiresCI?: boolean;
    requiresTests?: boolean;
    verify?: { command: string; timeoutSeconds?: number };
    epicId?: string;
  }
): { ok: true; task: Task } | { ok: false; error: string } {
  for (const dep of opts.dependsOn ?? []) {
    if (!session.tasks.some((t) => t.id === dep)) return { ok: false, error: `unknown dependency task ${dep}` };
  }
  const task: Task = {
    id: entityId("task"),
    title: opts.title,
    description: opts.description ?? "",
    status: "todo",
    files: opts.files ?? [],
    dependsOn: opts.dependsOn,
    requiresCI: opts.requiresCI,
    requiresTests: opts.requiresTests,
    verify: opts.verify, // V8 #7 — the acceptance test, written before implementation bias sets in
    epicId: opts.epicId,
    createdAt: now(),
    updatedAt: now(),
  };
  if (opts.epicId && !linkTaskToEpic(session.cwd, opts.epicId, session.id, task.id)) {
    return { ok: false, error: `unknown epic ${opts.epicId}` };
  }
  // V3 #4 — routing suggestion (advisory only; agents/human still decide).
  task.estimatedComplexity = estimateComplexity(task);
  task.suggestedAgentId = suggestAgent(session, task);
  // V5 #2 — conflict prediction (also advisory; never blocks creation).
  const warnings = predictConflicts(session, task);
  if (warnings.length) {
    task.conflictWarnings = warnings;
    reg.notice(session, `task ${task.id}: ${warnings[0]}`);
  }
  session.tasks.push(task);
  reg.event(session, "task-created", undefined, { taskId: task.id, title: task.title });
  return { ok: true, task };
}

/** Assign an agent to a task and auto-claim its listed files (V2 #1). */
export function claimTask(
  reg: Registry,
  session: Session,
  taskId: string,
  agentId: string
): { ok: boolean; error?: string; queuedFiles?: string[] } {
  const task = session.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: "no such task" };
  if (task.status === "done" || task.status === "cancelled") {
    return { ok: false, error: `task is ${task.status}` };
  }
  if (task.assignedAgentId && task.assignedAgentId !== agentId) {
    return { ok: false, error: `task already assigned to ${task.assignedAgentId}` };
  }
  const queuedFiles: string[] = [];
  for (const f of task.files) {
    const res = claimFile(reg, session, agentId, f, true);
    if (res.ok && !res.granted) queuedFiles.push(f);
  }
  task.assignedAgentId = agentId;
  task.claimedAt = now();
  task.updatedAt = now();
  reg.event(session, "task-claimed", agentId, { taskId });
  return { ok: true, queuedFiles: queuedFiles.length ? queuedFiles : undefined };
}

/** Assign (or, with assignee undefined, unassign) a task without file auto-claim. */
export function assignTask(
  reg: Registry,
  session: Session,
  taskId: string,
  assigneeAgentId: string | undefined,
  actorAgentId?: string
): { ok: boolean; error?: string } {
  const task = session.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: "no such task" };
  if (task.status === "done" || task.status === "cancelled") return { ok: false, error: `task is ${task.status}` };
  if (assigneeAgentId && !session.agents.some((a) => a.id === assigneeAgentId)) {
    return { ok: false, error: "no such agent in the room" };
  }
  const previous = task.assignedAgentId;
  task.assignedAgentId = assigneeAgentId;
  if (assigneeAgentId) task.claimedAt = now();
  else if (previous) task.reassignedFrom = [...(task.reassignedFrom ?? []), previous];
  task.updatedAt = now();
  reg.event(session, assigneeAgentId ? "task-assigned" : "task-dropped", actorAgentId, { taskId, assignee: assigneeAgentId, previous });
  return { ok: true };
}

/** Edit a task's mutable fields. Gates and history stay untouched. */
export function editTask(
  reg: Registry,
  session: Session,
  taskId: string,
  patch: { title?: string; description?: string; files?: string[]; verify?: { command: string; timeoutSeconds?: number } | null },
  agentId?: string
): { ok: boolean; error?: string; task?: Task } {
  const task = session.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: "no such task" };
  if (task.status === "done" || task.status === "cancelled") return { ok: false, error: `task is ${task.status} — reopen it first` };
  if (patch.title !== undefined) {
    if (!String(patch.title).trim()) return { ok: false, error: "title cannot be empty" };
    task.title = String(patch.title);
  }
  if (patch.description !== undefined) task.description = String(patch.description);
  if (patch.files !== undefined) task.files = patch.files;
  if (patch.verify !== undefined) task.verify = patch.verify ?? undefined; // null clears the goal test
  task.estimatedComplexity = estimateComplexity(task);
  task.updatedAt = now();
  reg.event(session, "task-edited", agentId, { taskId, fields: Object.keys(patch) });
  return { ok: true, task };
}

/**
 * Cancel a task: it keeps its record (status "cancelled") but stops blocking
 * anything — its id is removed from every other task's dependsOn, and tasks
 * that were blocked only on it pop back to todo.
 */
export function cancelTask(
  reg: Registry,
  session: Session,
  taskId: string,
  agentId?: string
): { ok: boolean; error?: string } {
  const task = session.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: "no such task" };
  if (task.status === "done") return { ok: false, error: "task is done — nothing to cancel" };
  if (task.status === "cancelled") return { ok: false, error: "task is already cancelled" };
  task.status = "cancelled";
  task.assignedAgentId = undefined;
  task.updatedAt = now();
  for (const t of session.tasks) {
    if (t.dependsOn?.includes(taskId)) t.dependsOn = t.dependsOn.filter((d) => d !== taskId);
  }
  reg.event(session, "task-cancelled", agentId, { taskId, title: task.title });
  reg.notice(session, `task ${task.id} ("${task.title}") cancelled`);
  for (const t of session.tasks) {
    if (t.status === "blocked" && unmetDependencies(session, t).length === 0) {
      t.status = "todo";
      t.updatedAt = now();
      reg.notice(session, `task ${t.id} ("${t.title}") is unblocked — its dependency was cancelled`);
    }
  }
  return { ok: true };
}

export function unmetDependencies(session: Session, task: Task): string[] {
  return (task.dependsOn ?? []).filter((dep) => session.tasks.find((t) => t.id === dep)?.status !== "done");
}

/**
 * Move a task through the board, enforcing the gates:
 *  - in-progress requires all dependsOn tasks done (else → blocked, V2 #1)
 *  - review requires a submitted diff, and a passed test result when
 *    requiresTests is set (V3 #7)
 *  - done requires an approved review (V2 #3) and passing CI when
 *    requiresCI is set (V3 #3)
 */
export function moveTask(
  reg: Registry,
  session: Session,
  taskId: string,
  status: TaskStatus,
  agentId?: string
): { ok: boolean; status?: TaskStatus; error?: string } {
  const task = session.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: "no such task" };
  if (!VALID_STATUSES.includes(status)) return { ok: false, error: `invalid status "${status}"` };
  // Idempotent: re-moving a task to its current status must not repeat side
  // effects (a second done→done would double-count reputation and fleet stats).
  if (task.status === status) return { ok: true, status };

  if (status === "in-progress") {
    const unmet = unmetDependencies(session, task);
    if (unmet.length > 0) {
      task.status = "blocked";
      task.updatedAt = now();
      reg.event(session, "task-blocked", agentId, { taskId, unmet });
      reg.notice(session, `task ${task.id} ("${task.title}") is blocked on: ${unmet.join(", ")}`);
      return { ok: true, status: "blocked" };
    }
  }

  if (status === "review") {
    if (!session.reviews.some((r) => r.taskId === taskId)) {
      return { ok: false, error: "moving to review requires a submitted diff — run `meetroom review submit <task-id>` first" };
    }
    if (task.requiresTests && task.testResult !== "passed") {
      return {
        ok: false,
        error:
          task.testResult === "failed"
            ? "tests failed — fix and re-report with `meetroom test report`"
            : "task requires a test result before review — run `meetroom test report <task-id> passed|failed`",
      };
    }
  }

  if (status === "done") {
    const reviews = session.reviews.filter((r) => r.taskId === taskId);
    const approved = reviews.find((r) => r.status === "approved");
    if (!approved) {
      return { ok: false, error: "task cannot move to done without an approved review" };
    }
    // V6 #3 — repo policy can only add requirements, never relax them.
    const violations = policyViolations(session, task, reg.dataDir);
    if (violations.length) {
      return { ok: false, error: `blocked by policy: ${violations.join("; ")}` };
    }
    // V8 #7 — outcome verification gates done when the task declares a goal test.
    if (task.verify && !task.verifyResult?.passed) {
      return { ok: false, error: "task has a verify command that hasn't passed — run `meetroom verify run <task-id>`" };
    }
    if (session.config.requirePrMergeForDone && approved.prUrl && !prMergedFlag(session, taskId)) {
      return { ok: false, error: "session requires the PR to be merged before done (report with `meetroom ci report` or `meetroom review pr-merged`)" };
    }
    if (task.requiresCI) {
      const ci = session.ciStatuses.find((c) => c.taskId === taskId);
      if (!ci || ci.status !== "passed") {
        return { ok: false, error: `task requires CI to pass (current: ${ci?.status ?? "no status reported"})` };
      }
    }
    task.doneAt = now();
  }

  task.status = status;
  task.updatedAt = now();
  reg.event(session, "task-move", agentId, { taskId, status });
  if (status === "done") {
    updateReputationOnTaskDone(reg, session, task);
    // V8 #5 — opt-in fleet stats (identity/complexity/turnaround/rework only).
    recordFleetStat(session, task, session.reviews.filter((r) => r.taskId === task.id && r.status === "changes-requested").length);
    unblockDependents(reg, session, task.id);
  }
  return { ok: true, status };
}

function prMergedFlag(session: Session, taskId: string): boolean {
  return session.events.some((e) => e.type === "pr-merged" && e.data?.taskId === taskId);
}

/** When a task completes, nudge tasks that were blocked on it. */
function unblockDependents(reg: Registry, session: Session, doneTaskId: string): void {
  for (const t of session.tasks) {
    if (t.status === "blocked" && t.dependsOn?.includes(doneTaskId) && unmetDependencies(session, t).length === 0) {
      t.status = "todo";
      t.updatedAt = now();
      reg.notice(session, `task ${t.id} ("${t.title}") is unblocked — all dependencies done`);
    }
  }
}

export function reportTestResult(
  reg: Registry,
  session: Session,
  taskId: string,
  result: "passed" | "failed",
  agentId?: string
): { ok: boolean; error?: string } {
  const task = session.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: "no such task" };
  task.testResult = result;
  task.updatedAt = now();
  reg.event(session, "test-result", agentId, { taskId, result });
  if (result === "failed") reg.notice(session, `tests FAILED for task ${taskId} ("${task.title}")`);
  return { ok: true };
}

// V3 #3 — CI/CD hook: daemon receives status via generic webhook or CLI report.
export function reportCIStatus(
  reg: Registry,
  session: Session,
  taskId: string,
  status: "pending" | "passed" | "failed",
  provider: "github-actions" | "gitlab-ci" | "generic-webhook" = "generic-webhook",
  url?: string
): { ok: boolean; error?: string } {
  const task = session.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: "no such task" };
  let ci = session.ciStatuses.find((c) => c.taskId === taskId);
  if (!ci) {
    ci = { taskId, provider, status, url, updatedAt: now() };
    session.ciStatuses.push(ci);
  } else {
    ci.provider = provider;
    ci.status = status;
    ci.url = url ?? ci.url;
    ci.updatedAt = now();
  }
  reg.event(session, status === "failed" ? "ci-failed" : "ci-status", undefined, { taskId, status, url });
  if (status === "failed") {
    reg.notice(session, `CI FAILED for task ${taskId} ("${task.title}")${url ? ` — ${url}` : ""}`);
  }
  return { ok: true };
}
