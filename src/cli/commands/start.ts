import { spawn, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import type { Parsed } from "../client.js";
import { api, DEFAULT_PORT, writeLock } from "../client.js";
import { loadGuilds } from "./guild.js";

const DAEMON_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "daemon", "server.js");

async function daemonHealthy(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureDaemon(port: number, remote = false): Promise<void> {
  if (await daemonHealthy("127.0.0.1", port)) return;
  const args = [DAEMON_ENTRY, "--port", String(port), "--bind", remote ? "0.0.0.0" : "127.0.0.1"];
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await daemonHealthy("127.0.0.1", port)) return;
  }
  throw new Error(`daemon failed to start on port ${port}`);
}

function gitHead(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

export async function cmdStart(parsed: Parsed): Promise<void> {
  const { flags } = parsed;
  const type = flags.mmm ? "mmm" : flags.sxx ? "sxx" : "sxl"; // default sxl
  const remote = !!flags.remote;
  const port = flags.port ? Number(flags.port) : Number(process.env.MEETROOM_PORT ?? DEFAULT_PORT);
  const cwd = process.cwd();

  await ensureDaemon(port, remote);

  const config: Record<string, unknown> = {};
  if (flags["claim-timeout"]) config.claimTimeoutMinutes = Number(flags["claim-timeout"]);
  if (flags["objection-timeout"]) config.objectionTimeoutMinutes = Number(flags["objection-timeout"]);
  if (flags["require-pr-merge"]) config.requirePrMergeForDone = true;

  let roster: unknown;
  const guildName = flags.guild as string | undefined;
  if (guildName) {
    const guild = loadGuilds().find((g) => g.name === guildName);
    if (!guild) throw new Error(`no guild named "${guildName}" — create one with \`meetroom guild create\``);
    roster = guild.members.map((m) => ({
      name: m.agentIdentity,
      role: m.defaultRole,
      identity: m.agentIdentity,
      costTier: m.costTier,
      strengths: m.strengths,
    }));
  }

  const ctx = { host: "127.0.0.1", port, token: undefined as string | undefined };
  const data = await api(ctx, "POST", "/api/sessions", {
    type,
    cwd,
    remote,
    config,
    guild: guildName,
    baseCommit: gitHead(cwd),
    roster,
  });

  const sessionId: string = data.session.id;
  const token: string | undefined = data.session.token;
  writeLock({ sessionId, host: "127.0.0.1", port, token }, cwd);

  console.log(`session started: ${sessionId}`);
  console.log(`project: ${cwd}`);
  if (remote) {
    console.log(`remote mode: daemon bound to 0.0.0.0:${port}`);
    console.log(`session token (required for non-localhost joins): ${token}`);
  }
  console.log(`web viewer: http://127.0.0.1:${port}/?session=${sessionId}`);

  let agentCount = flags.agents ? Number(flags.agents) : undefined;
  if (agentCount === undefined && process.stdin.isTTY && process.stdout.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("how many agents will join? [2] ");
    rl.close();
    agentCount = Number(answer) || 2;
  }
  console.log("");
  console.log("agents join with:");
  const tokenFlag = remote ? ` --token ${token}` : "";
  for (let i = 1; i <= (agentCount ?? 2); i++) {
    console.log(`  meetroom join --${type} ${sessionId} --name "Agent-${i}" --role Implementer${tokenFlag}`);
  }
}
