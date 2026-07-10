import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Review, Session, Task } from "../shared/types.js";
import { now } from "../shared/ids.js";
import type { Registry } from "./registry.js";

// V5 — the intelligence layer. Every function here degrades gracefully to a
// deterministic heuristic when no model command is configured: intelligence
// is an upgrade, never a dependency.

// ---- #2 conflict prediction -----------------------------------------------------

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Advisory-only: compare a new task against open tasks by shared files and
 * text similarity. Never blocks creation.
 */
export function predictConflicts(session: Session, task: Task): string[] {
  const warnings: string[] = [];
  const myTokens = tokenize(`${task.title} ${task.description}`);
  for (const other of session.tasks) {
    if (other.id === task.id || other.status === "done") continue;
    const sharedFiles = task.files.filter((f) => other.files.includes(f));
    const similarity = jaccard(myTokens, tokenize(`${other.title} ${other.description}`));
    if (sharedFiles.length > 0) {
      warnings.push(`likely conflicts with ${other.id} ("${other.title}") — both touch ${sharedFiles.join(", ")}`);
    } else if (similarity > 0.5) {
      warnings.push(`similar scope to ${other.id} ("${other.title}") — consider a dependsOn`);
    }
  }
  return warnings;
}

// ---- #3 review copilot -------------------------------------------------------------

/**
 * First-pass triage on a submitted diff via MEETROOM_REVIEWER (any LLM CLI:
 * diff on stdin, JSON findings on stdout). The copilot can never approve —
 * it annotates so the peer/human review is faster.
 */
export function runReviewCopilot(reg: Registry, session: Session, review: Review): void {
  const cmd = process.env.MEETROOM_REVIEWER;
  if (!cmd) return;
  // Runs in the background: a slow reviewer model must never stall the daemon
  // (this is called from the review-submit request path). Findings are
  // attached to the review whenever they arrive.
  const child = execFile("sh", ["-c", cmd], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
    if (err) return; // copilot failure must never block a submission
    try {
      const parsed = JSON.parse(out) as { severity?: string; line?: number; text: string }[];
      if (!Array.isArray(parsed)) return;
      review.copilotFindings = parsed
        .filter((f) => typeof f.text === "string")
        .map((f) => ({
          severity: f.severity === "blocker" || f.severity === "warn" ? f.severity : "info",
          line: f.line,
          text: f.text,
        }));
      for (const f of review.copilotFindings) {
        review.comments.push({ agentId: "copilot", line: f.line, text: `[${f.severity}] ${f.text}`, ts: now() });
      }
      review.copilotVerdict = review.copilotFindings.some((f) => f.severity !== "info") ? "needs-attention" : "looks-clean";
      reg.event(session, "copilot-review", "copilot", { reviewId: review.id, verdict: review.copilotVerdict, findings: review.copilotFindings.length });
      if (review.copilotVerdict === "needs-attention" && review.authorConfidence === "low") {
        // Strongest "a human should look" signal in the system (spec V5 #3).
        reg.addAttention(session.id, "low-confidence-review", `review ${review.id}: low author confidence + copilot flags`);
      }
    } catch {
      // Malformed copilot output: skip annotations.
    }
  });
  child.stdin?.on("error", () => {}); // reviewer may exit before reading the diff
  child.stdin?.end(review.diff);
}

// ---- #7 adaptive timeouts ------------------------------------------------------------

type ClaimStats = Record<string, number[]>; // filepath → recent active-claim durations (minutes)

function statsPath(dataDir: string): string {
  return join(dataDir, "..", "claim-stats.json");
}

export function loadClaimStats(dataDir: string): ClaimStats {
  const p = statsPath(dataDir);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ClaimStats;
  } catch {
    return {};
  }
}

export function recordClaimDuration(dataDir: string, filepath: string, minutes: number): void {
  const stats = loadClaimStats(dataDir);
  stats[filepath] = [...(stats[filepath] ?? []), Math.round(minutes * 100) / 100].slice(-25);
  writeFileSync(statsPath(dataDir), JSON.stringify(stats, null, 2));
}

/**
 * Effective timeout for a file: explicit override > learned p90 (clamped to
 * [5, 45] minutes, needs ≥3 samples) > session default.
 */
export function effectiveTimeoutMinutes(dataDir: string, session: Session, filepath: string, override?: number): number {
  if (override) return override;
  const samples = loadClaimStats(dataDir)[filepath];
  if (samples && samples.length >= 3) {
    const sorted = [...samples].sort((a, b) => a - b);
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
    return Math.min(45, Math.max(5, Math.ceil(p90 * 1.5)));
  }
  return session.config.claimTimeoutMinutes;
}
