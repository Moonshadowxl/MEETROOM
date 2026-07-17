import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Session } from "../../shared/types.js";
import { baseUrl, fail, readLock, type Parsed } from "../client.js";
import { evaluateGuard } from "../../daemon/guard.js";

// `meetroom guard` — turns core rule 1 ("no file is edited without a claim")
// into an enforced check instead of a convention:
//   guard install            git pre-commit hook (blocks commits)
//   guard install --claude   also a Claude Code PreToolUse hook (blocks edits)
//   guard check              the shared brain both hooks call
//
// Fail-open by design: when meetroom isn't in play (no lock, daemon down,
// acting as the human, ambiguous agent context) the guard passes silently —
// it must never break normal git usage. It only enforces when an agent
// identity and a live session are both unambiguous.

const HOOK_MARKER = "# meetroom-guard";
const PRE_COMMIT_LINE = "meetroom guard check --staged";
const PRE_COMMIT_BODY = `#!/bin/sh
${HOOK_MARKER} — blocks commits touching files not claimed by the acting agent.
# Installed by \`meetroom guard install\`; remove with \`meetroom guard uninstall\`.
${PRE_COMMIT_LINE}
`;
const CLAUDE_HOOK_COMMAND = "meetroom guard check --hook-stdin";

export async function cmdGuard(parsed: Parsed): Promise<void> {
  const [sub, ...rest] = parsed.positional;
  if (sub === "install") return install(parsed);
  if (sub === "uninstall") return uninstall(parsed);
  if (sub === "check") return check(parsed, rest);
  fail(`unknown guard subcommand "${sub}" (install [--claude] | uninstall | check [--staged | --hook-stdin | <files...>])`);
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function preCommitPath(): string | undefined {
  try {
    return resolve(git(["rev-parse", "--git-path", "hooks"]), "pre-commit");
  } catch {
    return undefined; // not a git repo
  }
}

function claudeSettingsPath(): string {
  return join(process.cwd(), ".claude", "settings.json");
}

async function install(parsed: Parsed): Promise<void> {
  const hookPath = preCommitPath();
  if (!hookPath) fail("not a git repository — the guard's pre-commit hook needs one");
  if (existsSync(hookPath!)) {
    const current = readFileSync(hookPath!, "utf8");
    if (current.includes(HOOK_MARKER)) {
      console.log("pre-commit guard already installed");
    } else {
      fail(`a pre-commit hook already exists at ${hookPath} — add this line to it yourself:\n  ${PRE_COMMIT_LINE}`);
    }
  } else {
    writeFileSync(hookPath!, PRE_COMMIT_BODY);
    chmodSync(hookPath!, 0o755);
    console.log(`pre-commit guard installed: ${hookPath}`);
    console.log("commits by an agent (MEETROOM_AGENT set) now require claims on every touched file");
  }

  // Claude Code PreToolUse hook: blocks the edit itself, not just the commit
  // (and can't be skipped with --no-verify).
  if (parsed.flags.claude) {
    const p = claudeSettingsPath();
    let settings: any = {};
    if (existsSync(p)) {
      try {
        settings = JSON.parse(readFileSync(p, "utf8"));
      } catch {
        fail(`${p} is not valid JSON — fix it, then re-run`);
      }
    }
    settings.hooks ??= {};
    settings.hooks.PreToolUse ??= [];
    const installed = settings.hooks.PreToolUse.some((entry: any) =>
      entry?.hooks?.some((h: any) => typeof h?.command === "string" && h.command.includes("meetroom guard check"))
    );
    if (installed) {
      console.log("Claude Code guard hook already present in .claude/settings.json");
    } else {
      settings.hooks.PreToolUse.push({
        matcher: "Edit|Write|NotebookEdit",
        hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND }],
      });
      mkdirSync(join(process.cwd(), ".claude"), { recursive: true });
      writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
      console.log(`Claude Code guard hook written to ${p} (blocks Edit/Write on unclaimed files)`);
    }
  }
}

