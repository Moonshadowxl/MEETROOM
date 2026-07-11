import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../../shared/types.js";
import { baseUrl, DEFAULT_PORT, lockPath, meetroomDir, readLock, type Parsed } from "../client.js";

// `meetroom doctor` — one command that answers "why is this room misbehaving?":
// daemon reachability, lock/session consistency, stale agent contexts,
// orphaned sandbox worktrees, and parseability of every .meetroom JSON file.

export async function cmdDoctor(parsed: Parsed): Promise<void> {
  const cwd = process.cwd();
  const lock = readLock(cwd);
  const host = (parsed.flags.host as string) ?? lock?.host ?? "127.0.0.1";
  const port = parsed.flags.port ? Number(parsed.flags.port) : lock?.port ?? Number(process.env.MEETROOM_PORT ?? DEFAULT_PORT);
  const scheme = parsed.flags.https || process.env.MEETROOM_SCHEME === "https" ? ("https" as const) : lock?.scheme;
  const base = baseUrl({ host, port, scheme });

  let failures = 0;
  const ok = (msg: string) => console.log(`  ok    ${msg}`);
  const warn = (msg: string) => console.log(`  warn  ${msg}`);
  const fail = (msg: string) => {
    failures++;
    console.log(`  FAIL  ${msg}`);
  };

  console.log(`meetroom doctor — ${cwd}\n`);

  // 1. Daemon reachability.
  console.log(`daemon (${base}):`);
  let daemonUp = false;
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
    const data = (await res.json()) as { pid?: number };
    if (!res.ok) throw new Error();
    daemonUp = true;
    ok(`reachable (pid ${data.pid})`);
  } catch {
    if (lock) fail("unreachable, but .meetroom/lock points here — `meetroom start` relaunches it (or delete the stale lock)");
    else warn("not running — fine if no session is active (`meetroom start` launches it)");
  }

  // 2. Lock ↔ session consistency.
  console.log("\nsession lock:");
  let session: Session | undefined;
  if (!existsSync(lockPath(cwd))) {
    warn("no .meetroom/lock in this directory (commands here need --session/--host/--port)");
  } else if (!lock) {
    fail(".meetroom/lock exists but is not valid JSON — delete it and re-run `meetroom start` or `meetroom join`");
  } else {
    ok(`lock → session ${lock.sessionId} @ ${lock.host}:${lock.port}${lock.scheme === "https" ? " (https)" : ""}`);
    if (daemonUp) {
      try {
        const res = await fetch(`${base}/api/sessions/${lock.sessionId}/state`, {
          headers: lock.token ? { "x-meetroom-token": lock.token } : {},
          signal: AbortSignal.timeout(3000),
        });
        const data = (await res.json()) as any;
        if (res.status === 404) fail(`daemon doesn't know session ${lock.sessionId} — stale lock (delete .meetroom/lock)`);
        else if (res.status === 401) fail("session token in the lock is rejected by the daemon");
        else if (data.session) {
          session = data.session as Session;
          const line = `session is ${session.status} · ${session.agents.length} agents · ${session.tasks.length} tasks`;
          if (session.status === "ended") warn(`${line} — start a new session for new work`);
          else ok(line);
        }
      } catch {
        fail("could not fetch session state from the daemon");
      }
    }
  }

  // 3. Agent context files.
  console.log("\nagent contexts (.meetroom/agents/):");
  const agentsDir = join(meetroomDir(cwd), "agents");
  const contextFiles = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith(".json")) : [];
  if (!contextFiles.length) {
    warn("none — commands here act as \"human\" until an agent joins");
  }
  for (const f of contextFiles) {
    try {
      const { name, agentId } = JSON.parse(readFileSync(join(agentsDir, f), "utf8")) as { name: string; agentId: string };
      if (!session) {
        ok(`${name} (${agentId}) — unverified (no session state)`);
      } else {
        const agent = session.agents.find((a) => a.id === agentId);
        if (!agent) fail(`${name}: agent ${agentId} is not in session ${session.id} — stale context, delete ${join("agents", f)} or re-join`);
        else if (agent.status === "disconnected") warn(`${name}: marked disconnected — re-join or run any command as them to revive`);
        else ok(`${name} [${agent.status}]`);
      }
    } catch {
      fail(`${f} is not valid JSON`);
    }
  }

  // 4. Sandbox worktrees.
  const worktreesDir = join(meetroomDir(cwd), "worktrees");
  if (existsSync(worktreesDir)) {
    console.log("\nsandbox worktrees (.meetroom/worktrees/):");
    for (const taskId of readdirSync(worktreesDir)) {
      const task = session?.tasks.find((t) => t.id === taskId);
      if (!task) warn(`${taskId}: no matching task in the current session — remove with \`git worktree remove .meetroom/worktrees/${taskId}\``);
      else if (task.status === "done" || task.status === "cancelled") warn(`${taskId}: task is ${task.status} — worktree can be removed`);
      else ok(`${taskId} [task ${task.status}]`);
    }
  }

  // 5. Project JSON files.
  console.log("\nproject files (.meetroom/):");
  for (const name of ["memory.json", "policy.json", "plugins.json", "reputation.json", "epics.json"]) {
    const p = join(meetroomDir(cwd), name);
    if (!existsSync(p)) continue;
    try {
      JSON.parse(readFileSync(p, "utf8"));
      ok(`${name} parses`);
    } catch {
      fail(`${name} is not valid JSON — meetroom silently ignores it until fixed`);
    }
  }

  console.log(failures ? `\n${failures} problem(s) found` : "\nno problems found");
  if (failures) process.exit(1);
}
