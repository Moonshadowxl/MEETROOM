import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Registry } from "../src/daemon/registry.js";
import {
  inviteOperator,
  loadSecrets,
  operatorAllowed,
  pathMatches,
  policyViolations,
  redactSecrets,
  resolveSecrets,
  saveSecrets,
} from "../src/daemon/trust.js";
import { createTask, moveTask } from "../src/daemon/tasks.js";
import { decideReview, submitReview } from "../src/daemon/reviews.js";
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

test("operators: solo mode allows everything; roles gate once configured", () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), "meetroom-test-")), "sessions");
  assert.equal(operatorAllowed(dataDir, undefined, "owner").ok, true); // solo mode

  const { key } = inviteOperator(dataDir, "dana", "reviewer");
  assert.equal(operatorAllowed(dataDir, undefined, "maintainer").ok, false); // key now required
  assert.equal(operatorAllowed(dataDir, key, "reviewer").ok, true);
  assert.equal(operatorAllowed(dataDir, key, "owner").ok, false); // insufficient role
  assert.equal(operatorAllowed(dataDir, "wrong-key", "observer").ok, false);
});

test("policy engine blocks done until repo rules are satisfied", () => {
  const { reg, session, a, b } = setup();
  mkdirSync(join(session.cwd, ".meetroom"), { recursive: true });
  writeFileSync(
    join(session.cwd, ".meetroom", "policy.json"),
    JSON.stringify([{ id: "payments-guard", match: { paths: ["src/payments/**"] }, require: ["human-review"] }])
  );

  const r = createTask(reg, session, { title: "touch payments", files: ["src/payments/charge.ts"] });
  const task = (r as { ok: true; task: Task }).task;
  const rev = submitReview(reg, session, { taskId: task.id, authorAgentId: a.id, diff: "+++ x" });
  decideReview(reg, session, (rev as any).review.id, b.id, "approved"); // agent approval isn't enough
  moveTask(reg, session, task.id, "review", a.id);

  const denied = moveTask(reg, session, task.id, "done", a.id);
  assert.equal(denied.ok, false);
  assert.match(denied.error!, /policy/);

  // Human approval satisfies the rule.
  const rev2 = submitReview(reg, session, { taskId: task.id, authorAgentId: a.id, diff: "+++ y" });
  decideReview(reg, session, (rev2 as any).review.id, "human", "approved");
  assert.equal(moveTask(reg, session, task.id, "done", a.id).ok, true);
});

test("pathMatches supports prefix globs, suffix globs, and exact paths", () => {
  assert.equal(pathMatches("src/payments/**", "src/payments/charge.ts"), true);
  assert.equal(pathMatches("src/payments/**", "src/auth/login.ts"), false);
  assert.equal(pathMatches("*.sql", "db/migrations/001.sql"), true);
  assert.equal(pathMatches("README.md", "README.md"), true);
});

test("secrets: encrypted round-trip, template resolution, chat redaction", () => {
  saveSecrets({ GITHUB_TOKEN: "ghp_supersecret123" });
  assert.deepEqual(Object.keys(loadSecrets()), ["GITHUB_TOKEN"]);
  assert.equal(resolveSecrets("curl -H 'auth: {secret:GITHUB_TOKEN}'"), "curl -H 'auth: ghp_supersecret123'");
  assert.throws(() => resolveSecrets("{secret:MISSING}"));

  const { reg, session, a } = setup();
  reg.chat(session, { agentId: a.id, message: "use ghp_supersecret123 for the API" });
  const last = session.chatLog[session.chatLog.length - 1];
  assert.equal(last.message.includes("ghp_supersecret123"), false);
  assert.match(last.message, /\[redacted:GITHUB_TOKEN\]/);
});

test("verify gate blocks done until the goal test passes", () => {
  const { reg, session, a, b } = setup();
  const r = createTask(reg, session, { title: "verified task" });
  const task = (r as { ok: true; task: Task }).task;
  task.verify = { command: "true" };
  const rev = submitReview(reg, session, { taskId: task.id, authorAgentId: a.id, diff: "+++ x" });
  decideReview(reg, session, (rev as any).review.id, b.id, "approved");
  moveTask(reg, session, task.id, "review", a.id);

  const denied = moveTask(reg, session, task.id, "done", a.id);
  assert.equal(denied.ok, false);
  assert.match(denied.error!, /verify/);

  task.verifyResult = { passed: true, output: "", at: new Date().toISOString() };
  assert.equal(moveTask(reg, session, task.id, "done", a.id).ok, true);
});