async function uninstall(_parsed: Parsed): Promise<void> {
  const hookPath = preCommitPath();
  if (hookPath && existsSync(hookPath) && readFileSync(hookPath, "utf8").includes(HOOK_MARKER)) {
    rmSync(hookPath);
    console.log("pre-commit guard removed");
  } else {
    console.log("no meetroom pre-commit guard found");
  }
  const p = claudeSettingsPath();
  if (existsSync(p)) {
    try {
      const settings = JSON.parse(readFileSync(p, "utf8"));
      const before = settings.hooks?.PreToolUse?.length ?? 0;
      if (settings.hooks?.PreToolUse) {
        settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
          (entry: any) => !entry?.hooks?.some((h: any) => typeof h?.command === "string" && h.command.includes("meetroom guard check"))
        );
        if (settings.hooks.PreToolUse.length !== before) {
          writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
          console.log("Claude Code guard hook removed from .claude/settings.json");
        }
      }
    } catch {
      // unreadable settings: leave them alone
    }
  }
}

/** Resolve who is acting, without hard-failing: hooks must not block commits
 *  over broken meetroom state. Returns undefined for "don't enforce".
 *  Only an EXPLICIT identity (--as or MEETROOM_AGENT, which agent shells
 *  always set) is enforced — the human at the same keyboard, with no agent
 *  env, commits freely. */
function softResolveAgentId(parsed: Parsed): string | undefined {
  const name = (parsed.flags.as as string) ?? process.env.MEETROOM_AGENT;
  if (!name) return undefined;
  try {
    const p = join(process.cwd(), ".meetroom", "agents", `${name}.json`);
    return (JSON.parse(readFileSync(p, "utf8")) as { agentId: string }).agentId;
  } catch {
    console.error(`meetroom guard: agent "${name}" has no context here — passing (join first for enforcement)`);
    return undefined;
  }
}

async function check(parsed: Parsed, positional: string[]): Promise<void> {
  const hookMode = !!parsed.flags["hook-stdin"];

  // 1. Which files are being touched?
  let files: string[];
  if (hookMode) {
    const raw = readFileSync(0, "utf8"); // Claude Code hook JSON on stdin
    let filePath: string | undefined;
    try {
      filePath = JSON.parse(raw)?.tool_input?.file_path;
    } catch {
      return; // malformed hook payload: pass
    }
    if (!filePath) return;
    files = [filePath];
  } else if (parsed.flags.staged) {
    try {
      const top = git(["rev-parse", "--show-toplevel"]);
      files = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
        .split("\n")
        .filter(Boolean)
        .map((f) => resolve(top, f));
    } catch {
      return; // not a git repo: nothing to guard
    }
  } else {
    if (!positional.length) fail("usage: meetroom guard check <files...> | --staged | --hook-stdin");
    files = positional.map((f) => resolve(f));
  }
  if (!files.length) return;

  // 2. Is meetroom in play here? (fail-open on every "no")
  const lock = readLock();
  if (!lock) return;
  const agentId = softResolveAgentId(parsed);
  if (!agentId) return; // human or ambiguous: not enforced

  let session: Session;
  try {
    const res = await fetch(`${baseUrl(lock)}/api/sessions/${lock.sessionId}/state`, {
      headers: lock.token ? { "x-meetroom-token": lock.token } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    session = ((await res.json()) as { session: Session }).session;
  } catch {
    return; // daemon down: don't block git
  }
  if (session.status === "ended") return;

  // 3. Enforce.
  const rel = files.map((f) => (isAbsolute(f) && f.startsWith(session.cwd + "/") ? f.slice(session.cwd.length + 1) : f));
  const violations = evaluateGuard(session, agentId, rel);
  if (!violations.length) return;
  for (const v of violations) console.error(`meetroom guard: ${v.file}: ${v.reason}`);
  // Claude Code treats exit 2 as "block and show stderr to the model".
  process.exit(hookMode ? 2 : 1);
}
