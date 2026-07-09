import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/daemon/registry.js";
import { claimFile, releaseFile, sweepClaimTimeouts, touchClaim } from "../src/daemon/fileClaims.js";
import type { Agent, Session } from "../src/shared/types.js";

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

test("claim grants an unclaimed file and re-claim by holder is idempotent", () => {
  const { reg, session, a } = setup();
  const r1 = claimFile(reg, session, a.id, "src/auth.py");
  assert.equal(r1.ok && r1.granted, true);
  const r2 = claimFile(reg, session, a.id, "src/auth.py");
  assert.equal(r2.ok && r2.granted, true);
  assert.equal(session.claims.length, 1);
});

test("claim on a held file is rejected without --wait", () => {
  const { reg, session, a, b } = setup();
  claimFile(reg, session, a.id, "src/auth.py");
  const r = claimFile(reg, session, b.id, "src/auth.py");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /already claimed by alice/);
});

test("wait queues FIFO and release auto-grants to the next waiter", () => {
  const { reg, session, a, b } = setup();
  claimFile(reg, session, a.id, "src/auth.py");
  const r = claimFile(reg, session, b.id, "src/auth.py", true);
  assert.equal(r.ok && !r.granted && r.queued, true);
  // The wait is visible to the whole room via chat (V2 #2).
  assert.ok(session.chatLog.some((m) => m.message.includes("bob is waiting on src/auth.py")));

  const rel = releaseFile(reg, session, a.id, "src/auth.py");
  assert.equal(rel.ok, true);
  const claim = session.claims.find((c) => c.filepath === "src/auth.py");
  assert.equal(claim?.agentId, b.id);
  assert.equal(session.waitlists.length, 0);
});

test("only the holder can release", () => {
  const { reg, session, a, b } = setup();
  claimFile(reg, session, a.id, "x.ts");
  const r = releaseFile(reg, session, b.id, "x.ts");
  assert.equal(r.ok, false);
});

test("idle claims time out, notify the room, and hand off to waiters", () => {
  const { reg, session, a, b } = setup();
  session.config.claimTimeoutMinutes = 10;
  claimFile(reg, session, a.id, "src/db.ts");
  claimFile(reg, session, b.id, "src/db.ts", true);
  const claim = session.claims[0];
  claim.lastActivityAt = new Date(Date.now() - 11 * 60_000).toISOString();
  sweepClaimTimeouts(reg, session);
  assert.ok(session.chatLog.some((m) => m.message.includes("auto-released")));
  assert.equal(session.claims.find((c) => c.filepath === "src/db.ts")?.agentId, b.id);
});

test("touch refreshes activity so the sweep spares the claim", () => {
  const { reg, session, a } = setup();
  session.config.claimTimeoutMinutes = 10;
  claimFile(reg, session, a.id, "src/db.ts");
  session.claims[0].lastActivityAt = new Date(Date.now() - 11 * 60_000).toISOString();
  assert.equal(touchClaim(session, a.id, "src/db.ts"), true);
  sweepClaimTimeouts(reg, session);
  assert.equal(session.claims.length, 1);
});

test("paused sessions are not swept", () => {
  const { reg, session, a } = setup();
  claimFile(reg, session, a.id, "src/db.ts");
  session.claims[0].lastActivityAt = new Date(Date.now() - 60 * 60_000).toISOString();
  session.status = "paused";
  sweepClaimTimeouts(reg, session);
  assert.equal(session.claims.length, 1);
});
