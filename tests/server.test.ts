import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Registry } from "../src/daemon/registry.js";
import { buildServer } from "../src/daemon/server.js";

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

test("end-to-end: start session, two agents join, say, state shows both", async () => {
  const proj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  const created = await call("POST", "/api/sessions", { type: "sxl", cwd: proj });
  assert.equal(created.status, 201);
  const id = created.data.session.id;

  const j1 = await call("POST", `/api/sessions/${id}/join`, { name: "claude", role: "Implementer" });
  assert.equal(j1.status, 200);
  assert.ok(j1.data.brief.includes("Meetroom brief")); // auto-brief on join
  const j2 = await call("POST", `/api/sessions/${id}/join`, { name: "codex", role: "Reviewer" });

  await call("POST", `/api/sessions/${id}/say`, { agentId: j1.data.agent.id, message: "hello room" });

  const state = await call("GET", `/api/sessions/${id}/state`);
  assert.equal(state.data.session.agents.length, 2);
  assert.ok(state.data.session.chatLog.some((m: any) => m.message === "hello room"));

  // Private message filtering in the polling inbox (V2 #8).
  await call("POST", `/api/sessions/${id}/say`, { agentId: "human", message: "psst", to: "claude" });
  const inboxClaude = await call("GET", `/api/sessions/${id}/messages?agentId=${j1.data.agent.id}`);
  const inboxCodex = await call("GET", `/api/sessions/${id}/messages?agentId=${j2.data.agent.id}`);
  assert.ok(inboxClaude.data.messages.some((m: any) => m.message === "psst"));
  assert.ok(!inboxCodex.data.messages.some((m: any) => m.message === "psst"));
});

test("pause freezes claims and task moves; resume unfreezes", async () => {
  const proj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  const { data } = await call("POST", "/api/sessions", { type: "sxx", cwd: proj });
  const id = data.session.id;
  const j = await call("POST", `/api/sessions/${id}/join`, { name: "a1", role: "Implementer" });

  await call("POST", `/api/sessions/${id}/pause`);
  const claim = await call("POST", `/api/sessions/${id}/claim`, { agentId: j.data.agent.id, filepath: "x.ts" });
  assert.equal(claim.status, 409);
  assert.match(claim.data.error, /paused/);

  await call("POST", `/api/sessions/${id}/resume`);
  const claim2 = await call("POST", `/api/sessions/${id}/claim`, { agentId: j.data.agent.id, filepath: "x.ts" });
  assert.equal(claim2.status, 200);
});

test("draft plans only create tasks after approval", async () => {
  const proj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  const { data } = await call("POST", "/api/sessions", { type: "mmm", cwd: proj });
  const id = data.session.id;

  const plan = await call("POST", `/api/sessions/${id}/plan`, {
    description: "1. add schema; 2. build api; 3. write tests",
  });
  assert.equal(plan.status, 201);
  assert.ok(plan.data.plan.tasks.length >= 2);

  let state = await call("GET", `/api/sessions/${id}/state`);
  assert.equal(state.data.session.tasks.length, 0); // nothing live yet

  await call("POST", `/api/sessions/${id}/plan/${plan.data.plan.id}/approve`);
  state = await call("GET", `/api/sessions/${id}/state`);
  assert.equal(state.data.session.tasks.length, plan.data.plan.tasks.length);
  // Sequential dependencies were wired up.
  assert.ok(state.data.session.tasks.some((t: any) => t.dependsOn?.length));
});

