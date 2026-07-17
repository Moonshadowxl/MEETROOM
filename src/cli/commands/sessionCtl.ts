import { execFileSync } from "node:child_process";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../../shared/types.js";
import { api, baseUrl, DEFAULT_PORT, fail, readLock, requireContext, resolveAgentId, type Parsed } from "../client.js";

// Session lifecycle + observability commands: pause/resume/end (V2 #7),
// export (V2 #10), fork/compare (V3 #8), rollback (V3 #9), listen (SSE),
// pair (V3 #12), sandbox (V3 #14).

export async function cmdPause(parsed: Parsed): Promise<void> {
  const ctx = requireContext(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/pause`);
  console.log("room paused — resume with `meetroom resume`");
}

export async function cmdResume(parsed: Parsed): Promise<void> {
  const ctx = requireContext(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/resume`);
  console.log("room resumed");
}

export async function cmdEnd(parsed: Parsed): Promise<void> {
  const ctx = requireContext(parsed.flags);
  const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/end`);
  console.log(`session ${ctx.sessionId} ended`);
  console.log(`project memory now holds ${data.memory.nodes.length} nodes (.meetroom/memory.json)`);
}

/** Gracefully shut the daemon down (stops runners, persists, exits). */
export async function cmdStop(parsed: Parsed): Promise<void> {
  const lock = readLock();
  const host = (parsed.flags.host as string) ?? lock?.host ?? "127.0.0.1";
  const port = parsed.flags.port ? Number(parsed.flags.port) : lock?.port ?? Number(process.env.MEETROOM_PORT ?? DEFAULT_PORT);
  const scheme = parsed.flags.https || process.env.MEETROOM_SCHEME === "https" ? ("https" as const) : lock?.scheme;
  try {
    const res = await fetch(`${baseUrl({ host, port, scheme })}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error();
  } catch {
    console.log(`no meetroom daemon running on ${host}:${port}`);
    return;
  }
  const data = await api({ host, port, scheme }, "POST", "/api/shutdown");
  console.log(`daemon (pid ${data.pid}) is shutting down — runners stopped, sessions persisted`);
}

export async function cmdExport(parsed: Parsed): Promise<void> {
  const sessionId = parsed.positional[0];
  const flags = sessionId ? { ...parsed.flags, session: sessionId } : parsed.flags;
  const ctx = requireContext(flags);
  const format = parsed.flags.format === "json" ? "json" : "md";
  const url = `${baseUrl(ctx)}/api/sessions/${ctx.sessionId}/export?format=${format}`;
  const res = await fetch(url, { headers: ctx.token ? { "x-meetroom-token": ctx.token } : {} });
  if (!res.ok) fail(`export failed: HTTP ${res.status}`);
  console.log(await res.text());
}

