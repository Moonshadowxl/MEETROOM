import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/daemon/registry.js";
import { claimFile, claimLines } from "../src/daemon/fileClaims.js";
import { evaluateGuard } from "../src/daemon/guard.js";
import type { Agent, Session } from "../src/shared/types.js";

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

test("guard: unclaimed files are violations, own claims pass", () => {
  const { reg, session, a } = setup();
  claimFile(reg, session, a.id, "src/auth.ts");

  const ok = evaluateGuard(session, a.id, ["src/auth.ts"]);
  assert.equal(ok.length, 0);

  const missing = evaluateGuard(session, a.id, ["src/other.ts"]);
  assert.equal(missing.length, 1);
  assert.match(missing[0].reason, /no claim/);
});

test("guard: files held by another agent are violations naming the holder", () => {
  const { reg, session, a, b } = setup();
  claimFile(reg, session, b.id, "src/db.ts");
  const v = evaluateGuard(session, a.id, ["src/db.ts"]);
  assert.equal(v.length, 1);
  assert.match(v[0].reason, /claimed by bob/);
});

test("guard: claim paths tail-match the edited path (auth.py vs src/auth.py)", () => {
  const { reg, session, a } = setup();
  claimFile(reg, session, a.id, "auth.py");
  assert.equal(evaluateGuard(session, a.id, ["src/auth.py"]).length, 0);
  // But data.py must not match auth claims for a.py-style suffixes.
  assert.equal(evaluateGuard(session, a.id, ["data.py"]).length, 1);
});

test("guard: own line-range claim passes, someone else's is a violation", () => {
  const { reg, session, a, b } = setup();
  claimLines(reg, session, a.id, "src/api.ts", 10, 50);
  assert.equal(evaluateGuard(session, a.id, ["src/api.ts"]).length, 0);

  const v = evaluateGuard(session, b.id, ["src/api.ts"]);
  assert.equal(v.length, 1);
  assert.match(v[0].reason, /lines 10-50 claimed by alice/);
});
