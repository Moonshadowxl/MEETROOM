import { parseArgs } from "./client.js";
import { cmdStart } from "./commands/start.js";
import { cmdJoin } from "./commands/join.js";
import { cmdSay, cmdPrompt, cmdPromptAll } from "./commands/say.js";
import { cmdClaim, cmdTouch } from "./commands/claim.js";
import { cmdRelease } from "./commands/release.js";
import { cmdStatus, cmdBoard, cmdBrief, cmdSessions, cmdInbox } from "./commands/status.js";
import { cmdPropose, cmdObject, cmdResolve, cmdVote } from "./commands/propose.js";
import { cmdTask, cmdTest, cmdCI } from "./commands/task.js";
import { cmdReview } from "./commands/review.js";
import {
  cmdPause,
  cmdResume,
  cmdEnd,
  cmdExport,
  cmdFork,
  cmdCompare,
  cmdRollback,
  cmdListen,
  cmdPair,
  cmdSandbox,
} from "./commands/sessionCtl.js";
import {
  cmdUsage,
  cmdPlugin,
  cmdNotify,
  cmdPlan,
  cmdRoles,
  cmdMemory,
  cmdReputation,
  cmdLeave,
} from "./commands/misc.js";
import { cmdGuild } from "./commands/guild.js";
import { readLock, DEFAULT_PORT } from "./client.js";

const LOGO = String.raw`
  __  __ ___ ___ _____ ___  ___   ___  __  __
 |  \/  | __| __|_   _| _ \/ _ \ / _ \|  \/  |
 | |\/| | _|| _|  | |  |   / (_) | (_) | |\/| |
 |_|  |_|___|___| |_|  |_|_\\___/ \___/|_|  |_|
        multi-agent coordination · v3
`;

const HELP = `
usage: meetroom <command> [args] [--flags]

room
  start [--sxl|--sxx|--mmm] [--remote] [--guild <name>] [--agents N]
        [--claim-timeout M] [--objection-timeout M] [--port P]
  join --<type> <id> --name "..." --role "..." [--token T] [--host H] [--port P]
       [--age --personality --vibe --cost-tier low|medium|high --strengths a,b]
  leave · sessions · status · brief · listen · inbox [--since <ts>]
  pause · resume · end · fork · compare <a> <b> · rollback [--yes]
  export [session-id] --format md|json

chat
  say "<msg>" [--as <agent>]
  prompt-all "<msg>"            broadcast to every agent (human)
  prompt @<agent> "<msg>"       private nudge to one agent (human)
  pair <agent>                  live 1:1 lane with one agent

files & tasks
  claim <file> [--wait] · release <file> · touch <file>
  task create "<title>" [--files a,b] [--depends-on id,id] [--requires-ci] [--requires-tests]
  task claim <id> · task move <id> <status> · board

decisions
  propose "<plan>" · object <id> "<reason>" · resolve <id> ["response"] · vote <id> yes|no

review gate
  review submit <task-id> [--confidence low|medium|high] [--pr]
  review approve <id> ["comment"] · review request-changes <id> "<comment>"
  review comment <id> "<text>" [--line N] · review show <id> · review pr-sync <id> <state>
  test report <task-id> passed|failed
  ci report <task-id> passed|failed|pending [--url U] · ci webhook-url

extend & observe
  plugin install <name> --command "<cmd>" [--project] · plugin list · plugin run <name> [args]
  notify configure --webhook|--slack-webhook|--discord-webhook <url> [--events a,b]
  plan "<feature>" · plan approve|discard <id>
  guild create "<name>" --members "ident:role[:tier],..." · guild list
  usage report --in N --out N --cost X · usage show
  sandbox <task-id> · memory · reputation · roles

Most commands read .meetroom/lock in the cwd, so no --session flag is needed
after start/join. Act as a specific agent with --as <name> or MEETROOM_AGENT.
`;

async function home(): Promise<void> {
  console.log(LOGO);
  const lock = readLock();
  if (lock) {
    console.log(`active session here: ${lock.sessionId} (daemon: ${lock.host}:${lock.port})`);
  }
  try {
    const port = lock?.port ?? Number(process.env.MEETROOM_PORT ?? DEFAULT_PORT);
    const host = lock?.host ?? "127.0.0.1";
    const res = await fetch(`http://${host}:${port}/api/sessions`, { signal: AbortSignal.timeout(1000) });
    const data = (await res.json()) as { sessions: Array<{ id: string; status: string; cwd: string; agents: number }> };
    if (data.sessions?.length) {
      console.log("\nlocal sessions:");
      for (const s of data.sessions) console.log(`  ${s.id} [${s.status}] ${s.cwd} (${s.agents} agents)`);
    }
  } catch {
    console.log("daemon not running — `meetroom start` will launch it");
  }
  console.log(HELP);
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  const parsed = parseArgs(argv);

  switch (command) {
    case undefined:
    case "home":
      return home();
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    case "start":
      return cmdStart(parsed);
    case "join":
      return cmdJoin(parsed);
    case "leave":
      return cmdLeave(parsed);
    case "say":
      return cmdSay(parsed);
    case "prompt-all":
      return cmdPromptAll(parsed);
    case "prompt":
      return cmdPrompt(parsed);
    case "pair":
      return cmdPair(parsed);
    case "claim":
      return cmdClaim(parsed);
    case "release":
      return cmdRelease(parsed);
    case "touch":
      return cmdTouch(parsed);
    case "status":
      return cmdStatus(parsed);
    case "board":
      return cmdBoard(parsed);
    case "brief":
      return cmdBrief(parsed);
    case "sessions":
      return cmdSessions(parsed);
    case "inbox":
      return cmdInbox(parsed);
    case "listen":
      return cmdListen(parsed);
    case "propose":
      return cmdPropose(parsed);
    case "object":
      return cmdObject(parsed);
    case "resolve":
      return cmdResolve(parsed);
    case "vote":
      return cmdVote(parsed);
    case "task":
      return cmdTask(parsed);
    case "test":
      return cmdTest(parsed);
    case "ci":
      return cmdCI(parsed);
    case "review":
      return cmdReview(parsed);
    case "pause":
      return cmdPause(parsed);
    case "resume":
      return cmdResume(parsed);
    case "end":
      return cmdEnd(parsed);
    case "export":
      return cmdExport(parsed);
    case "fork":
      return cmdFork(parsed);
    case "compare":
      return cmdCompare(parsed);
    case "rollback":
      return cmdRollback(parsed);
    case "sandbox":
      return cmdSandbox(parsed);
    case "usage":
      return cmdUsage(parsed);
    case "plugin":
      return cmdPlugin(parsed);
    case "notify":
      return cmdNotify(parsed);
    case "plan":
      return cmdPlan(parsed);
    case "guild":
      return cmdGuild(parsed);
    case "memory":
      return cmdMemory(parsed);
    case "reputation":
      return cmdReputation(parsed);
    case "roles":
      return cmdRoles();
    default:
      console.error(`meetroom: unknown command "${command}" — run \`meetroom help\``);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`meetroom: ${err.message ?? err}`);
  process.exit(1);
});