export async function cmdFork(parsed: Parsed): Promise<void> {
  const ctx = requireContext(parsed.flags);
  const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/fork`);
  console.log(`forked → session ${data.fork.id}`);
  if (data.fork.token) console.log(`fork token: ${data.fork.token}`);
  console.log("run the fork's agents on their own git branch, then: meetroom compare " + `${ctx.sessionId} ${data.fork.id}`);
}

/** Side-by-side outcome summary of two (usually forked) sessions. */
export async function cmdCompare(parsed: Parsed): Promise<void> {
  const [idA, idB] = parsed.positional;
  if (!idA || !idB) fail("usage: meetroom compare <session-a> <session-b>");
  const ctx = requireContext({ ...parsed.flags, session: idA });
  for (const id of [idA, idB]) {
    const data = await api(ctx, "GET", `/api/sessions/${id}/state`);
    const s = data.session as Session;
    const done = s.tasks.filter((t) => t.status === "done").length;
    const approved = s.reviews.filter((r) => r.status === "approved").length;
    const decisions = s.proposals.filter((p) => p.status === "resolved").length;
    console.log(`\n=== ${s.id}${s.forkedFrom ? ` (fork of ${s.forkedFrom})` : ""} [${s.status}] ===`);
    console.log(`tasks done: ${done}/${s.tasks.length} · reviews approved: ${approved} · decisions: ${decisions}`);
    for (const t of s.tasks) console.log(`  [${t.status}] ${t.title}`);
  }
  console.log("\npick a winner, then `meetroom end <loser-id>` — ended forks stay archived for the record");
}

/** V3 #9 — reset the project to the commit recorded at session start. */
export async function cmdRollback(parsed: Parsed): Promise<void> {
  const sessionId = parsed.positional[0];
  const flags = sessionId ? { ...parsed.flags, session: sessionId } : parsed.flags;
  const ctx = requireContext(flags);
  const data = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
  const session = data.session as Session;
  if (!session.baseCommit) fail("this session recorded no base commit (project wasn't a git repo at start) — nothing to roll back to");
  if (!parsed.flags.yes) {
    fail(
      `this will hard-reset ${session.cwd} to ${session.baseCommit!.slice(0, 12)} (state before the session). ` +
        "Session chat/tasks are preserved. Re-run with --yes to confirm."
    );
  }
  execFileSync("git", ["reset", "--hard", session.baseCommit!], { cwd: session.cwd, stdio: "inherit" });
  console.log(`rolled back ${session.cwd} to ${session.baseCommit!.slice(0, 12)} — session record kept (the "why" survives the "what")`);
}

/** Live tail of room chat + events over SSE. */
export async function cmdListen(parsed: Parsed): Promise<void> {
  const ctx = requireContext(parsed.flags);
  let agentId: string | undefined;
  try {
    agentId = resolveAgentId(parsed.flags);
  } catch {
    agentId = undefined; // listen as the human/viewer: sees everything
  }
  const path = `/api/sessions/${ctx.sessionId}/events${agentId && agentId !== "human" ? `?agentId=${encodeURIComponent(agentId)}` : ""}`;
  console.log(`listening to ${ctx.sessionId} (ctrl-c to stop)...`);
  const get = ctx.scheme === "https" ? httpsGet : httpGet;
  const req = get(
    { host: ctx.host, port: ctx.port, path, headers: ctx.token ? { "x-meetroom-token": ctx.token } : {} },
    (res) => {
      if (res.statusCode !== 200) fail(`listen failed: HTTP ${res.statusCode}`);
      let buffer = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          printFrame(frame);
        }
      });
      res.on("end", () => fail("stream closed by daemon"));
    }
  );
  req.on("error", (err) => fail(`listen failed: ${err.message}`));
}

function printFrame(frame: string): void {
  const lines = frame.split("\n");
  const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
  const dataLine = lines.find((l) => l.startsWith("data: "))?.slice(6);
  if (!event || !dataLine) return;
  try {
    const data = JSON.parse(dataLine);
    if (event === "chat") {
      console.log(`[chat] ${data.agentId}${data.to ? ` → (private)` : ""}: ${data.message}`);
    } else {
      console.log(`[${data.type}] ${JSON.stringify(data.data ?? {})}`);
    }
  } catch {
    // skip malformed frame
  }
}

/**
 * V3 #12 — pair mode: a live 1:1 lane with one agent. Your lines go to them
 * as private messages; their private replies (and mentions) print here.
 * Other agents keep working in the background.
 */
export async function cmdPair(parsed: Parsed): Promise<void> {
  const target = parsed.positional[0]?.replace(/^@/, "");
  if (!target) fail("usage: meetroom pair <agent-name>");
  const ctx = requireContext(parsed.flags);
  const state = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/state`);
  const session = state.session as Session;
  const agent = session.agents.find((a) => a.name === target || a.id === target);
  if (!agent) fail(`no agent "${target}" in the room`);

  const held = session.claims.filter((c) => c.agentId === agent!.id).map((c) => c.filepath);
  console.log(`paired with ${agent!.name} (${agent!.role})${held.length ? ` — currently holds: ${held.join(", ")}` : ""}`);
  console.log("type to send; ctrl-c to leave pair mode\n");

  let lastTs = new Date().toISOString();
  const poll = setInterval(async () => {
    try {
      const data = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/messages?agentId=human&since=${encodeURIComponent(lastTs)}`);
      for (const m of data.messages) {
        lastTs = m.ts > lastTs ? m.ts : lastTs;
        if (m.agentId === agent!.id) console.log(`${agent!.name}: ${m.message}`);
      }
    } catch {
      // transient poll failure — keep pairing
    }
  }, 1500);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/say`, { agentId: "human", message: line, to: agent!.name });
  });
  rl.on("close", () => {
    clearInterval(poll);
    console.log("\nleft pair mode");
    process.exit(0);
  });
}

/**
 * V3 #14 — sandboxed execution: give a task an isolated git worktree on its
 * own branch so an agent's commands can't stomp the main checkout.
 */
export async function cmdSandbox(parsed: Parsed): Promise<void> {
  const taskId = parsed.positional[0];
  if (!taskId) fail("usage: meetroom sandbox <task-id>");
  const ctx = requireContext(parsed.flags);
  const cwd = process.cwd();
  const branch = `meetroom/${ctx.sessionId}/${taskId}`;
  const dir = join(cwd, ".meetroom", "worktrees", taskId);
  mkdirSync(join(cwd, ".meetroom", "worktrees"), { recursive: true });
  try {
    execFileSync("git", ["worktree", "add", "-B", branch, dir], { cwd, stdio: "inherit" });
  } catch (err) {
    fail(`could not create worktree: ${(err as Error).message}`);
  }
  console.log(`sandbox ready: ${dir} (branch ${branch})`);
  console.log("run the agent for this task inside that directory; its edits stay isolated until reviewed/merged");
}
