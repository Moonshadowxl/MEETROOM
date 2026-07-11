import { parseArgs } from "./client.js";
import { cmdStart } from "./commands/start.js";
import { cmdJoin } from "./commands/join.js";
import { cmdSay, cmdPrompt, cmdPromptAll } from "./commands/say.js";
import { cmdClaim, cmdTouch } from "./commands/claim.js";
import { cmdRelease } from "./commands/release.js";
import { cmdStatus, cmdBoard, cmdBrief, cmdSessions, cmdInbox } from "./commands/status.js";
import { cmdPropose, cmdObject, cmdReject, cmdResolve, cmdVote } from "./commands/propose.js";
import { cmdDoctor } from "./commands/doctor.js";
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
  cmdStop,
} from "./commands/sessionCtl.js";
import {
  cmdUsage,
  cmdPlugin,
  cmdNotify,
  cmdPlan,
  cmdRoles,
  cmdMemory,
  cmdRecall,
  cmdReputation,
  cmdLeave,
} from "./commands/misc.js";
import { cmdGuild } from "./commands/guild.js";
import { cmdAgent, cmdArtifact, cmdAttention, cmdBudget, cmdRoutine, cmdTemplate } from "./commands/ops.js";
import { cmdAudit, cmdLogin, cmdOperator, cmdOrg, cmdPurge, cmdSecret } from "./commands/trust.js";
import {
  cmdAdapter,
  cmdAutonomy,
  cmdBundle,
  cmdEpic,
  cmdIntegration,
  cmdRetro,
  cmdSimulate,
  cmdSync,
  cmdVerify,
  cmdVeto,
} from "./commands/evolve.js";
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
  stop                          gracefully shut the daemon down
  doctor                        diagnose daemon/lock/agent/worktree problems

chat
  say "<msg>" [--as <agent>]
  prompt-all "<msg>"            broadcast to every agent (human)
  prompt @<agent> "<msg>"       private nudge to one agent (human)
  pair <agent>                  live 1:1 lane with one agent

files & tasks
  claim <file> [--wait] · release <file> · touch <file>
  task create "<title>" [--files a,b] [--depends-on id,id] [--requires-ci] [--requires-tests]
  task claim <id> · task move <id> <status> · board
  task show <id> · task assign <id> <agent> · task drop <id>
  task edit <id> [--title|--description|--files|--verify] · task cancel <id>

decisions
  propose "<plan>" · object <id> "<reason>" · resolve <id> ["response"] · vote <id> yes|no
  reject <id> ["reason"]        human veto, or author withdraw before voting

review gate
  review submit <task-id> [--confidence low|medium|high] [--pr]
  review approve <id> ["comment"] · review request-changes <id> "<comment>"
  review comment <id> "<text>" [--line N] · review show <id> · review pr-sync <id> <state>
  test report <task-id> passed|failed
  ci report <task-id> passed|failed|pending [--url U] · ci webhook-url

extend & observe
  plugin install <name> --command "<cmd>" [--project] [--permissions a,b] · plugin list/run
  notify configure --webhook|--slack-webhook|--discord-webhook <url> [--events a,b]
  plan "<feature>" · plan approve|discard <id> · simulate "<feature>"
  guild create "<name>" --members "ident:role[:tier],..." · guild list
  usage report --in N --out N --cost X · usage show
  sandbox <task-id> · memory [promote <node-id>] · recall "<query>" · reputation · roles

operations (V4)
  agent spawn <name> --cmd "..." [--restart on-crash] · agent stop/restart/logs/list
  budget set [--agent <name>] --max-cost USD|--max-tokens N [--on-breach ...] · budget show
  attention [ack|done|snooze <id>] · artifact write/read/list
  routine create "<name>" --cron "0 2 * * *" [--template t] · routine list/delete
  template save <name> [--user] · start --template <name>

teams & trust (V6)
  operator invite <name> --role r · operator list/revoke · login --key K
  secret set/list/rm <NAME> · audit verify · org report · purge [session-id] --yes

ecosystem & autonomy (V7/V8)
  adapter generate <claude|codex|generic> --name N [--role R]
  integration add <source> --secret S · sync github --repo owner/name
  bundle export|import <file.mrb> · epic create/list/status
  autonomy set <0-4> [--veto-window M] · veto <action-id>
  verify run <task-id> · retro [session-id] · brief --since <ts|last>

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
    case "reject":
      return cmdReject(parsed);
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
    case "stop":
      return cmdStop(parsed);
    case "doctor":
      return cmdDoctor(parsed);
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
    case "recall":
      return cmdRecall(parsed);
    case "reputation":
      return cmdReputation(parsed);
    case "roles":
      return cmdRoles();
    case "agent":
      return cmdAgent(parsed);
    case "budget":
      return cmdBudget(parsed);
    case "attention":
      return cmdAttention(parsed);
    case "artifact":
      return cmdArtifact(parsed);
    case "routine":
      return cmdRoutine(parsed);
    case "template":
      return cmdTemplate(parsed);
    case "operator":
      return cmdOperator(parsed);
    case "login":
      return cmdLogin(parsed);
    case "secret":
      return cmdSecret(parsed);
    case "audit":
      return cmdAudit(parsed);
    case "org":
      return cmdOrg(parsed);
    case "purge":
      return cmdPurge(parsed);
    case "adapter":
      return cmdAdapter(parsed);
    case "integration":
      return cmdIntegration(parsed);
    case "sync":
      return cmdSync(parsed);
    case "bundle":
      return cmdBundle(parsed);
    case "autonomy":
      return cmdAutonomy(parsed);
    case "veto":
      return cmdVeto(parsed);
    case "verify":
      return cmdVerify(parsed);
    case "retro":
      return cmdRetro(parsed);
    case "simulate":
      return cmdSimulate(parsed);
    case "epic":
      return cmdEpic(parsed);
    default:
      console.error(`meetroom: unknown command "${command}" — run \`meetroom help\``);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`meetroom: ${err.message ?? err}`);
  process.exit(1);
});
