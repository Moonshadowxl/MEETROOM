import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Registry } from "../src/daemon/registry.js";
import { claimFile, claimLines, releaseLines } from "../src/daemon/fileClaims.js";
import { effectiveTimeoutMinutes, predictConflicts, recordClaimDuration } from "../src/daemon/intelligence.js";
import { createTask } from "../src/daemon/tasks.js";
import { activeMemoryNodes, loadMemory, promoteMemoryNode, recallMemory, saveMemory } from "../src/daemon/memory.js";
import { generateDeltaBrief } from "../src/daemon/brief.js";
import type { Agent, Session, Task } from "../src/shared/types.js";

process.env.MEETROOM_HOME = mkdtempSync(join(tmpdir(), "meetroom-home-"));

function setup(): { reg: Registry; session: Session; a: Agent; b: Agent } {
  const reg = new Registry(join(mkdtempSync(join(tmpdir(), "meetroom-test-")), "sessions"));
  const session = reg.createSession({ type: "sxl", cwd: mkdtempSync(join(tmpdir(), "meetroom-proj-")) });
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

test("line-range claims coexist unless they overlap; whole-file claim trumps", () => {
  const { reg, session, a, b } = setup();
  assert.equal(claimLines(reg, session, a.id, "api.ts", 10, 50).ok, true);
  assert.equal(claimLines(reg, session, b.id, "api.ts", 60, 90).ok, true); // disjoint: fine
  assert.equal(claimLines(reg, session, b.id, "api.ts", 40, 65).ok, false); // overlaps alice

  // bob can't take the whole file while alice holds lines.
  const whole = claimFile(reg, session, b.id, "api.ts");
  assert.equal(whole.ok, false);

  releaseLines(reg, session, a.id, "api.ts");
  assert.equal(session.semanticClaims.filter((c) => c.filepath === "api.ts").length, 1);
});

test("conflict prediction flags shared files and similar scope, never blocks", () => {
  const { reg, session } = setup();
  createTask(reg, session, { title: "refactor the auth token validation flow", files: ["auth.py"] });
  const r2 = createTask(reg, session, { title: "rework auth token validation logic", files: ["auth.py"] });
  assert.ok(r2.ok);
  const warnings = (r2 as { ok: true; task: Task }).task.conflictWarnings ?? [];
  assert.ok(warnings.length > 0);
  assert.match(warnings[0], /auth\.py/);
});

test("adaptive timeout learns p90 from history and respects explicit override", () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), "meetroom-data-")), "sessions");
  const { session } = setup();
  session.config.claimTimeoutMinutes = 10;
  // No history → session default.
  assert.equal(effectiveTimeoutMinutes(dataDir, session, "migrations/big.sql"), 10);
  for (const m of [20, 22, 25, 24, 21]) recordClaimDuration(dataDir, "migrations/big.sql", m);
  const learned = effectiveTimeoutMinutes(dataDir, session, "migrations/big.sql");
  assert.ok(learned > 10 && learned <= 45, `learned=${learned}`);
  // Explicit override beats learned.
  assert.equal(effectiveTimeoutMinutes(dataDir, session, "migrations/big.sql", 30), 30);
});

test("memory graph: recall finds nodes, supersedes hides stale ones, promote goes global", () => {
  const proj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  const memory = loadMemory(proj);
  memory.nodes!.push(
    { id: "mem-old", kind: "decision", summary: "auth tokens are JWTs", links: {}, sourceSessionId: "s1", date: "2026-01-01" },
    { id: "mem-new", kind: "decision", summary: "auth tokens are opaque, never JWTs", links: { supersedes: "mem-old", files: ["auth.py"] }, sourceSessionId: "s2", date: "2026-06-01" },
    { id: "mem-conv", kind: "convention", summary: "snake_case for DB columns", links: {}, sourceSessionId: "s1", date: "2026-01-01" }
  );
  saveMemory(proj, memory);

  const active = activeMemoryNodes(proj);
  assert.ok(!active.some((n) => n.id === "mem-old")); // superseded is hidden
  const hits = recallMemory(proj, "how do we handle auth tokens");
  assert.ok(hits.some((h) => h.node.id === "mem-new"));

  const promoted = promoteMemoryNode(proj, "mem-conv");
  assert.ok(promoted.ok);
  const otherProj = mkdtempSync(join(tmpdir(), "meetroom-proj-"));
  assert.ok(activeMemoryNodes(otherProj).some((n) => n.summary === "snake_case for DB columns"));
});

test("delta brief reports only what happened since the timestamp", () => {
  const { reg, session, a } = setup();
  const before = new Date(Date.now() - 1000).toISOString();
  const empty = generateDeltaBrief(session, new Date(Date.now() + 1000).toISOString());
  assert.match(empty, /Nothing happened/);
  reg.event(session, "task-created", a.id, { taskId: "t1" });
  reg.chat(session, { agentId: a.id, message: "starting on t1" });
  const brief = generateDeltaBrief(session, before);
  assert.match(brief, /starting on t1/);
});
