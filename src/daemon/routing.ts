import type { Session, Task } from "../shared/types.js";
import { loadReputation } from "./reputation.js";

// V3 #4 — cost/capability-aware routing. Lightweight keyword classification
// (no LLM call required; deterministic and free). Suggestions only — agents
// and the human still decide.

const COMPLEX_HINTS = /\b(architect|architecture|redesign|migrat|refactor|rewrite|protocol|concurren|distributed|security|auth)\b/i;
const TRIVIAL_HINTS = /\b(typo|rename|comment|readme|doc|docs|bump|format|lint|whitespace|copy)\b/i;

export function estimateComplexity(task: Pick<Task, "title" | "description" | "files">): Task["estimatedComplexity"] {
  const text = `${task.title} ${task.description}`;
  if (COMPLEX_HINTS.test(text) || task.files.length > 5) return "complex";
  if (TRIVIAL_HINTS.test(text) && task.files.length <= 2) return "trivial";
  return "moderate";
}

const TIER_FOR_COMPLEXITY: Record<NonNullable<Task["estimatedComplexity"]>, "low" | "medium" | "high"> = {
  trivial: "low",
  moderate: "medium",
  complex: "high",
};

const TIER_RANK = { low: 0, medium: 1, high: 2 } as const;

/**
 * Pick the cheapest capable agent: strength matches, cost tier at-or-above
 * what the complexity calls for, lightest load — blended (V5 #4) with the
 * agent's track record (reputation) and recent stall history. Learned signals
 * only nudge; they never override an explicit strength/tier mismatch.
 */
export function suggestAgent(session: Session, task: Task): string | undefined {
  const candidates = session.agents.filter((a) => a.status !== "disconnected");
  if (candidates.length === 0) return undefined;
  const wantTier = TIER_FOR_COMPLEXITY[task.estimatedComplexity ?? "moderate"];
  const text = `${task.title} ${task.description}`.toLowerCase();
  const reputation = loadReputation(session.cwd);

  const scored = candidates.map((a) => {
    let score = 0;
    for (const s of a.strengths ?? []) {
      if (text.includes(s.toLowerCase())) score += 3;
    }
    const tier = a.costTier ?? "medium";
    if (tier === wantTier) score += 2;
    else if (TIER_RANK[tier] > TIER_RANK[wantTier]) score += 1; // capable but pricier
    else score -= 1; // possibly under-powered for the task
    score -= session.tasks.filter(
      (t) => t.assignedAgentId === a.id && (t.status === "in-progress" || t.status === "review")
    ).length; // load balancing
    // V5 #4 — track record: clean review pass rate helps, heavy rework hurts.
    const rep = reputation.find((r) => r.agentIdentity === a.identity);
    if (rep && rep.tasksCompleted >= 2) {
      score += (rep.reviewPassRate - 50) / 50; // [-1, +1]
      score -= Math.min(1, rep.avgReworkCount / 2);
    }
    // Recent stalls/disconnects this session make an agent a worse bet.
    const stalls = session.events.filter(
      (e) => (e.type === "agent-stalled" || e.type === "agent-disconnected") && e.agentId === a.id
    ).length;
    score -= Math.min(2, stalls);
    return { agent: a, score };
  });
  scored.sort((x, y) => y.score - x.score);
  return scored[0].agent.id;
}
