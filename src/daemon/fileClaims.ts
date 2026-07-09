import type { Session } from "../shared/types.js";
import { now } from "../shared/ids.js";
import type { Registry } from "./registry.js";

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
export function claimFile(reg: Registry, session: Session, agentId: string, filepath: string, wait = false): ClaimResult {
  const existing = session.claims.find((c) => c.filepath === filepath);
  if (existing) {
    if (existing.agentId === agentId) {
      existing.lastActivityAt = now();
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
  session.claims.push({ filepath, agentId, status: "claimed", claimedAt: now(), lastActivityAt: now() });
  reg.event(session, "claim", agentId, { filepath });
  return { ok: true, granted: true };
}

/** Release a claim; hands the file to the next queued agent, if any. */
export function releaseFile(reg: Registry, session: Session, agentId: string, filepath: string): { ok: boolean; error?: string } {
  const idx = session.claims.findIndex((c) => c.filepath === filepath);
  if (idx === -1) return { ok: false, error: "no claim on that file" };
  if (session.claims[idx].agentId !== agentId) {
    return { ok: false, error: `claim is held by ${agentName(session, session.claims[idx].agentId)}, not you` };
  }
  session.claims.splice(idx, 1);
  reg.event(session, "release", agentId, { filepath });
  grantToNextWaiter(reg, session, filepath);
  return { ok: true };
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
  const cutoff = Date.now() - session.config.claimTimeoutMinutes * 60_000;
  for (const claim of [...session.claims]) {
    if (new Date(claim.lastActivityAt).getTime() < cutoff) {
      session.claims = session.claims.filter((c) => c !== claim);
      reg.event(session, "claim-timeout", claim.agentId, { filepath: claim.filepath });
      reg.notice(
        session,
        `claim on ${claim.filepath} by ${agentName(session, claim.agentId)} auto-released after ${session.config.claimTimeoutMinutes}m of inactivity`
      );
      grantToNextWaiter(reg, session, claim.filepath);
    }
  }
}