test("guild roster pre-populates waiting agents that activate on join", async () => {
  const proj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  const { data } = await call("POST", "/api/sessions", {
    type: "sxl",
    cwd: proj,
    guild: "The Refactor Crew",
    roster: [
      { name: "claude", role: "Architect", costTier: "high" },
      { name: "glm", role: "Tester", costTier: "low" },
    ],
  });
  const id = data.session.id;
  let state = await call("GET", `/api/sessions/${id}/state`);
  assert.equal(state.data.session.agents.length, 2);
  assert.ok(state.data.session.agents.every((a: any) => a.status === "waiting"));

  await call("POST", `/api/sessions/${id}/join`, { name: "claude", role: "Architect" });
  state = await call("GET", `/api/sessions/${id}/state`);
  assert.equal(state.data.session.agents.length, 2); // no duplicate
  assert.equal(state.data.session.agents.find((a: any) => a.name === "claude").status, "active");
});

test("ended sessions reject work and export still functions", async () => {
  const proj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  const { data } = await call("POST", "/api/sessions", { type: "sxl", cwd: proj });
  const id = data.session.id;
  await call("POST", `/api/sessions/${id}/end`);
  const claim = await call("POST", `/api/sessions/${id}/claim`, { agentId: "x", filepath: "y" });
  assert.equal(claim.status, 410);

  const res = await fetch(`${base}/api/sessions/${id}/export?format=md`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes("Meetroom session report"));
});

test("inbound integration requires a valid HMAC signature", async () => {
  const { createHmac } = await import("node:crypto");
  const proj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  const { data } = await call("POST", "/api/sessions", { type: "sxl", cwd: proj });
  const id = data.session.id;
  await call("POST", `/api/sessions/${id}/integrations`, { source: "slack", secret: "shh" });

  const ts = new Date().toISOString();
  const badSig = await call("POST", `/api/sessions/${id}/inbound`, { source: "slack", author: "dana", text: "ship it", ts, signature: "nope" });
  assert.equal(badSig.status, 403);

  const signature = createHmac("sha256", "shh").update(`${ts}.ship it`).digest("hex");
  const good = await call("POST", `/api/sessions/${id}/inbound`, { source: "slack", author: "dana", text: "ship it", ts, signature });
  assert.equal(good.status, 200);

  // Replay protection: a correctly signed but stale request is rejected.
  const oldTs = new Date(Date.now() - 10 * 60_000).toISOString();
  const staleSig = createHmac("sha256", "shh").update(`${oldTs}.ship it`).digest("hex");
  const stale = await call("POST", `/api/sessions/${id}/inbound`, { source: "slack", author: "dana", text: "ship it", ts: oldTs, signature: staleSig });
  assert.equal(stale.status, 403);
  // ...and ts is mandatory.
  const noTs = await call("POST", `/api/sessions/${id}/inbound`, { source: "slack", author: "dana", text: "ship it", signature });
  assert.equal(noTs.status, 400);
  const state = await call("GET", `/api/sessions/${id}/state`);
  assert.ok(state.data.session.chatLog.some((m: any) => m.message.includes("[slack] dana: ship it")));
});

test("openapi contract is generated from the live route table", async () => {
  const res = await fetch(`${base}/api/openapi.json`);
  const spec = (await res.json()) as any;
  assert.equal(spec.openapi, "3.0.0");
  assert.ok(spec.paths["/api/sessions/{id}/claim"]);
  assert.ok(spec.paths["/api/sessions/{id}/tasks/{tid}/verify"]);
});

test("fork clones agents and tasks into a new session", async () => {
  const proj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  const { data } = await call("POST", "/api/sessions", { type: "sxl", cwd: proj });
  const id = data.session.id;
  await call("POST", `/api/sessions/${id}/join`, { name: "a", role: "Implementer" });
  await call("POST", `/api/sessions/${id}/tasks`, { title: "approach A vs B" });

  const fork = await call("POST", `/api/sessions/${id}/fork`);
  assert.equal(fork.status, 201);
  const forkState = await call("GET", `/api/sessions/${fork.data.fork.id}/state`);
  assert.equal(forkState.data.session.forkedFrom, id);
  assert.equal(forkState.data.session.agents.length, 1);
  assert.equal(forkState.data.session.tasks.length, 1);
});
