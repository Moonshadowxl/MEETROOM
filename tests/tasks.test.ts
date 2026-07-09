import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/daemon/registry.js";
import { claimTask, createTask, moveTask, reportCIStatus, reportTestResult } from "../src/daemon/tasks.js";
import { decideReview, submitReview } from "../src/daemon/reviews.js";
import { loadReputation } from "../src/daemon/reputation.js";
import type { Agent, Session, Task } from "../src/shared/types.js";

function setup(): { reg: Registry; session: Session; a: Agent; b: Agent } {
  const reg = new Registry(join(mkdtempSync(join(tmpdir(), "meetroom-test-")), "sessions"));
  const session = reg.createSession({ type: "sxl", cwd: mkdtempSync(join(tmpdir(), "meetroom-proj-")) });
  const mk = (name: string, tier?: Agent["costTier"], strengths?: string[]): Agent => ({
    id: `agent-${name}`,
    name,
    role: "Implementer",
    identity: name,
    status: "active",
    costTier: tier,
    strengths,
    joinedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  });
  const a = mk("alice", "high", ["architecture"]);
  const b = mk("bob", "low", ["test-writing"]);
  session.agents.push(a, b);
  return { reg, session, a, b };
}

function mkTask(reg: Registry, session: Session, title: string, opts: Partial<Parameters<typeof createTask>[2]> = {}): Task {
  const r = createTask(reg, session, { title, ...opts });
  assert.ok(r.ok);
  return (r as { ok: true; task: Task }).task;
}

function submitAndApprove(reg: Registry, session: Session, taskId: string, author: string, reviewer: string): void {
  const rev = submitReview(reg, session, { taskId, authorAgentId: author, diff: "--- a\n+++ b\n+x" });
  assert.ok(rev.ok);
  const decided = decideReview(reg, session, (rev as any).review.id, reviewer, "approved");
  assert.equal(decided.ok, true);
}

test("claiming a task auto-claims its files", () => {
  const { reg, session, a } = setup();
  const t = mkTask(reg, session, "build login", { files: ["auth.py", "routes.py"] });
  const r = claimTask(reg, session, t.id, a.id);
  assert.equal(r.ok, true);
  assert.deepEqual(session.claims.map((c) => c.filepath).sort(), ["auth.py", "routes.py"]);
});

test("task with unmet dependencies goes to blocked with a chat notice, then unblocks", () => {
  const { reg, session, a, b } = setup();
  const dep = mkTask(reg, session, "schema first");
  const t = mkTask(reg, session, "api second", { dependsOn: [dep.id] });
  const r = moveTask(reg, session, t.id, "in-progress", a.id);
  assert.equal(r.status, "blocked");
  assert.ok(session.chatLog.some((m) => m.message.includes("blocked on")));

  // Complete the dependency through the full gate.
  claimTask(reg, session, dep.id, a.id);
  moveTask(reg, session, dep.id, "in-progress", a.id);
  submitAndApprove(reg, session, dep.id, a.id, b.id);
  moveTask(reg, session, dep.id, "review", a.id);
  assert.equal(moveTask(reg, session, dep.id, "done", a.id).ok, true);
  assert.equal(session.tasks.find((x) => x.id === t.id)?.status, "todo");
});

test("review is required before the review column, approval before done", () => {
  const { reg, session, a, b } = setup();
  const t = mkTask(reg, session, "feature");
  claimTask(reg, session, t.id, a.id);
  moveTask(reg, session, t.id, "in-progress", a.id);

  const noDiff = moveTask(reg, session, t.id, "review", a.id);
  assert.equal(noDiff.ok, false);

  submitReview(reg, session, { taskId: t.id, authorAgentId: a.id, diff: "+++ x" });
  assert.equal(moveTask(reg, session, t.id, "review", a.id).ok, true);

  const noApproval = moveTask(reg, session, t.id, "done", a.id);
  assert.equal(noApproval.ok, false);
  assert.match(noApproval.error!, /approved review/);
});

