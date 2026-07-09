import { api, csv, fail, requireContext, resolveAgentId, type Parsed } from "../client.js";

// V2 #1 — task board CLI: create / claim / move (board lives in status.ts).

export async function cmdTask(parsed: Parsed): Promise<void> {
  const [sub, ...rest] = parsed.positional;
  const ctx = requireContext(parsed.flags);

  if (sub === "create") {
    const title = rest.join(" ");
    if (!title) fail('usage: meetroom task create "<title>" [--files a.ts,b.ts] [--depends-on <id>,<id>] [--requires-ci] [--requires-tests] [--description "..."]');
    const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/tasks`, {
      title,
      description: parsed.flags.description,
      files: csv(parsed.flags.files) ?? [],
      dependsOn: csv(parsed.flags["depends-on"]),
      requiresCI: !!parsed.flags["requires-ci"],
      requiresTests: !!parsed.flags["requires-tests"],
      // V8 #7 — the acceptance test, declared before implementation starts.
      verify: parsed.flags.verify ? { command: parsed.flags.verify as string } : undefined,
      epicId: parsed.flags.epic, // V8 #8
    });
    const t = data.task;
    console.log(`task ${t.id} created (${t.estimatedComplexity})${t.suggestedAgentId ? ` — routing suggests agent ${t.suggestedAgentId}` : ""}`);
    for (const w of t.conflictWarnings ?? []) console.log(`  warning: ${w}`);
    return;
  }

  if (sub === "claim") {
    const taskId = rest[0];
    if (!taskId) fail("usage: meetroom task claim <task-id>");
    const agentId = resolveAgentId(parsed.flags);
    const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/tasks/${taskId}/claim`, { agentId });
    console.log(`task ${taskId} claimed — its files were auto-claimed for you`);
    if (data.queuedFiles) console.log(`  queued (held by someone else, you're on the waitlist): ${data.queuedFiles.join(", ")}`);
    return;
  }

  if (sub === "move") {
    const [taskId, status] = rest;
    if (!taskId || !status) fail("usage: meetroom task move <task-id> <todo|in-progress|review|done|blocked>");
    const agentId = resolveAgentId(parsed.flags);
    const data = await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/tasks/${taskId}/move`, { agentId, status });
    console.log(`task ${taskId} is now: ${data.status}`);
    return;
  }

  fail(`unknown task subcommand "${sub}" (create | claim | move)`);
}

/** V3 #7 — QA gate: attach a test result to a task. */
export async function cmdTest(parsed: Parsed): Promise<void> {
  const [sub, taskId, result] = parsed.positional;
  if (sub !== "report" || !taskId || !["passed", "failed"].includes(result)) {
    fail("usage: meetroom test report <task-id> passed|failed");
  }
  const ctx = requireContext(parsed.flags);
  const agentId = resolveAgentId(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/tasks/${taskId}/tests`, { agentId, result });
  console.log(`test result "${result}" recorded for ${taskId}`);
}

/** V3 #3 — CI status (manual report; CI systems can POST the same endpoint). */
export async function cmdCI(parsed: Parsed): Promise<void> {
  const [sub, taskId, status] = parsed.positional;
  if (sub === "webhook-url") {
    const ctx = requireContext(parsed.flags);
    console.log(`POST http://<daemon-host>:${ctx.port}/api/sessions/${ctx.sessionId}/tasks/<task-id>/ci`);
    console.log(`body: {"status": "passed|failed|pending", "provider": "github-actions|gitlab-ci|generic-webhook", "url": "<run url>"}`);
    if (ctx.token) console.log(`header: x-meetroom-token: ${ctx.token}`);
    return;
  }
  if (sub !== "report" || !taskId || !["passed", "failed", "pending"].includes(status)) {
    fail("usage: meetroom ci report <task-id> passed|failed|pending [--url <run-url>] [--provider <name>]  |  meetroom ci webhook-url");
  }
  const ctx = requireContext(parsed.flags);
  await api(ctx, "POST", `/api/sessions/${ctx.sessionId}/tasks/${taskId}/ci`, {
    status,
    provider: parsed.flags.provider ?? "generic-webhook",
    url: parsed.flags.url,
  });
  console.log(`CI status "${status}" recorded for ${taskId}`);
}
