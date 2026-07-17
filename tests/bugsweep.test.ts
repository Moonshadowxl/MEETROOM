import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { createHmac } from "node:crypto";
import { Registry } from "../src/daemon/registry.js";
import { authorized, buildServer } from "../src/daemon/server.js";
import { claimFile } from "../src/daemon/fileClaims.js";
import { createProposal, objectToProposal, resolveProposal, voteOnProposal } from "../src/daemon/resolution.js";
import { createTask, claimTask, moveTask } from "../src/daemon/tasks.js";
import { submitReview, decideReview } from "../src/daemon/reviews.js";
import { cronMatches, spawnRunner, stopRunner } from "../src/daemon/ops.js";
import { memoryForFile, pathTailMatches } from "../src/daemon/memory.js";
import { loadReputation } from "../src/daemon/reputation.js";
import type { Agent, Session } from "../src/shared/types.js";

function setup(agentCount = 3): { reg: Registry; session: Session; agents: Agent[] } {
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

// ---- ballot stuffing --------------------------------------------------------

test("votes and objections from invented agent ids are rejected", () => {
  const { reg, session, agents } = setup(3);
  const p = createProposal(reg, session, agents[0].id, "swap the queue for redis");

  assert.equal(objectToProposal(reg, session, p.id, "ghost-1", "sabotage").ok, false);
  assert.equal(p.objections.length, 0);
  assert.equal(p.status, "open");

  // Real objection + author response → voting (3 active agents).
  objectToProposal(reg, session, p.id, agents[1].id, "risky");
  resolveProposal(reg, session, p.id, agents[0].id, "we have a fallback");
  assert.equal(p.status, "voting");

  // Fake voters can neither vote nor push the tally to quorum.
  assert.equal(voteOnProposal(reg, session, p.id, "ghost-1", "yes").ok, false);
  assert.equal(voteOnProposal(reg, session, p.id, "ghost-2", "yes").ok, false);
  assert.equal(voteOnProposal(reg, session, p.id, "ghost-3", "yes").ok, false);
  assert.equal(p.status, "voting"); // quorum (3 real agents) not reached
  assert.equal(p.votes?.length ?? 0, 0);

  voteOnProposal(reg, session, p.id, agents[0].id, "yes");
  voteOnProposal(reg, session, p.id, agents[1].id, "no");
  voteOnProposal(reg, session, p.id, agents[2].id, "yes");
  assert.equal(p.status, "resolved"); // real votes still work
});

// ---- runner restart race ----------------------------------------------------

test("restarting a runner does not let the old child mark the new one crashed", async () => {
  const { reg, session } = setup(1);
  const spawned = spawnRunner(reg, session, reg.dataDir, { agentName: "worker", command: "sleep 30", restartPolicy: "on-crash" });
  assert.ok(spawned.ok);
  stopRunner(reg, session, "worker");
  // Immediately respawn — the old child's exit event hasn't landed yet.
  const respawned = spawnRunner(reg, session, reg.dataDir, { agentName: "worker", command: "sleep 30" });
  assert.ok(respawned.ok);
  await new Promise((r) => setTimeout(r, 400)); // let the old SIGTERM exit land
  const runner = session.runners.find((r) => r.agentName === "worker")!;
  assert.equal(runner.state, "running");
  assert.ok(!session.events.some((e) => e.type === "runner-crashed"));
  stopRunner(reg, session, "worker");
});

test("manual respawn resets the crash-restart allowance", () => {
  const { reg, session } = setup(1);
  spawnRunner(reg, session, reg.dataDir, { agentName: "w2", command: "sleep 30", restartPolicy: "on-crash", maxRestarts: 3 });
  const runner = session.runners.find((r) => r.agentName === "w2")!;
  stopRunner(reg, session, "w2");
  runner.restarts = 3; // simulate an exhausted crash loop
  const respawned = spawnRunner(reg, session, reg.dataDir, { agentName: "w2", command: "sleep 30" });
  assert.ok(respawned.ok);
  assert.equal(runner.restarts, 0);
  stopRunner(reg, session, "w2");
});

// ---- cron semantics ---------------------------------------------------------

test("cron steps count from the field minimum and Sunday matches both 0 and 7", () => {
  // 2026-07-05 is a Sunday; day-of-month 5.
  const sunday1st = new Date(2026, 6, 5, 0, 0);
  assert.equal(cronMatches("0 0 * * 7", sunday1st), true);
  assert.equal(cronMatches("0 0 * * 0", sunday1st), true);

  // */5 on day-of-month fires on days 1, 6, 11... (1-based), not 5, 10...
  const day1 = new Date(2026, 6, 1, 0, 0);
  const day5 = new Date(2026, 6, 5, 0, 0);
  const day6 = new Date(2026, 6, 6, 0, 0);
  assert.equal(cronMatches("0 0 */5 * *", day1), true);
  assert.equal(cronMatches("0 0 */5 * *", day5), false);
  assert.equal(cronMatches("0 0 */5 * *", day6), true);

  // Minute steps are unchanged (0-based field).
  assert.equal(cronMatches("*/15 * * * *", new Date(2026, 6, 1, 0, 30)), true);
  assert.equal(cronMatches("*/15 * * * *", new Date(2026, 6, 1, 0, 31)), false);
  // */0 still never matches (guard kept).
  assert.equal(cronMatches("*/0 * * * *", new Date()), false);
});

// ---- idempotent task moves --------------------------------------------------

test("re-moving a done task to done does not double-count reputation", () => {
  const { reg, session, agents } = setup(2);
  const created = createTask(reg, session, { title: "ship it", files: [] });
  assert.ok(created.ok);
  const taskId = (created as any).task.id;
  claimTask(reg, session, taskId, agents[0].id);
  const r = submitReview(reg, session, { taskId, authorAgentId: agents[0].id, diff: "diff --git a b" });
  decideReview(reg, session, (r as any).review.id, agents[1].id, "approved");

  assert.equal(moveTask(reg, session, taskId, "done").ok, true);
  assert.equal(loadReputation(session.cwd).find((x) => x.agentIdentity === agents[0].identity)?.tasksCompleted, 1);

  const again = moveTask(reg, session, taskId, "done");
  assert.equal(again.ok, true); // idempotent, not an error
  assert.equal(loadReputation(session.cwd).find((x) => x.agentIdentity === agents[0].identity)?.tasksCompleted, 1);
});

// ---- claim timeout override on re-claim --------------------------------------

test("re-claiming your own file updates the explicit timeout override", () => {
  const { reg, session, agents } = setup(1);
  claimFile(reg, session, agents[0].id, "src/x.ts", false, 5);
  claimFile(reg, session, agents[0].id, "src/x.ts", false, 30);
  assert.equal(session.claims.find((c) => c.filepath === "src/x.ts")?.timeoutMinutes, 30);
});

// ---- memory file matching ---------------------------------------------------

test("memory-for-file matches at path boundaries only", () => {
  assert.equal(pathTailMatches("a.ts", "src/a.ts"), true);
  assert.equal(pathTailMatches("src/a.ts", "a.ts"), true);
  assert.equal(pathTailMatches("a.ts", "data.ts"), false);
  assert.equal(pathTailMatches("api.ts", "src/api.ts"), true);

  const cwd = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  mkdirSync(join(cwd, ".meetroom"), { recursive: true });
  writeFileSync(
    join(cwd, ".meetroom", "memory.json"),
    JSON.stringify({
      projectPath: cwd,
      decisions: [],
      conventions: [],
      nodes: [
        { id: "mem-1", kind: "gotcha", summary: "a.ts has a tricky cache", links: { files: ["a.ts"] }, sourceSessionId: "s", date: "2026-01-01" },
      ],
    })
  );
  assert.equal(memoryForFile(cwd, "src/a.ts").length, 1);
  assert.equal(memoryForFile(cwd, "data.ts").length, 0);
});

// ---- token auth via query string (SSE) ---------------------------------------

test("remote sessions accept the token as a query parameter (EventSource has no headers)", () => {
  const { session } = setup(0);
  session.token = "tok123";
  const fakeReq = (url: string, headerToken?: string) =>
    ({
      url,
      headers: headerToken ? { "x-meetroom-token": headerToken } : {},
      socket: { remoteAddress: "203.0.113.5" }, // not loopback
    }) as unknown as IncomingMessage;

  assert.equal(authorized(fakeReq(`/api/sessions/${session.id}/events`), session), false);
  assert.equal(authorized(fakeReq(`/api/sessions/${session.id}/events?token=tok123`), session), true);
  assert.equal(authorized(fakeReq(`/api/sessions/${session.id}/events?token=wrong`), session), false);
  assert.equal(authorized(fakeReq(`/api/sessions/${session.id}/events`, "tok123"), session), true);
});

// ---- HTTP-level checks (dedicated registry: operator config is daemon-global) --

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

test("a signed inbound message cannot be replayed inside the freshness window", async () => {
  const proj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  const { data } = await call("POST", "/api/sessions", { cwd: proj });
  const id = data.session.id;
  await call("POST", `/api/sessions/${id}/integrations`, { source: "ci", secret: "hush" });

  const ts = new Date().toISOString();
  const signature = createHmac("sha256", "hush").update(`${ts}.deploy done`).digest("hex");
  const first = await call("POST", `/api/sessions/${id}/inbound`, { source: "ci", text: "deploy done", ts, signature });
  assert.equal(first.status, 200);
  const replay = await call("POST", `/api/sessions/${id}/inbound`, { source: "ci", text: "deploy done", ts, signature });
  assert.equal(replay.status, 403);
  assert.match(replay.data.error, /replay/i);
});

test("malformed JSON bodies get a 400 instead of silently acting on {}", async () => {
  const proj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  const { data } = await call("POST", "/api/sessions", { cwd: proj });
  const res = await fetch(`${base}/api/sessions/${data.session.id}/say`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{oops",
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as any).error, /valid JSON/);
});

test("deleting a routine requires the same operator role as creating one", async () => {
  const created = await call("POST", "/api/routines", { name: "nightly", cron: "0 2 * * *", cwd: tmpdir() });
  assert.equal(created.status, 201);
  const rid = created.data.routine.id;

  // Configure an operator (solo mode allowed this); privileged calls now need a key.
  const op = await call("POST", "/api/operators", { name: "boss", role: "owner" });
  assert.equal(op.status, 201);

  const denied = await call("DELETE", `/api/routines/${rid}`);
  assert.equal(denied.status, 403);
  const allowed = await call("DELETE", `/api/routines/${rid}`, undefined, { "x-meetroom-operator": op.data.key });
  assert.equal(allowed.status, 200);
});