test("self-review is rejected by the daemon", () => {
  const { reg, session, a } = setup();
  const t = mkTask(reg, session, "feature");
  const rev = submitReview(reg, session, { taskId: t.id, authorAgentId: a.id, diff: "+++ x" });
  assert.ok(rev.ok);
  const r = decideReview(reg, session, (rev as any).review.id, a.id, "approved");
  assert.equal(r.ok, false);
  assert.match(r.error!, /self-review/);
});

test("low-confidence submissions need the human to approve", () => {
  const { reg, session, a, b } = setup();
  const t = mkTask(reg, session, "sketchy change");
  const rev = submitReview(reg, session, { taskId: t.id, authorAgentId: a.id, diff: "+++ x", authorConfidence: "low" });
  assert.ok(rev.ok);
  const id = (rev as any).review.id;
  assert.equal(decideReview(reg, session, id, b.id, "approved").ok, false);
  assert.equal(decideReview(reg, session, id, b.id, "changes-requested", "hmm").ok, true);
  const rev2 = submitReview(reg, session, { taskId: t.id, authorAgentId: a.id, diff: "+++ y", authorConfidence: "low" });
  assert.equal(decideReview(reg, session, (rev2 as any).review.id, "human", "approved").ok, true);
});

test("requiresCI blocks done until CI passes; failures notify the room", () => {
  const { reg, session, a, b } = setup();
  const t = mkTask(reg, session, "ci-gated", { requiresCI: true });
  claimTask(reg, session, t.id, a.id);
  moveTask(reg, session, t.id, "in-progress", a.id);
  submitAndApprove(reg, session, t.id, a.id, b.id);
  moveTask(reg, session, t.id, "review", a.id);

  assert.equal(moveTask(reg, session, t.id, "done", a.id).ok, false);
  reportCIStatus(reg, session, t.id, "failed", "github-actions", "https://ci/run/1");
  assert.ok(session.chatLog.some((m) => m.message.includes("CI FAILED")));
  assert.equal(moveTask(reg, session, t.id, "done", a.id).ok, false);
  reportCIStatus(reg, session, t.id, "passed");
  assert.equal(moveTask(reg, session, t.id, "done", a.id).ok, true);
});

test("requiresTests gates the review column (QA gate)", () => {
  const { reg, session, a } = setup();
  const t = mkTask(reg, session, "qa-gated", { requiresTests: true });
  submitReview(reg, session, { taskId: t.id, authorAgentId: a.id, diff: "+++ x" });
  assert.equal(moveTask(reg, session, t.id, "review", a.id).ok, false);
  reportTestResult(reg, session, t.id, "failed", a.id);
  assert.equal(moveTask(reg, session, t.id, "review", a.id).ok, false);
  reportTestResult(reg, session, t.id, "passed", a.id);
  assert.equal(moveTask(reg, session, t.id, "review", a.id).ok, true);
});

test("routing estimates complexity and suggests a capable agent", () => {
  const { reg, session, a } = setup();
  const complex = mkTask(reg, session, "redesign auth architecture");
  assert.equal(complex.estimatedComplexity, "complex");
  assert.equal(complex.suggestedAgentId, a.id); // high tier + architecture strength

  const trivial = mkTask(reg, session, "fix typo in readme");
  assert.equal(trivial.estimatedComplexity, "trivial");
});

test("completing a task updates the assignee's reputation file", () => {
  const { reg, session, a, b } = setup();
  const t = mkTask(reg, session, "rep task");
  claimTask(reg, session, t.id, a.id);
  moveTask(reg, session, t.id, "in-progress", a.id);
  submitAndApprove(reg, session, t.id, a.id, b.id);
  moveTask(reg, session, t.id, "review", a.id);
  moveTask(reg, session, t.id, "done", a.id);

  const reps = loadReputation(session.cwd);
  const rep = reps.find((r) => r.agentIdentity === "alice");
  assert.ok(rep);
  assert.equal(rep!.tasksCompleted, 1);
  assert.equal(rep!.reviewPassRate, 100);
});
