import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { Registry } from "../src/daemon/registry.js";
import { buildServer } from "../src/daemon/server.js";
import { claimFile, claimLines, releaseAgentPresence } from "../src/daemon/fileClaims.js";
import { createProposal, objectToProposal, resolveProposal, sweepProposalTimeouts, voteOnProposal } from "../src/daemon/resolution.js";
import { createTask, moveTask, reportCIStatus, reportTestResult } from "../src/daemon/tasks.js";
import { submitReview, decideReview } from "../src/daemon/reviews.js";
import { cronMatches, spawnRunner, stopRunner } from "../src/daemon/ops.js";
import { queueAction, sweepPendingActions } from "../src/daemon/evolve.js";
import { parseArgs } from "../src/cli/client.js";
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

test("author cannot re-resolve a voting proposal to wipe unfavorable votes", () => {
  const { reg, session, agents } = setup(3);
  const p = createProposal(reg, session, agents[0].id, "risky rewrite");
  objectToProposal(reg, session, p.id, agents[1].id, "too risky");
  resolveProposal(reg, session, p.id, agents[0].id, "trust me");
  assert.equal(p.status, "voting");
  voteOnProposal(reg, session, p.id, agents[1].id, "no");
  voteOnProposal(reg, session, p.id, agents[2].id, "no");

  const again = resolveProposal(reg, session, p.id, agents[0].id, "please?");
  assert.equal(again.ok, false);
  assert.equal(p.votes?.length, 2); // votes survived
});

test("author cannot resolve an escalated proposal; the human still can", () => {
  const { reg, session, agents } = setup(2);
  const p = createProposal(reg, session, agents[0].id, "drop the ORM");
  objectToProposal(reg, session, p.id, agents[1].id, "too risky");
  resolveProposal(reg, session, p.id, agents[0].id, "we have tests");
  assert.equal(p.status, "escalated");
  assert.equal(resolveProposal(reg, session, p.id, agents[0].id, "resolving anyway").ok, false);
  assert.equal(p.status, "escalated");
  assert.equal(resolveProposal(reg, session, p.id, "human").ok, true);
});

test("a departing agent is dropped from waitlists and its line claims released", () => {
  const { reg, session, agents } = setup(3);
  const [a, b, c] = agents;
  claimFile(reg, session, a.id, "src/db.ts");
  claimFile(reg, session, b.id, "src/db.ts", true); // b queues
  claimFile(reg, session, c.id, "src/db.ts", true); // c queues behind b
  claimLines(reg, session, b.id, "src/api.ts", 10, 50);

  releaseAgentPresence(reg, session, b.id);
  assert.equal(session.semanticClaims.length, 0);
  assert.ok(!session.waitlists.some((w) => w.waitingAgentIds.includes(b.id)));

  // When a releases, the file must go to c (not to the departed b).
  releaseAgentPresence(reg, session, a.id);
  assert.equal(session.claims.find((cl) => cl.filepath === "src/db.ts")?.agentId, c.id);
});

test("review decisions from unknown agent ids are rejected", () => {
  const { reg, session, agents } = setup(2);
  const t = createTask(reg, session, { title: "x", files: [] });
  assert.ok(t.ok);
  const r = submitReview(reg, session, { taskId: (t as any).task.id, authorAgentId: agents[0].id, diff: "diff --git a b" });
  assert.ok(r.ok);
  const reviewId = (r as any).review.id;

  assert.equal(decideReview(reg, session, reviewId, "made-up-agent", "approved").ok, false);
  assert.equal(decideReview(reg, session, reviewId, agents[0].id, "approved").ok, false); // self-review
  assert.equal(decideReview(reg, session, reviewId, agents[1].id, "approved").ok, true);
  assert.equal(decideReview(reg, session, reviewId, "human", "approved").ok, true);
});

