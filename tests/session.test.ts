import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/daemon/registry.js";
import { distillSessionIntoMemory, loadMemory } from "../src/daemon/memory.js";
import { generateBrief } from "../src/daemon/brief.js";
import { exportSession } from "../src/daemon/exporter.js";

test("session ids follow sxl-<random4> and persist across registry restarts", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "meetroom-test-"));
  const reg = new Registry(dataDir);
  const s = reg.createSession({ cwd: "/tmp/proj" });
  assert.match(s.id, /^sxl-[a-z2-9]{4}$/);

  const reg2 = new Registry(dataDir);
  const reloaded = reg2.get(s.id);
  assert.ok(reloaded);
  assert.equal(reloaded!.cwd, "/tmp/proj");
});

test("remote sessions get a token; local ones don't", () => {
  const reg = new Registry(join(mkdtempSync(join(tmpdir(), "meetroom-test-")), "sessions"));
  const local = reg.createSession({ cwd: "/tmp/a" });
  const remote = reg.createSession({ cwd: "/tmp/b", remote: true });
  assert.equal(local.token, undefined);
  assert.match(remote.token!, /^[0-9a-f]{48}$/);
});

test("session end distills resolved proposals and done tasks into project memory", () => {
  const proj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  const reg = new Registry(join(mkdtempSync(join(tmpdir(), "meetroom-test-")), "sessions"));
  const s = reg.createSession({ cwd: proj });
  s.proposals.push({
    id: "prop-1",
    authorId: "a",
    content: "use snake_case for DB columns",
    objections: [],
    status: "resolved",
    createdAt: new Date().toISOString(),
  });
  s.tasks.push({
    id: "task-1",
    title: "add login endpoint",
    description: "",
    status: "done",
    files: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const memory = distillSessionIntoMemory(s);
  assert.equal(memory.nodes.length, 2);
  assert.ok(memory.nodes.some((n) => n.summary.includes("snake_case")));
  // Re-distilling doesn't duplicate.
  assert.equal(distillSessionIntoMemory(s).nodes.length, 2);
  // And it round-trips from disk (it's the file agents' next session reads).
  assert.equal(loadMemory(proj).nodes.length, 2);
});

test("legacy flat memory files migrate into graph nodes on load", () => {
  const proj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  mkdirSync(join(proj, ".meetroom"), { recursive: true });
  writeFileSync(
    join(proj, ".meetroom", "memory.json"),
    JSON.stringify({
      projectPath: proj,
      decisions: [{ summary: "use pnpm", date: new Date().toISOString(), sourceSessionId: "sxl-old1" }],
      conventions: ["tabs not spaces"],
    })
  );
  const memory = loadMemory(proj);
  assert.equal(memory.nodes.length, 2);
  assert.ok(memory.nodes.some((n) => n.kind === "decision" && n.summary === "use pnpm"));
  assert.ok(memory.nodes.some((n) => n.kind === "convention" && n.summary === "tabs not spaces"));
});

test("brief includes board, claims, decisions, and prior project memory", () => {
  const proj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  const reg = new Registry(join(mkdtempSync(join(tmpdir(), "meetroom-test-")), "sessions"));
  const s1 = reg.createSession({ cwd: proj });
  s1.proposals.push({
    id: "prop-1",
    authorId: "a",
    content: "REST over GraphQL",
    objections: [],
    status: "resolved",
    createdAt: new Date().toISOString(),
  });
  distillSessionIntoMemory(s1);

  const s2 = reg.createSession({ cwd: proj });
  s2.tasks.push({
    id: "task-9",
    title: "wire auth",
    description: "",
    status: "in-progress",
    files: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const brief = generateBrief(s2);
  assert.ok(brief.includes("wire auth"));
  assert.ok(brief.includes("Project memory"));
  assert.ok(brief.includes("REST over GraphQL"));
});

test("export produces markdown and json with usage aggregation", () => {
  const reg = new Registry(join(mkdtempSync(join(tmpdir(), "meetroom-test-")), "sessions"));
  const s = reg.createSession({ cwd: "/tmp/p" });
  s.agents.push({
    id: "a1",
    name: "claude",
    role: "Implementer",
    identity: "claude",
    status: "active",
    joinedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  });
  s.usage.push({ agentId: "a1", tokensIn: 100, tokensOut: 50, costUsd: 0.01 });
  s.usage.push({ agentId: "a1", tokensIn: 200, tokensOut: 80, costUsd: 0.02 });

  const md = exportSession(s, "md");
  assert.ok(md.includes("| claude | 300 | 130 |"));

  const parsed = JSON.parse(exportSession(s, "json"));
  assert.equal(parsed.session.id, s.id);
  assert.equal(parsed.usage.length, 2);
});

test("fork-style clone keeps agents/tasks but gets its own id (via createSession)", () => {
  const reg = new Registry(join(mkdtempSync(join(tmpdir(), "meetroom-test-")), "sessions"));
  const s = reg.createSession({ cwd: "/tmp/p" });
  const fork = reg.createSession({ cwd: s.cwd, forkedFrom: s.id });
  assert.notEqual(fork.id, s.id);
  assert.equal(fork.forkedFrom, s.id);
});
