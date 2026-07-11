import type { SemanticClaim, Session } from "../shared/types.js";
import { now } from "../shared/ids.js";
import type { Registry } from "./registry.js";
import { effectiveTimeoutMinutes, recordClaimDuration } from "./intelligence.js";

export type ClaimResult =
  | { ok: true; granted: true }
  | { ok: true; granted: false; queued: true; position: number; heldBy: string }
  | { ok: false; error: string; heldBy?: string };

function agentName(session: Session, agentId: string): string {
  return session.agents.find((a) => a.id === agentId)?.name ?? agentId;
}

/**
 * Attempt to lock a file for an agent. With `wait`, a held file queues the
 * agent FIFO instead of hard-rejecting (V2 #2); the claim is auto-granted
 * when the holder releases or times out.
 */
export function claimFile(
  reg: Registry,
  session: Session,
  agentId: string,
  filepath: string,
  wait = false,
  timeoutMinutes?: number
): ClaimResult {
  const existing = session.claims.find((c) => c.filepath === filepath);
  if (existing) {
    if (existing.agentId === agentId) {
      existing.lastActivityAt = now();
      if (timeoutMinutes !== undefined) existing.timeoutMinutes = timeoutMinutes;
      reg.save(session);
      return { ok: true, granted: true };
    }
    if (!wait) {
      return { ok: false, error: `already claimed by ${agentName(session, existing.agentId)}`, heldBy: existing.agentId };
    }
    let wl = session.waitlists.find((w) => w.filepath === filepath);
    if (!wl) {
      wl = { filepath, waitingAgentIds: [] };
      session.waitlists.push(wl);
    }
    if (!wl.waitingAgentIds.includes(agentId)) wl.waitingAgentIds.push(agentId);
    reg.event(session, "claim-queued", agentId, { filepath, heldBy: existing.agentId });
    reg.notice(
      session,
      `${agentName(session, agentId)} is waiting on ${filepath} (currently held by ${agentName(session, existing.agentId)})`
    );
    return {
      ok: true,
      granted: false,
      queued: true,
      position: wl.waitingAgentIds.indexOf(agentId) + 1,
      heldBy: existing.agentId,
    };
  }
  // A file-level claim also requires no other agent's line-range claims on it (V5 #1).
  const lineHolder = session.semanticClaims.find((c) => c.filepath === filepath && c.agentId !== agentId);
  if (lineHolder) {
    return { ok: false, error: `lines ${lineHolder.startLine}-${lineHolder.endLine} are claimed by ${agentName(session, lineHolder.agentId)} — claim a range or wait`, heldBy: lineHolder.agentId };
  }
  session.claims.push({ filepath, agentId, status: "claimed", claimedAt: now(), lastActivityAt: now(), timeoutMinutes });
  reg.event(session, "claim", agentId, { filepath });
  return { ok: true, granted: true };
}

// ---- V5 #1 — line-range claims: finer than a file, coarser than nothing ------

export function claimLines(
  reg: Registry,
  session: Session,
  agentId: string,
  filepath: string,
  startLine: number,
  endLine: number
): { ok: boolean; error?: string } {
  if (!(startLine >= 1 && endLine >= startLine)) return { ok: false, error: "bad line range" };
  // A whole-file claim by someone else trumps every range (coarse beats fine).
  const fileClaim = session.claims.find((c) => c.filepath === filepath);
  if (fileClaim && fileClaim.agentId !== agentId) {
    return { ok: false, error: `whole file is claimed by ${agentName(session, fileClaim.agentId)}` };
  }
  const overlap = session.semanticClaims.find(
    (c) => c.filepath === filepath && c.agentId !== agentId && c.startLine <= endLine && c.endLine >= startLine
  );
  if (overlap) {
    return { ok: false, error: `lines ${overlap.startLine}-${overlap.endLine} already claimed by ${agentName(session, overlap.agentId)}` };
  }
  const claim: SemanticClaim = { filepath, startLine, endLine, agentId, claimedAt: now(), lastActivityAt: now() };
  session.semanticClaims.push(claim);
  reg.event(session, "claim-lines", agentId, { filepath, startLine, endLine });
  return { ok: true };
}

export function releaseLines(reg: Registry, session: Session, agentId: string, filepath: string): { ok: boolean; error?: string } {
  const before = session.semanticClaims.length;
  session.semanticClaims = session.semanticClaims.filter((c) => !(c.filepath === filepath && c.agentId === agentId));
  if (session.semanticClaims.length === before) return { ok: false, error: "no line claims of yours on that file" };
  reg.event(session, "release-lines", agentId, { filepath });
  return { ok: true };
}

