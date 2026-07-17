import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Registry } from "../src/daemon/registry.js";
import { buildServer } from "../src/daemon/server.js";
import { assignTask, cancelTask, claimTask, createTask, editTask, moveTask } from "../src/daemon/tasks.js";
import { createProposal, objectToProposal, rejectProposal, resolveProposal } from "../src/daemon/resolution.js";
import type { Agent, Session } from "../src/shared/types.js";

function setup(agentCount = 2): { reg: Registry; session: Session; agents: Agent[] } {
  const reg = new Registry(join(mkdtempSync(join(tmpdir(), "meetroom-test-")), "sessions"));
  const session = reg.createSession({ cwd: mkdtempSync(join(tmpdir(), "meetroom-proj-")) });
  const agents: Agent[] = [];
  for (let i = 0; i < agentCount; i++) {
    const a: Agent = {
      id: `agent-${i}`,
      name: `agent-${i}`,
      role: "Implementer",
      identity: `agent-${i}`,
      status: "active",
      joinedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    agents.push(a);
    session.agents.push(a);
  }
  return { reg, session, agents };
}

function mustCreate(reg: Registry, session: Session, opts: Parameters<typeof createTask>[2]) {
  const r = createTask(reg, session, opts);
  assert.ok(r.ok);
  return (r as { ok: true; task: import("../src/shared/types.js").Task }).task;
}

// ---- task lifecycle -------------------------------------------------------------

test("task assign / drop set and clear the assignee with history", () => {
  const { reg, session, agents } = setup(2);
  const t = mustCreate(reg, session, { title: "wire the login form" });

  assert.equal(assignTask(reg, session, t.id, "ghost", agents[0].id).ok, false); // unknown agent
  assert.ok(assignTask(reg, session, t.id, agents[1].id, agents[0].id).ok);
  assert.equal(t.assignedAgentId, agents[1].id);

  assert.ok(assignTask(reg, session, t.id, undefined, agents[0].id).ok); // drop
  assert.equal(t.assignedAgentId, undefined);
  assert.deepEqual(t.reassignedFrom, [agents[1].id]);
});

test("task edit updates fields, re-estimates complexity, and can clear verify", () => {
  const { reg, session } = setup(1);
  const t = mustCreate(reg, session, { title: "fix typo in readme", verify: { command: "true" } });
  assert.equal(t.estimatedComplexity, "trivial");

  const r = editTask(reg, session, t.id, { title: "redesign the auth architecture", verify: null });
  assert.ok(r.ok);
  assert.equal(t.title, "redesign the auth architecture");
  assert.equal(t.estimatedComplexity, "complex");
  assert.equal(t.verify, undefined);

  assert.equal(editTask(reg, session, t.id, { title: "  " }).ok, false); // empty title rejected
});

test("task cancel voids dependencies, unblocks dependents, and allows reopen", () => {
  const { reg, session, agents } = setup(2);
  const dep = mustCreate(reg, session, { title: "schema first" });
  const dependent = mustCreate(reg, session, { title: "api second", dependsOn: [dep.id] });

  moveTask(reg, session, dependent.id, "in-progress");
  assert.equal(dependent.status, "blocked");

  assert.ok(cancelTask(reg, session, dep.id, agents[0].id).ok);
  assert.equal(dep.status, "cancelled");
  assert.deepEqual(dependent.dependsOn, []);
  assert.equal(dependent.status, "todo"); // unblocked by the cancellation

  assert.equal(cancelTask(reg, session, dep.id).ok, false); // already cancelled
  assert.equal(claimTask(reg, session, dep.id, agents[0].id).ok, false); // can't claim cancelled

  // Reopen through the board.
  assert.ok(moveTask(reg, session, dep.id, "todo").ok);
  assert.equal(dep.status, "todo");
});

// ---- proposal reject / withdraw ---------------------------------------------------

test("human can reject any live proposal; author can only withdraw pre-vote", () => {
  const { reg, session, agents } = setup(2);
  const withdrawn = createProposal(reg, session, agents[0].id, "try approach A");
  assert.ok(rejectProposal(reg, session, withdrawn.id, agents[0].id, "changed my mind").ok);
  assert.equal(withdrawn.status, "rejected");

  const escalated = createProposal(reg, session, agents[0].id, "drop the ORM");
  objectToProposal(reg, session, escalated.id, agents[1].id, "risky");
  resolveProposal(reg, session, escalated.id, agents[0].id, "still want it");
  assert.equal(escalated.status, "escalated");
  assert.equal(rejectProposal(reg, session, escalated.id, agents[0].id).ok, false); // author locked out
  assert.ok(rejectProposal(reg, session, escalated.id, "human", "not this sprint").ok);
  assert.equal(escalated.status, "rejected");
  assert.equal(rejectProposal(reg, session, escalated.id, "human").ok, false); // terminal
});

// ---- registry event-log snapshotting ------------------------------------------------

test("events live in an append-only log; snapshots stay lean; reload verifies the audit chain", () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), "meetroom-test-")), "sessions");
  const reg = new Registry(dataDir);
  const session = reg.createSession({ cwd: mkdtempSync(join(tmpdir(), "meetroom-proj-")) });
  for (let i = 0; i < 5; i++) reg.event(session, "test-event", undefined, { i });

  const snapshot = JSON.parse(readFileSync(join(dataDir, `${session.id}.json`), "utf8"));
  assert.deepEqual(snapshot.events, []); // events not duplicated into the snapshot
  const logPath = join(dataDir, `${session.id}.events.ndjson`);
  assert.equal(readFileSync(logPath, "utf8").trim().split("\n").length, session.events.length);

  const reloaded = new Registry(dataDir).get(session.id)!;
  assert.equal(reloaded.events.length, session.events.length);
  assert.equal(Registry.verifyAuditChain(reloaded), -1);
});

