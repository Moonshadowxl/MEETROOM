import { execFileSync } from "node:child_process";
import type { DraftPlan, Session } from "../shared/types.js";
import { entityId, now } from "../shared/ids.js";
import type { Registry } from "./registry.js";
import { loadMemory } from "./memory.js";
import { createTask } from "./tasks.js";

// V3 #13 — natural-language task decomposition. A draft board is generated
// from a feature description (via a configurable planner command, or a
// deterministic fallback) and NEVER goes live without explicit approval.

export function createDraftPlan(reg: Registry, session: Session, description: string): DraftPlan {
  const tasks = runPlanner(session, description) ?? heuristicDecompose(description);
  const plan: DraftPlan = {
    id: entityId("plan"),
    description,
    tasks,
    status: "draft",
    createdAt: now(),
  };
  session.draftPlans.push(plan);
  reg.event(session, "plan-drafted", undefined, { planId: plan.id, taskCount: tasks.length });
  return plan;
}

/**
 * If MEETROOM_PLANNER is set (e.g. an LLM CLI), pipe it the description plus
 * project memory and expect a JSON array of {title, description, files,
 * dependsOnIndex} back. Any failure falls back to the heuristic.
 */
function runPlanner(session: Session, description: string): DraftPlan["tasks"] | undefined {
  const cmd = process.env.MEETROOM_PLANNER;
  if (!cmd) return undefined;
  try {
    const memory = loadMemory(session.cwd);
    const input = JSON.stringify({ description, memory, instructions: "Return a JSON array of tasks: {title, description, files, dependsOnIndex}" });
    const out = execFileSync("sh", ["-c", cmd], { input, encoding: "utf8", timeout: 120_000 });
    const parsed = JSON.parse(out) as DraftPlan["tasks"];
    if (Array.isArray(parsed) && parsed.every((t) => typeof t.title === "string")) {
      return parsed.map((t) => ({ ...t, description: t.description ?? "", files: t.files ?? [] }));
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** No planner configured: split the description into sequential steps. */
function heuristicDecompose(description: string): DraftPlan["tasks"] {
  const parts = description
    .split(/(?:\n|;|\d+\.\s|(?<=\.)\s+(?=[A-Z]))/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
  const steps = parts.length > 1 ? parts : [description];
  return steps.map((step, i) => ({
    title: step.length > 72 ? `${step.slice(0, 69)}...` : step,
    description: step,
    files: [],
    dependsOnIndex: i > 0 ? [i - 1] : undefined,
  }));
}

/** Approve a draft: only now do tasks land on the live board. */
export function approvePlan(reg: Registry, session: Session, planId: string): { ok: boolean; taskIds?: string[]; error?: string } {
  const plan = session.draftPlans.find((p) => p.id === planId);
  if (!plan) return { ok: false, error: "no such draft plan" };
  if (plan.status !== "draft") return { ok: false, error: `plan is ${plan.status}` };
  const taskIds: string[] = [];
  for (const t of plan.tasks) {
    const dependsOn = (t.dependsOnIndex ?? []).map((i) => taskIds[i]).filter(Boolean);
    const res = createTask(reg, session, { title: t.title, description: t.description, files: t.files, dependsOn });
    if (res.ok) taskIds.push(res.task.id);
  }
  plan.status = "approved";
  reg.event(session, "plan-approved", undefined, { planId, taskIds });
  reg.notice(session, `plan ${planId} approved — ${taskIds.length} tasks created`);
  return { ok: true, taskIds };
}

export function discardPlan(reg: Registry, session: Session, planId: string): { ok: boolean; error?: string } {
  const plan = session.draftPlans.find((p) => p.id === planId);
  if (!plan) return { ok: false, error: "no such draft plan" };
  plan.status = "discarded";
  reg.save(session);
  return { ok: true };
}
