import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { api, fail, requireContext, type Parsed, DEFAULT_PORT } from "../client.js";
import { loadSecrets, saveSecrets } from "../../daemon/trust.js";

// V6 CLI — operators, secrets, audit, org report, purge.

function daemonCtx(parsed: Parsed) {
  return {
    host: (parsed.flags.host as string) ?? "127.0.0.1",
    port: parsed.flags.port ? Number(parsed.flags.port) : Number(process.env.MEETROOM_PORT ?? DEFAULT_PORT),
  };
}

function credentialsPath(): string {
  return join(process.env.MEETROOM_HOME ?? join(homedir(), ".meetroom"), "credentials.json");
}

export async function cmdOperator(parsed: Parsed): Promise<void> {
  const [sub, name] = parsed.positional;
  const ctx = daemonCtx(parsed);

  if (sub === "invite") {
    const role = (parsed.flags.role as string) ?? "reviewer";
    if (!name) fail("usage: meetroom operator invite <name> --role owner|maintainer|reviewer|observer");
    const data = await api(ctx, "POST", "/api/operators", { name, role });
    console.log(`operator "${name}" (${role}) invited.`);
    console.log(`their key (shown ONCE — send it to them securely): ${data.key}`);
    console.log(`they activate it with: meetroom login --key ${data.key}`);
    return;
  }
  if (sub === "list" || sub === undefined) {
    const data = await api(ctx, "GET", "/api/operators");
    if (!data.operators.length) return console.log("no operators configured (solo mode: everything is allowed)");
    for (const o of data.operators) console.log(`${o.name} — ${o.role} (since ${o.createdAt.slice(0, 10)})`);
    return;
  }
  if (sub === "revoke") {
    if (!name) fail("usage: meetroom operator revoke <name>");
    await api(ctx, "DELETE", `/api/operators/${encodeURIComponent(name)}`);
    console.log(`operator "${name}" revoked — their key stops working immediately`);
    return;
  }
  fail(`unknown operator subcommand "${sub}" (invite | list | revoke)`);
}

export async function cmdLogin(parsed: Parsed): Promise<void> {
  const key = parsed.flags.key as string;
  if (!key) fail("usage: meetroom login --key <operator-key>");
  mkdirSync(join(credentialsPath(), ".."), { recursive: true });
  writeFileSync(credentialsPath(), JSON.stringify({ key }, null, 2), { mode: 0o600 });
  console.log("operator key stored (~/.meetroom/credentials.json) — CLI calls now act as you");
}

export async function cmdSecret(parsed: Parsed): Promise<void> {
  const [sub, name] = parsed.positional;

  if (sub === "set") {
    if (!name) fail("usage: meetroom secret set <NAME>   (value is prompted, never passed as an argument)");
    let value = process.env.MEETROOM_SECRET_VALUE; // non-interactive escape hatch
    if (!value) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      value = await rl.question(`value for ${name}: `);
      rl.close();
    }
    if (!value) fail("empty value");
    const secrets = loadSecrets();
    secrets[name!] = value;
    saveSecrets(secrets);
    console.log(`secret ${name} stored (encrypted at rest; reference it as {secret:${name}} in plugin/PR commands)`);
    return;
  }
  if (sub === "list" || sub === undefined) {
    const names = Object.keys(loadSecrets());
    if (!names.length) return console.log("no secrets stored");
    for (const n of names) console.log(n); // names only, never values
    return;
  }
  if (sub === "rm") {
    if (!name) fail("usage: meetroom secret rm <NAME>");
    const secrets = loadSecrets();
    if (!(name in secrets)) fail(`no secret "${name}"`);
    delete secrets[name!];
    saveSecrets(secrets);
    console.log(`secret ${name} removed`);
    return;
  }
  fail(`unknown secret subcommand "${sub}" (set | list | rm)`);
}

export async function cmdAudit(parsed: Parsed): Promise<void> {
  const [sub] = parsed.positional;
  if (sub !== "verify") fail("usage: meetroom audit verify [--session <id>]");
  const ctx = requireContext(parsed.flags);
  const data = await api(ctx, "GET", `/api/sessions/${ctx.sessionId}/audit`);
  if (data.intact) {
    console.log(`audit chain intact — ${data.events} events verified for ${ctx.sessionId}`);
  } else {
    console.error(`TAMPERING DETECTED: event #${data.brokenIndex} breaks the hash chain in ${ctx.sessionId}`);
    process.exit(1);
  }
}

export async function cmdOrg(parsed: Parsed): Promise<void> {
  const [sub] = parsed.positional;
  if (sub !== "report") fail("usage: meetroom org report");
  const ctx = daemonCtx(parsed);
  const data = await api(ctx, "GET", "/api/org/report");
  if (!data.projects.length) return console.log("no sessions recorded yet");
  console.log("| project | sessions | tasks done | escalations | tokens | est. cost |");
  console.log("|---|---|---|---|---|---|");
  for (const p of data.projects) {
    console.log(`| ${p.cwd} | ${p.sessions} | ${p.tasksDone} | ${p.escalations} | ${p.tokens} | $${p.costUsd.toFixed(2)} |`);
  }
}

export async function cmdPurge(parsed: Parsed): Promise<void> {
  const sessionId = parsed.positional[0];
  const flags = sessionId ? { ...parsed.flags, session: sessionId } : parsed.flags;
  const ctx = requireContext(flags);
  if (!parsed.flags.yes) {
    fail(`this permanently strips chat, review diffs, and artifact contents from ${ctx.sessionId} (the exported report and timeline are kept). Re-run with --yes to confirm.`);
  }
  const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/purge`);
  console.log(`purged ${ctx.sessionId} — report preserved at ${data.reportPath}`);
}
