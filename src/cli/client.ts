import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Thin HTTP client + local context resolution used by every command.
//
// Per-project context lives in .meetroom/ inside the project dir:
//   .meetroom/lock            — { sessionId, host, port, token? } marker that a
//                               session is active here (V1 §2)
//   .meetroom/agents/<name>.json — this agent's { agentId, name } after join
//
// Which agent a command acts as: --as <name> flag, else MEETROOM_AGENT env,
// else the only joined agent in this cwd, else "human".

export const DEFAULT_PORT = 7433;

export type RoomContext = {
  sessionId: string;
  host: string;
  port: number;
  token?: string;
  scheme?: "http" | "https"; // https for daemons started with MEETROOM_TLS_CERT/KEY
};

/** Base URL for a daemon, honoring the https scheme for TLS rooms (V6 #2). */
export function baseUrl(ctx: Pick<RoomContext, "host" | "port" | "scheme">): string {
  return `${ctx.scheme ?? "http"}://${ctx.host}:${ctx.port}`;
}

export function meetroomDir(cwd = process.cwd()): string {
  return join(cwd, ".meetroom");
}

export function lockPath(cwd = process.cwd()): string {
  return join(meetroomDir(cwd), "lock");
}

export function writeLock(ctx: RoomContext, cwd = process.cwd()): void {
  mkdirSync(meetroomDir(cwd), { recursive: true });
  writeFileSync(lockPath(cwd), JSON.stringify(ctx, null, 2));
}

export function readLock(cwd = process.cwd()): RoomContext | undefined {
  if (!existsSync(lockPath(cwd))) return undefined;
  try {
    return JSON.parse(readFileSync(lockPath(cwd), "utf8")) as RoomContext;
  } catch {
    return undefined;
  }
}

export function agentContextPath(name: string, cwd = process.cwd()): string {
  return join(meetroomDir(cwd), "agents", `${name}.json`);
}

export function saveAgentContext(name: string, agentId: string, cwd = process.cwd()): void {
  mkdirSync(join(meetroomDir(cwd), "agents"), { recursive: true });
  writeFileSync(agentContextPath(name, cwd), JSON.stringify({ name, agentId }, null, 2));
}

export function resolveAgentId(flags: Flags, cwd = process.cwd()): string {
  const name = (flags.as as string) ?? process.env.MEETROOM_AGENT;
  if (name) {
    const p = agentContextPath(name, cwd);
    if (existsSync(p)) return (JSON.parse(readFileSync(p, "utf8")) as { agentId: string }).agentId;
    fail(`no agent named "${name}" has joined from this directory (looked for ${p})`);
  }
  // Fall back to the single joined agent, if unambiguous.
  const dir = join(meetroomDir(cwd), "agents");
  if (existsSync(dir)) {
    const files = readdirSafe(dir).filter((f) => f.endsWith(".json"));
    if (files.length === 1) {
      return (JSON.parse(readFileSync(join(dir, files[0]), "utf8")) as { agentId: string }).agentId;
    }
    if (files.length > 1) {
      fail(`multiple agents joined from this directory — pass --as <name> or set MEETROOM_AGENT (found: ${files.map((f) => f.replace(/\.json$/, "")).join(", ")})`);
    }
  }
  return "human";
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function requireContext(flags: Flags, cwd = process.cwd()): RoomContext {
  const explicit = flags.session as string | undefined;
  const lock = readLock(cwd);
  const host = (flags.host as string) ?? lock?.host ?? "127.0.0.1";
  const port = flags.port ? Number(flags.port) : lock?.port ?? Number(process.env.MEETROOM_PORT ?? DEFAULT_PORT);
  const token = (flags.token as string) ?? lock?.token;
  const scheme = flags.https || process.env.MEETROOM_SCHEME === "https" ? "https" as const : lock?.scheme;
  const sessionId = explicit ?? lock?.sessionId;
  if (!sessionId) {
    fail("no active meetroom session here — run `meetroom start` or pass --session <id> (and --host/--port for remote rooms)");
  }
  return { sessionId, host, port, token, scheme };
}

/** Operator identity (V6 #1): env var wins, then ~/.meetroom/credentials.json. */
export function storedOperatorKey(): string | undefined {
  if (process.env.MEETROOM_OPERATOR_KEY) return process.env.MEETROOM_OPERATOR_KEY;
  const p = join(process.env.MEETROOM_HOME ?? join(homedir(), ".meetroom"), "credentials.json");
  if (!existsSync(p)) return undefined;
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { key: string }).key;
  } catch {
    return undefined;
  }
}

export async function api<T = any>(
  ctx: Pick<RoomContext, "host" | "port" | "token" | "scheme">,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${baseUrl(ctx)}${path}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ctx.token) headers["x-meetroom-token"] = ctx.token;
  const opKey = storedOperatorKey();
  if (opKey) headers["x-meetroom-operator"] = opKey;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    fail(`cannot reach meetroom daemon at ${url} — is it running? (\`meetroom start\` launches it)`);
  }
  const data = (await res!.json().catch(() => ({}))) as any;
  if (!res!.ok || data.ok === false) {
    fail(data.error ?? `daemon returned HTTP ${res!.status}`);
  }
  return data as T;
}

export function fail(message: string): never {
  console.error(`meetroom: ${message}`);
  process.exit(1);
}

// ---- tiny flag parser --------------------------------------------------------

export type Flags = Record<string, string | boolean>;

export type Parsed = { positional: string[]; flags: Flags };

// Flags that never take a value. Without this, `meetroom claim --wait src/x.ts`
// would swallow "src/x.ts" as the value of --wait and lose the positional.
const BOOLEAN_FLAGS = new Set([
  "wait",
  "remote",
  "project",
  "user",
  "yes",
  "pr",
  "confirm",
  "https",
  "requires-ci",
  "requires-tests",
  "require-pr-merge",
  "claude",
  "staged",
  "hook-stdin",
]);

/** `--flag value`, `--flag=value`, and bare `--flag` (boolean) forms. */
export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export function csv(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}
