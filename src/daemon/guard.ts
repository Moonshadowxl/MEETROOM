import type { Session } from "../shared/types.js";
import { pathTailMatches } from "./memory.js";

// Core rule 1 ("no file is edited without a claim") as an enforceable check
// instead of an honor system. `meetroom guard check` evaluates this against
// live session state from a git pre-commit hook or a Claude Code PreToolUse
// hook. Pure function so the rule is testable without a daemon.

export type GuardViolation = { file: string; reason: string };

/**
 * A file passes when the acting agent holds its claim (whole-file, or any
 * line-range when nobody else holds the whole file). Unclaimed files and
 * files held by someone else are violations.
 */
export function evaluateGuard(session: Session, agentId: string, files: string[]): GuardViolation[] {
  const violations: GuardViolation[] = [];
  const name = (id: string) => session.agents.find((a) => a.id === id)?.name ?? id;
  for (const file of files) {
    const claim = session.claims.find((c) => pathTailMatches(c.filepath, file));
    if (claim) {
      if (claim.agentId !== agentId) {
        violations.push({ file, reason: `claimed by ${name(claim.agentId)} — queue with \`meetroom claim ${file} --wait\`` });
      }
      continue;
    }
    if (session.semanticClaims.some((c) => pathTailMatches(c.filepath, file) && c.agentId === agentId)) continue;
    const lines = session.semanticClaims.find((c) => pathTailMatches(c.filepath, file) && c.agentId !== agentId);
    violations.push({
      file,
      reason: lines
        ? `lines ${lines.startLine}-${lines.endLine} claimed by ${name(lines.agentId)} — claim your own range (\`meetroom claim ${file} --lines A-B\`)`
        : `no claim — run \`meetroom claim ${file}\` first`,
    });
  }
  return violations;
}
