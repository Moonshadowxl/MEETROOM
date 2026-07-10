import type { Review, Session } from "../shared/types.js";
import { entityId, now } from "../shared/ids.js";
import type { Registry } from "./registry.js";
import { runReviewCopilot } from "./intelligence.js";

// V2 #3 — diff-based review gate. A task can't reach `done` without an
// approved review, and agents can never review their own diffs.

export function submitReview(
  reg: Registry,
  session: Session,
  opts: {
    taskId: string;
    authorAgentId: string;
    diff: string;
    authorConfidence?: "low" | "medium" | "high";
    prUrl?: string;
  }
): { ok: true; review: Review } | { ok: false; error: string } {
  const task = session.tasks.find((t) => t.id === opts.taskId);
  if (!task) return { ok: false, error: "no such task" };
  if (!opts.diff.trim()) return { ok: false, error: "empty diff — nothing to review" };
  const review: Review = {
    id: entityId("rev"),
    taskId: opts.taskId,
    authorAgentId: opts.authorAgentId,
    diff: opts.diff,
    status: "pending",
    comments: [],
    authorConfidence: opts.authorConfidence,
    prUrl: opts.prUrl,
    createdAt: now(),
    updatedAt: now(),
  };
  session.reviews.push(review);
  runReviewCopilot(reg, session, review); // V5 #3 — first-pass triage (no-op without MEETROOM_REVIEWER)
  reg.event(session, "review-requested", opts.authorAgentId, {
    reviewId: review.id,
    taskId: opts.taskId,
    confidence: opts.authorConfidence,
    prUrl: opts.prUrl,
  });
  const confidenceNote =
    opts.authorConfidence === "low" ? " (author confidence: LOW — needs close scrutiny / human review)" : "";
  reg.notice(session, `review ${review.id} submitted for task ${opts.taskId}${confidenceNote}`);
  return { ok: true, review };
}

export function decideReview(
  reg: Registry,
  session: Session,
  reviewId: string,
  reviewerAgentId: string,
  decision: "approved" | "changes-requested",
  comment?: string
): { ok: boolean; error?: string } {
  const review = session.reviews.find((r) => r.id === reviewId);
  if (!review) return { ok: false, error: "no such review" };
  // The reviewer must actually exist — otherwise the self-review gate can be
  // bypassed by passing any made-up agentId.
  if (reviewerAgentId !== "human" && !session.agents.some((a) => a.id === reviewerAgentId)) {
    return { ok: false, error: "unknown reviewer: reviews must come from a joined agent or the human" };
  }
  // Self-review is rejected by the daemon to keep the gate meaningful (V2 #3).
  if (review.authorAgentId === reviewerAgentId) {
    return { ok: false, error: "self-review rejected: another agent (or the human) must review this diff" };
  }
  // V3 #6 — low-confidence submissions require the human specifically.
  if (review.authorConfidence === "low" && decision === "approved" && reviewerAgentId !== "human") {
    return { ok: false, error: "low-confidence submission: approval requires human review" };
  }
  review.reviewerAgentId = reviewerAgentId;
  review.status = decision;
  review.updatedAt = now();
  if (comment) review.comments.push({ agentId: reviewerAgentId, text: comment, ts: now() });
  reg.event(session, `review-${decision}`, reviewerAgentId, { reviewId, taskId: review.taskId });
  reg.notice(session, `review ${reviewId} ${decision}${comment ? `: ${comment}` : ""}`);
  return { ok: true };
}

export function commentOnReview(
  reg: Registry,
  session: Session,
  reviewId: string,
  agentId: string,
  text: string,
  line?: number
): { ok: boolean; error?: string } {
  const review = session.reviews.find((r) => r.id === reviewId);
  if (!review) return { ok: false, error: "no such review" };
  review.comments.push({ agentId, line, text, ts: now() });
  review.updatedAt = now();
  reg.event(session, "review-comment", agentId, { reviewId, line });
  return { ok: true };
}

// V3 #2 — PR status sync (webhook or manual report): approval on the PR marks
// the meetroom review approved; merge is recorded for the done-gate.
export function syncPrStatus(
  reg: Registry,
  session: Session,
  reviewId: string,
  prState: "approved" | "changes-requested" | "merged"
): { ok: boolean; error?: string } {
  const review = session.reviews.find((r) => r.id === reviewId);
  if (!review) return { ok: false, error: "no such review" };
  if (prState === "merged") {
    if (review.status === "pending") review.status = "approved";
    review.updatedAt = now();
    reg.event(session, "pr-merged", undefined, { reviewId, taskId: review.taskId });
    reg.notice(session, `PR for review ${reviewId} merged`);
    return { ok: true };
  }
  review.status = prState;
  review.reviewerAgentId = review.reviewerAgentId ?? "pr";
  review.updatedAt = now();
  reg.event(session, `review-${prState}`, "pr", { reviewId, taskId: review.taskId, source: "pr" });
  reg.notice(session, `PR review sync: review ${reviewId} is now ${prState}`);
  return { ok: true };
}