test("boolean flags do not swallow the following positional", () => {
  const claim = parseArgs(["--wait", "src/x.ts"]);
  assert.equal(claim.flags.wait, true);
  assert.deepEqual(claim.positional, ["src/x.ts"]);

  const purge = parseArgs(["--yes", "sxl-abcd"]);
  assert.equal(purge.flags.yes, true);
  assert.deepEqual(purge.positional, ["sxl-abcd"]);

  // Value-taking flags keep consuming the next token.
  const join = parseArgs(["--sxl", "sxl-abcd", "--name", "Claude"]);
  assert.equal(join.flags.sxl, "sxl-abcd");
  assert.equal(join.flags.name, "Claude");
});

test("stopping a runner preserves its restart policy and never counts as a crash", async () => {
  const { reg, session } = setup(1);
  const dataDir = reg.dataDir;
  const spawned = spawnRunner(reg, session, dataDir, { agentName: "worker", command: "sleep 30", restartPolicy: "on-crash" });
  assert.ok(spawned.ok);
  stopRunner(reg, session, "worker");
  const runner = session.runners.find((r) => r.agentName === "worker")!;
  assert.equal(runner.restartPolicy, "on-crash");
  assert.equal(runner.state, "stopped");
  await new Promise((r) => setTimeout(r, 300)); // let the exit event land
  assert.equal(runner.state, "stopped"); // not "crashed", no restart
  assert.ok(!session.events.some((e) => e.type === "runner-crashed"));
});

test("runner names that would escape the log directory are rejected", () => {
  const { reg, session } = setup(1);
  const r = spawnRunner(reg, session, reg.dataDir, { agentName: "../../etc/passwd", command: "true" });
  assert.equal(r.ok, false);
});

test("cron */0 step never matches instead of throwing NaN comparisons", () => {
  assert.equal(cronMatches("*/0 * * * *", new Date()), false);
  assert.equal(cronMatches("* * * * *", new Date()), true);
});

test("pending meta-agent actions do not execute while the room is paused", () => {
  const { reg, session, agents } = setup(2);
  const p = createProposal(reg, session, agents[0].id, "auto thing");
  const action = queueAction(reg, session, "resolve-proposal", { proposalId: p.id }, "test");
  action.executeAt = new Date(Date.now() - 1000).toISOString(); // veto window elapsed
  session.status = "paused";
  sweepPendingActions(reg, session);
  assert.equal(action.status, "pending");
  session.status = "active";
  sweepPendingActions(reg, session);
  assert.equal(action.status, "executed");
});

test("reviews from unknown author ids are rejected (self-review bypass)", () => {
  const { reg, session, agents } = setup(2);
  const t = createTask(reg, session, { title: "x", files: [] });
  assert.ok(t.ok);
  const taskId = (t as any).task.id;

  // The bypass: submit under an invented author, then approve as yourself.
  const forged = submitReview(reg, session, { taskId, authorAgentId: "invented-author", diff: "diff --git a b" });
  assert.equal(forged.ok, false);

  // Legit authors (joined agents, or the human) still work.
  assert.ok(submitReview(reg, session, { taskId, authorAgentId: agents[0].id, diff: "diff --git a b" }).ok);
  assert.ok(submitReview(reg, session, { taskId, authorAgentId: "human", diff: "diff --git a b" }).ok);
});

test("a stalled vote is tallied after the objection window instead of hanging forever", () => {
  const { reg, session, agents } = setup(3);
  const p = createProposal(reg, session, agents[0].id, "split the module");
  objectToProposal(reg, session, p.id, agents[1].id, "premature");
  resolveProposal(reg, session, p.id, agents[0].id, "it's 3k lines");
  assert.equal(p.status, "voting");
  voteOnProposal(reg, session, p.id, agents[0].id, "yes");
  voteOnProposal(reg, session, p.id, agents[1].id, "yes");
  // agent-2 never votes. Sweep before the window: still voting.
  sweepProposalTimeouts(reg, session);
  assert.equal(p.status, "voting");
  // Age the voting event past the window: majority of cast votes decides.
  const votingEvent = session.events.find((e) => e.type === "proposal-voting" && e.data?.proposalId === p.id)!;
  votingEvent.ts = new Date(Date.now() - (session.config.objectionTimeoutMinutes + 1) * 60_000).toISOString();
  sweepProposalTimeouts(reg, session);
  assert.equal(p.status, "resolved");
});

