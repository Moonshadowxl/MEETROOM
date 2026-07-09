import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/daemon/registry.js";
import {
  agentBudgetBlocked,
  checkBudgets,
  cronMatches,
  heartbeat,
  setBudget,
  sweepLiveness,
  writeArtifact,
} from "../src/daemon/ops.js";
import type { Agent, Session } from "../src/shared/types.js";

function setup(): { reg: Registry; session: Session; a: Agent } {
  const reg = new Registry(mkdtempSync(join(tmpdir(), "meetroom-test-")));
  const session = reg.createSession({ type: "sxl", cwd: mkdtempSync(join(tmpdir(), "meetroom-proj-")) });
  const a: Agent = {
    id: "agent-a",
    name: "alice",
    role: "Implementer",
    identity: "alice",
    status: "active",
    joinedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  session.agents.push(a);
  return { reg, session, a };
}

test("budget breach pauses the room and lands in the attention queue", () => {
  const { reg, session, a } = setup();
  setBudget(reg, session, { scope: "session", maxCostUsd: 1, onBreach: "pause-room" });
  session.usage.push({ agentId: a.id, tokensIn: 100, tokensOut: 100, costUsd: 1.5 });
  checkBudgets(reg, session);
  assert.equal(session.status, "paused");
  const items = reg.listAttention();
  assert.ok(items.some((i) => i.kind === "budget-breach" && i.sessionId === session.id));
});

test("agent-scope budget blocks only that agent, and only after breach", () => {
  const { reg, session, a } = setup();
  setBudget(reg, session, { scope: "agent", agentId: a.id, maxTokens: 100, onBreach: "pause-agent" });
  assert.equal(agentBudgetBlocked(session, a.id), false);
  session.usage.push({ agentId: a.id, tokensIn: 80, tokensOut: 40, costUsd: 0 });
  checkBudgets(reg, session);
  assert.equal(agentBudgetBlocked(session, a.id), true);
  assert.equal(agentBudgetBlocked(session, "someone-else"), false);
  assert.equal(session.status, "active"); // room keeps going
});

test("liveness: silent agent goes idle, then disconnected with task reassignment", () => {
  const { reg, session, a } = setup();
  session.config.stallMinutes = 15;
  session.tasks.push({
    id: "task-1",
    title: "t",
    description: "",
    status: "in-progress",
    assignedAgentId: a.id,
    files: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  a.lastSeenAt = new Date(Date.now() - 16 * 60_000).toISOString();
  sweepLiveness(reg, session);
  assert.equal(a.status, "idle");

  a.lastSeenAt = new Date(Date.now() - 31 * 60_000).toISOString();
  sweepLiveness(reg, session);
  assert.equal(a.status, "disconnected");
  const task = session.tasks[0];
  assert.equal(task.status, "todo");
  assert.equal(task.assignedAgentId, undefined);
  assert.deepEqual(task.reassignedFrom, [a.id]);

  // A heartbeat (any CLI call) brings the agent back.
  heartbeat(session, a.id);
  assert.equal(a.status, "active");
});

test("artifacts use optimistic versioning", () => {
  const { reg, session, a } = setup();
  const w1 = writeArtifact(reg, session, { name: "api-design.md", content: "v1", agentId: a.id });
  assert.ok(w1.ok);
  const conflict = writeArtifact(reg, session, { name: "api-design.md", content: "v2", agentId: a.id, expectedVersion: 99 });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.current?.version, 1);
  const w2 = writeArtifact(reg, session, { name: "api-design.md", content: "v2", agentId: a.id, expectedVersion: 1 });
  assert.ok(w2.ok && w2.artifact.version === 2);
});

test("cron matcher handles *, exact values, steps, and lists", () => {
  const d = new Date("2026-07-09T02:30:00"); // Thursday (dow 4), July 9, 02:30
  assert.equal(cronMatches("* * * * *", d), true);
  assert.equal(cronMatches("30 2 * * *", d), true);
  assert.equal(cronMatches("0 2 * * *", d), false);
  assert.equal(cronMatches("*/10 * * * *", d), true);
  assert.equal(cronMatches("*/7 * * * *", d), false);
  assert.equal(cronMatches("30 2 9 7 4", d), true);
  assert.equal(cronMatches("30 2 * * 0,4", d), true);
  assert.equal(cronMatches("bogus", d), false);
});

test("audit chain verifies and detects tampering", () => {
  const { reg, session } = setup();
  reg.event(session, "one");
  reg.event(session, "two");
  reg.event(session, "three");
  assert.equal(Registry.verifyAuditChain(session), -1);
  session.events[session.events.length - 2].type = "two-edited";
  assert.notEqual(Registry.verifyAuditChain(session), -1);
});

test("attention items dedupe while open", () => {
  const { reg, session } = setup();
  reg.addAttention(session.id, "escalation", "same thing");
  reg.addAttention(session.id, "escalation", "same thing");
  assert.equal(reg.listAttention().filter((i) => i.summary === "same thing").length, 1);
});