test("legacy sessions with inline events migrate to the log on load", () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), "meetroom-test-")), "sessions");
  const reg = new Registry(dataDir);
  const session = reg.createSession({ cwd: mkdtempSync(join(tmpdir(), "meetroom-proj-")) });
  reg.event(session, "legacy-event");
  // Simulate a pre-snapshotting file: events inline, no ndjson log.
  const p = join(dataDir, `${session.id}.json`);
  writeFileSync(p, JSON.stringify({ ...session }, null, 2));
  const logPath = join(dataDir, `${session.id}.events.ndjson`);
  rmSync(logPath);

  const reloaded = new Registry(dataDir).get(session.id)!;
  assert.ok(reloaded.events.some((e) => e.type === "legacy-event"));
  assert.ok(existsSync(logPath)); // flushed to the log for future appends
});

// ---- HTTP: new routes + operator-gated human say -----------------------------------

const reg = new Registry(join(mkdtempSync(join(tmpdir(), "meetroom-test-")), "sessions"));
const server = buildServer(reg);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
after(() => server.close());

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
}

test("task lifecycle endpoints work over HTTP", async () => {
  const proj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  const { data } = await call("POST", "/api/sessions", { cwd: proj });
  const id = data.session.id;
  const j = await call("POST", `/api/sessions/${id}/join`, { name: "alice", role: "Implementer" });
  const created = await call("POST", `/api/sessions/${id}/tasks`, { title: "build the thing" });
  const tid = created.data.task.id;

  const assign = await call("POST", `/api/sessions/${id}/tasks/${tid}/assign`, { assignee: "alice" });
  assert.equal(assign.status, 200);
  const edit = await call("POST", `/api/sessions/${id}/tasks/${tid}/edit`, { description: "with docs" });
  assert.equal(edit.status, 200);
  const cancel = await call("POST", `/api/sessions/${id}/tasks/${tid}/cancel`, { agentId: j.data.agent.id });
  assert.equal(cancel.status, 200);

  const state = await call("GET", `/api/sessions/${id}/state`);
  const task = state.data.session.tasks.find((t: any) => t.id === tid);
  assert.equal(task.status, "cancelled");
  assert.equal(task.description, "with docs");
});

test("openapi lists the new routes", async () => {
  const res = await fetch(`${base}/api/openapi.json`);
  const spec = (await res.json()) as any;
  assert.ok(spec.paths["/api/sessions/{id}/tasks/{tid}/cancel"]);
  assert.ok(spec.paths["/api/sessions/{id}/proposals/{pid}/reject"]);
  assert.ok(spec.paths["/api/shutdown"]);
});

// Keep this test LAST: inviting an operator flips this daemon out of solo mode.
test("once operators exist, speaking as the human requires an operator key", async () => {
  const proj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  const { data } = await call("POST", "/api/sessions", { cwd: proj });
  const id = data.session.id;

  // Solo mode: human say is frictionless.
  const solo = await call("POST", `/api/sessions/${id}/say`, { agentId: "human", message: "hi" });
  assert.equal(solo.status, 200);

  const invited = await call("POST", "/api/operators", { name: "dana", role: "owner" });
  assert.equal(invited.status, 201);
  const key = invited.data.key;

  const anon = await call("POST", `/api/sessions/${id}/say`, { agentId: "human", message: "impersonation" });
  assert.equal(anon.status, 403);
  const keyed = await call("POST", `/api/sessions/${id}/say`, { agentId: "human", message: "the real me" }, { "x-meetroom-operator": key });
  assert.equal(keyed.status, 200);

  // Agents are unaffected by the human gate.
  const j = await call("POST", `/api/sessions/${id}/join`, { name: "bot", role: "Tester" });
  const agentSay = await call("POST", `/api/sessions/${id}/say`, { agentId: j.data.agent.id, message: "still fine" });
  assert.equal(agentSay.status, 200);
});