test("a stalled vote with no votes cast escalates to the human", () => {
  const { reg, session, agents } = setup(3);
  const p = createProposal(reg, session, agents[0].id, "risky thing");
  objectToProposal(reg, session, p.id, agents[1].id, "no");
  resolveProposal(reg, session, p.id, agents[0].id, "yes");
  assert.equal(p.status, "voting");
  const votingEvent = session.events.find((e) => e.type === "proposal-voting" && e.data?.proposalId === p.id)!;
  votingEvent.ts = new Date(Date.now() - (session.config.objectionTimeoutMinutes + 1) * 60_000).toISOString();
  sweepProposalTimeouts(reg, session);
  assert.equal(p.status, "escalated");
});

test("test and CI reports reject values outside the allowed set", () => {
  const { reg, session } = setup(1);
  const t = createTask(reg, session, { title: "x", files: [] });
  assert.ok(t.ok);
  const taskId = (t as any).task.id;
  assert.equal(reportTestResult(reg, session, taskId, "pased" as any).ok, false);
  assert.equal(reportTestResult(reg, session, taskId, "passed").ok, true);
  assert.equal(reportCIStatus(reg, session, taskId, "green" as any).ok, false);
  assert.equal(reportCIStatus(reg, session, taskId, "passed").ok, true);
});

test("tasks with a non-string verify command are rejected at creation and edit", () => {
  const { reg, session } = setup(1);
  const bad = createTask(reg, session, { title: "x", files: [], verify: { command: true as any } });
  assert.equal(bad.ok, false);
  const blank = createTask(reg, session, { title: "x", files: [], verify: { command: "  " } });
  assert.equal(blank.ok, false);
  const good = createTask(reg, session, { title: "x", files: [], verify: { command: "npm test" } });
  assert.ok(good.ok);
});

test("reopening a done task clears its stale completion timestamp", () => {
  const { reg, session, agents } = setup(2);
  const t = createTask(reg, session, { title: "x", files: [] });
  assert.ok(t.ok);
  const taskId = (t as any).task.id;
  const r = submitReview(reg, session, { taskId, authorAgentId: agents[0].id, diff: "diff --git a b" });
  assert.ok(r.ok);
  decideReview(reg, session, (r as any).review.id, agents[1].id, "approved");
  assert.ok(moveTask(reg, session, taskId, "done", agents[0].id).ok);
  const task = session.tasks.find((x) => x.id === taskId)!;
  assert.ok(task.doneAt);
  moveTask(reg, session, taskId, "todo", agents[0].id);
  assert.equal(task.doneAt, undefined);
});

// ---- HTTP-level: credentials never echo back out of /state -------------------

const reg = new Registry(join(mkdtempSync(join(tmpdir(), "meetroom-test-")), "sessions"));
const server = buildServer(reg);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
after(() => server.close());

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
}

test("session state redacts the session token and integration secrets", async () => {
  const proj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  const created = await call("POST", "/api/sessions", { cwd: proj, remote: true });
  const id = created.data.session.id;
  assert.ok(created.data.session.token); // creation response still returns it once
  await call("POST", `/api/sessions/${id}/integrations`, { source: "ci", secret: "hush" });

  // Loopback callers skip token auth, so state is reachable — but redacted.
  const state = await call("GET", `/api/sessions/${id}/state`);
  assert.equal(state.data.session.token, undefined);
  assert.deepEqual(state.data.session.integrations, [{ source: "ci" }]);

  // The redacted secret still validates inbound HMACs.
  const ts = new Date().toISOString();
  const signature = createHmac("sha256", "hush").update(`${ts}.build green`).digest("hex");
  const inbound = await call("POST", `/api/sessions/${id}/inbound`, { source: "ci", text: "build green", ts, signature });
  assert.equal(inbound.status, 200);
});
