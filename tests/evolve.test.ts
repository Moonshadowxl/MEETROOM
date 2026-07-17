import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/daemon/registry.js";
import {
  agentActionAllowed,
  createEpic,
  epicStatus,
  generateRetro,
  queueAction,
  sweepPendingActions,
  sweepSelfHealing,
  vetoAction,
} from "../src/daemon/evolve.js";
import { createTask } from "../src/daemon/tasks.js";
import { claimFile } from "../src/daemon/fileClaims.js";
import type { Agent, Session, Task } from "../src/shared/types.js";

process.env.MEETROOM_HOME = mkdtempSync(join(tmpdir(), "meetroom-home-"));

function setup(): { reg: Registry; session: Session; a: Agent; b: Agent } {
  const reg = new Registry(join(mkdtempSync(join(tmpdir(), "meetroom-test-")), "sessions"));
  const session = reg.createSession({ cwd: mkdtempSync(join(tmpdir(), "meetroom-proj-")) });
  const mk = (name: string): Agent => ({
    id: `agent-${name}`,
    name,
    role: "Implementer",
    identity: name,
    status: "active",
    joinedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  });
  const a = mk("alice");
  const b = mk("bob");
  session.agents.push(a, b);
  return { reg, session, a, b };
}

test("autonomy L0 blocks agent work but never the human", () => {
  const { session, a } = setup();
  session.config.autonomy = { level: 0, vetoWindowMinutes: 10 };
  assert.equal(agentActionAllowed(session, a.id).ok, false);
  assert.equal(agentActionAllowed(session, "human").ok, true);
  session.config.autonomy = { level: 1, vetoWindowMinutes: 10 };
  assert.equal(agentActionAllowed(session, a.id).ok, true);
});

test("pending actions execute after the veto window unless vetoed", () => {
  const { reg, session } = setup();
  session.config.autonomy = { level: 3, vetoWindowMinutes: 0 }; // window closes immediately
  const p = { id: "prop-x", authorId: "agent-alice", content: "do it", objections: [], status: "escalated" as const, createdAt: new Date().toISOString() };
  session.proposals.push(p);

  const action = queueAction(reg, session, "resolve-proposal", { proposalId: "prop-x" }, "clear consensus in chat");
  action.executeAt = new Date(Date.now() - 1000).toISOString();
  sweepPendingActions(reg, session);
  assert.equal(action.status, "executed");
  assert.equal(p.status, "resolved");

  // Vetoed actions never execute.
  const action2 = queueAction(reg, session, "pause-room", {}, "budget looks off");
  vetoAction(reg, session, action2.id);
  action2.executeAt = new Date(Date.now() - 1000).toISOString();
  sweepPendingActions(reg, session);
  assert.equal(action2.status, "vetoed");
  assert.equal(session.status, "active");
});

test("retro computes stats and suggests fixes for pathologies", () => {
  const { reg, session, a } = setup();
  for (let i = 0; i < 3; i++) reg.event(session, "claim-timeout", a.id, { filepath: `f${i}` });
  session.reviews.push(
    { id: "r1", taskId: "t", authorAgentId: a.id, diff: "x", status: "changes-requested", comments: [], createdAt: "", updatedAt: "" },
    { id: "r2", taskId: "t", authorAgentId: a.id, diff: "x", status: "approved", comments: [], createdAt: "", updatedAt: "" }
  );
  const retro = generateRetro(session);
  assert.equal(retro.stats.claimTimeouts, 3);
  assert.equal(retro.stats.reviewBounceRate, 50);
  assert.ok(retro.suggestions.some((s) => s.includes("claim timeout")));
  assert.ok(retro.suggestions.some((s) => s.includes("bounce")));
});

test("epics link tasks across sessions and report progress", () => {
  const { reg, session } = setup();
  const epic = createEpic(session.cwd, "Postgres migration", "everything reads from PG");
  const r1 = createTask(reg, session, { title: "write schema", epicId: epic.id });
  assert.ok(r1.ok);
  const t1 = (r1 as { ok: true; task: Task }).task;
  t1.status = "done";
  createTask(reg, session, { title: "migrate reads", epicId: epic.id });

  const status = epicStatus(reg, session.cwd, epic.id)!;
  assert.equal(status.total, 2);
  assert.equal(status.done, 1);
  assert.equal(status.open.length, 1);

  // Unknown epic is rejected at task creation.
  const bad = createTask(reg, session, { title: "x", epicId: "epic-nope" });
  assert.equal(bad.ok, false);
});

test("self-healing flags fully-blocked boards and claim deadlocks", () => {
  const { reg, session, a, b } = setup();
  const r = createTask(reg, session, { title: "stuck" });
  (r as { ok: true; task: Task }).task.status = "blocked";
  sweepSelfHealing(reg, session);
  assert.ok(reg.listAttention().some((i) => i.kind === "deadlock" && i.summary.includes("blocked")));

  // A ⇄ B waitlist cycle.
  claimFile(reg, session, a.id, "one.ts");
  claimFile(reg, session, b.id, "two.ts");
  claimFile(reg, session, b.id, "one.ts", true);
  claimFile(reg, session, a.id, "two.ts", true);
  sweepSelfHealing(reg, session);
  assert.ok(reg.listAttention().some((i) => i.kind === "deadlock" && i.summary.includes("waiting on each other")));
});
