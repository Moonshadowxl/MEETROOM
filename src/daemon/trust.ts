import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Operator, PolicyRule, Session, Task } from "../shared/types.js";
import { entityId, now } from "../shared/ids.js";

// V6 — teams & trust: multi-operator identity (#1), policy engine (#3),
// secrets with redaction (#5), retention/purge (#8).

// ---- #1 operators (daemon-global, stored beside sessions) ---------------------

const ROLE_RANK = { observer: 0, reviewer: 1, maintainer: 2, owner: 3 } as const;
export type OperatorRole = keyof typeof ROLE_RANK;

export function operatorsPath(dataDir: string): string {
  return join(dataDir, "..", "operators.json");
}

export function loadOperators(dataDir: string): Operator[] {
  const p = operatorsPath(dataDir);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Operator[];
  } catch {
    return [];
  }
}

export function saveOperators(dataDir: string, ops: Operator[]): void {
  writeFileSync(operatorsPath(dataDir), JSON.stringify(ops, null, 2));
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function inviteOperator(dataDir: string, name: string, role: OperatorRole): { operator: Operator; key: string } {
  const ops = loadOperators(dataDir);
  const key = `mrop_${randomBytes(24).toString("hex")}`;
  const operator: Operator = { id: entityId("op"), name, role, keyHash: hashKey(key), createdAt: now() };
  ops.push(operator);
  saveOperators(dataDir, ops);
  return { operator, key }; // the key is shown exactly once
}

export function resolveOperator(dataDir: string, key: string | undefined): Operator | undefined {
  if (!key) return undefined;
  const hash = hashKey(key);
  return loadOperators(dataDir).find((o) => o.keyHash === hash);
}

/**
 * Solo mode (no operators configured) grants everything — zero ceremony for
 * the single-user case. Once operators exist, privileged actions need a key
 * of sufficient role.
 */
export function operatorAllowed(dataDir: string, key: string | undefined, minRole: OperatorRole): { ok: boolean; operator?: Operator; error?: string } {
  const ops = loadOperators(dataDir);
  if (ops.length === 0) return { ok: true };
  const operator = resolveOperator(dataDir, key);
  if (!operator) return { ok: false, error: "operator key required (x-meetroom-operator) — ask the owner for an invite" };
  if (ROLE_RANK[operator.role] < ROLE_RANK[minRole]) {
    return { ok: false, error: `requires role ${minRole}+ (you are ${operator.role})` };
  }
  return { ok: true, operator };
}

// ---- #3 policy engine (.meetroom/policy.json, committed with the repo) --------

export function loadPolicy(cwd: string): PolicyRule[] {
  const p = join(cwd, ".meetroom", "policy.json");
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? (parsed as PolicyRule[]) : [];
  } catch {
    return [];
  }
}

// Glob-lite: "src/payments/**" (prefix), "*.sql" (suffix), exact match.
export function pathMatches(pattern: string, filepath: string): boolean {
  if (pattern.endsWith("/**")) return filepath.startsWith(pattern.slice(0, -2));
  if (pattern.startsWith("*")) return filepath.endsWith(pattern.slice(1));
  return filepath === pattern;
}

export function rulesForTask(rules: PolicyRule[], task: Task): PolicyRule[] {
  return rules.filter((rule) => {
    const pathHit = !rule.match.paths || task.files.some((f) => rule.match.paths!.some((p) => pathMatches(p, f)));
    const complexityHit = !rule.match.taskComplexity || rule.match.taskComplexity.includes(task.estimatedComplexity ?? "moderate");
    return pathHit && complexityHit;
  });
}

/**
 * Evaluate the done-gate against policy. Policy can only ADD requirements on
 * top of the task's own flags — flags can never remove what policy demands.
 */
export function policyViolations(session: Session, task: Task, dataDir: string): string[] {
  const rules = rulesForTask(loadPolicy(session.cwd), task);
  const violations: string[] = [];
  const approvals = session.reviews.filter((r) => r.taskId === task.id && r.status === "approved");
  const operatorNames = new Set(["human", ...loadOperators(dataDir).map((o) => o.name)]);
  for (const rule of rules) {
    for (const req of rule.require) {
      switch (req) {
        case "human-review":
          if (!approvals.some((r) => r.reviewerAgentId && operatorNames.has(r.reviewerAgentId))) {
            violations.push(`policy ${rule.id}: requires a human/operator-approved review`);
          }
          break;
        case "two-reviewers":
          if (new Set(approvals.map((r) => r.reviewerAgentId)).size < 2) {
            violations.push(`policy ${rule.id}: requires approvals from two distinct reviewers`);
          }
          break;
        case "ci-pass":
          if (session.ciStatuses.find((c) => c.taskId === task.id)?.status !== "passed") {
            violations.push(`policy ${rule.id}: requires CI to pass`);
          }
          break;
        case "tests-pass":
          if (task.testResult !== "passed") {
            violations.push(`policy ${rule.id}: requires a passing test result`);
          }
          break;
      }
    }
  }
  return violations;
}

// ---- #5 secrets (encrypted at rest, redacted from persisted text) ---------------

function meetroomHome(): string {
  return process.env.MEETROOM_HOME ?? join(homedir(), ".meetroom");
}

function secretKeyPath(): string {
  return join(meetroomHome(), "secret.key");
}

function secretsFilePath(): string {
  return join(meetroomHome(), "secrets.json.enc");
}

function masterKey(): Buffer {
  if (!existsSync(secretKeyPath())) {
    mkdirSync(meetroomHome(), { recursive: true });
    writeFileSync(secretKeyPath(), randomBytes(32), { mode: 0o600 });
  }
  return readFileSync(secretKeyPath());
}

export function loadSecrets(): Record<string, string> {
  if (!existsSync(secretsFilePath())) return {};
  try {
    const raw = readFileSync(secretsFilePath());
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", masterKey(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
  } catch {
    return {};
  }
}

export function saveSecrets(secrets: Record<string, string>): void {
  redactCache = undefined; // redaction must see new values immediately
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  mkdirSync(meetroomHome(), { recursive: true });
  writeFileSync(secretsFilePath(), Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 0o600 });
}

/** Substitute {secret:NAME} placeholders at exec time — values never enter session state. */
export function resolveSecrets(template: string): string {
  return template.replace(/\{secret:([A-Za-z0-9_-]+)\}/g, (_, name) => {
    const value = loadSecrets()[name];
    if (value === undefined) throw new Error(`secret "${name}" is not set (meetroom secret set ${name})`);
    return value;
  });
}

// Redaction: the daemon is the last line of defense when an agent pastes a
// token into chat. Cached briefly so per-message cost stays negligible.
let redactCache: { values: [string, string][]; at: number } | undefined;

export function redactSecrets(text: string): string {
  if (!redactCache || Date.now() - redactCache.at > 30_000) {
    redactCache = { values: Object.entries(loadSecrets()).map(([k, v]) => [k, v]), at: Date.now() };
  }
  let out = text;
  for (const [name, value] of redactCache.values) {
    if (value.length >= 6 && out.includes(value)) out = out.split(value).join(`[redacted:${name}]`);
  }
  return out;
}

// ---- #8 retention / purge ----------------------------------------------------------

/** Strip bulky/sensitive payloads from an ended session; keep the record. */
export function purgeSession(session: Session, dataDir: string, report: string): string {
  const dir = join(dataDir, "..", "exports");
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, `${session.id}.md`);
  writeFileSync(reportPath, report);
  session.chatLog = [];
  for (const r of session.reviews) r.diff = "[purged]";
  for (const a of session.artifacts) a.content = "[purged]";
  return reportPath;
}
