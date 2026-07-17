import { api, csv, fail, saveAgentContext, writeLock, type Parsed, DEFAULT_PORT, readLock } from "../client.js";

export async function cmdJoin(parsed: Parsed): Promise<void> {
  const { flags, positional } = parsed;
  // `meetroom join --sxl <id>` (spec form) or `--session <id>`; falls back to
  // the .meetroom/lock in cwd so a bare `meetroom join --name X --role Y` works.
  const typeFlagId = typeof flags.sxl === "string" ? flags.sxl : undefined;
  const sessionId = typeFlagId ?? (flags.session as string) ?? positional[0] ?? readLock()?.sessionId;
  if (!sessionId) fail("session id required: meetroom join --sxl <id> --name \"...\" --role \"...\"");

  const name = flags.name as string;
  const role = (flags.role as string) ?? "Implementer";
  if (!name) fail("--name required");

  const host = (flags.host as string) ?? readLock()?.host ?? "127.0.0.1";
  const port = flags.port ? Number(flags.port) : readLock()?.port ?? Number(process.env.MEETROOM_PORT ?? DEFAULT_PORT);
  const token = (flags.token as string) ?? readLock()?.token;
  const scheme = flags.https || process.env.MEETROOM_SCHEME === "https" ? ("https" as const) : readLock()?.scheme;

  const data = await api({ host, port, token, scheme }, "POST", `/api/sessions/${sessionId}/join`, {
    name,
    role,
    identity: flags.identity,
    costTier: flags["cost-tier"],
    strengths: csv(flags.strengths),
  });

  // Persist context so later commands need no flags.
  writeLock({ sessionId, host, port, token, scheme });
  saveAgentContext(name, data.agent.id);

  console.log(`joined session ${sessionId} as ${name} (${role}) — agent id ${data.agent.id}`);
  console.log(`act as this agent with: export MEETROOM_AGENT=${JSON.stringify(name)}  (or pass --as ${JSON.stringify(name)})`);
  console.log("");
  console.log(data.brief); // auto-brief for late joiners (V2 #5)
}