/** Release a claim; hands the file to the next queued agent, if any. */
export function releaseFile(reg: Registry, session: Session, agentId: string, filepath: string): { ok: boolean; error?: string } {
  const idx = session.claims.findIndex((c) => c.filepath === filepath);
  if (idx === -1) return { ok: false, error: "no claim on that file" };
  if (session.claims[idx].agentId !== agentId) {
    return { ok: false, error: `claim is held by ${agentName(session, session.claims[idx].agentId)}, not you` };
  }
  const [released] = session.claims.splice(idx, 1);
  // Feed the adaptive-timeout learner (V5 #7) with how long work actually took.
  recordClaimDuration(reg.dataDir, filepath, (Date.now() - new Date(released.claimedAt).getTime()) / 60_000);
  reg.event(session, "release", agentId, { filepath });
  grantToNextWaiter(reg, session, filepath);
  return { ok: true };
}

/**
 * Full cleanup when an agent leaves or is detected dead: drop it from every
 * waitlist (so it can't be granted files it isn't around to use), release its
 * line-range claims, then release its file claims (handing off to waiters).
 */
export function releaseAgentPresence(reg: Registry, session: Session, agentId: string): void {
  for (const wl of [...session.waitlists]) {
    wl.waitingAgentIds = wl.waitingAgentIds.filter((id) => id !== agentId);
  }
  session.waitlists = session.waitlists.filter((w) => w.waitingAgentIds.length > 0);
  for (const claim of [...session.semanticClaims].filter((c) => c.agentId === agentId)) {
    releaseLines(reg, session, agentId, claim.filepath);
  }
  for (const claim of [...session.claims].filter((c) => c.agentId === agentId)) {
    releaseFile(reg, session, agentId, claim.filepath);
  }
}

/** Mark activity on a claim so the timeout sweeper doesn't reap it. */
export function touchClaim(session: Session, agentId: string, filepath: string): boolean {
  const claim = session.claims.find((c) => c.filepath === filepath && c.agentId === agentId);
  if (!claim) return false;
  claim.lastActivityAt = now();
  return true;
}

function grantToNextWaiter(reg: Registry, session: Session, filepath: string): void {
  const wl = session.waitlists.find((w) => w.filepath === filepath);
  if (!wl || wl.waitingAgentIds.length === 0) return;
  const nextId = wl.waitingAgentIds.shift()!;
  if (wl.waitingAgentIds.length === 0) {
    session.waitlists = session.waitlists.filter((w) => w !== wl);
  }
  session.claims.push({ filepath, agentId: nextId, status: "claimed", claimedAt: now(), lastActivityAt: now() });
  reg.event(session, "claim-granted-from-waitlist", nextId, { filepath });
  reg.notice(session, `${agentName(session, nextId)} was granted ${filepath} from the waitlist`);
}

/**
 * Auto-release claims idle past the configured timeout (V1 rule 2), with a
 * chat notice. Called periodically by the daemon.
 */
export function sweepClaimTimeouts(reg: Registry, session: Session): void {
  if (session.status !== "active") return;
  for (const claim of [...session.claims]) {
    // V5 #7 — per-file learned timeout: explicit override > p90 history > default.
    const timeout = effectiveTimeoutMinutes(reg.dataDir, session, claim.filepath, claim.timeoutMinutes);
    if (new Date(claim.lastActivityAt).getTime() < Date.now() - timeout * 60_000) {
      session.claims = session.claims.filter((c) => c !== claim);
      reg.event(session, "claim-timeout", claim.agentId, { filepath: claim.filepath, timeoutMinutes: timeout });
      reg.notice(
        session,
        `claim on ${claim.filepath} by ${agentName(session, claim.agentId)} auto-released after ${timeout}m of inactivity`
      );
      grantToNextWaiter(reg, session, claim.filepath);
    }
  }
  // Line-range claims sweep on the session default (no per-range learning).
  const rangeCutoff = Date.now() - session.config.claimTimeoutMinutes * 60_000;
  for (const claim of [...session.semanticClaims]) {
    if (new Date(claim.lastActivityAt).getTime() < rangeCutoff) {
      session.semanticClaims = session.semanticClaims.filter((c) => c !== claim);
      reg.event(session, "claim-lines-timeout", claim.agentId, { filepath: claim.filepath });
      reg.notice(session, `line claim ${claim.filepath}:${claim.startLine}-${claim.endLine} (${agentName(session, claim.agentId)}) auto-released`);
    }
  }
}
