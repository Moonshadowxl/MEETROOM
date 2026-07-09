# Meetroom — V4 Feature Spec: Operations & Autonomy

Builds on V1–V3 (core daemon/CLI/claims, task board + review gate, plugins/CI/routing/reputation — all shipped). V4's theme: **running rooms hands-off**. V1–V3 assume you're nearby; V4 makes a room something you can leave running overnight and trust.

---

## 1. Agent Runner / Supervisor

**Why:** Today you open N terminals and start N agents by hand. The daemon should be able to launch and babysit agent processes itself — the room becomes self-hosting.

**Data model addition:**
```ts
type AgentRunner = {
  agentName: string;
  command: string;            // e.g. `claude -p "$(meetroom brief)" --dangerously-skip-permissions`
  cwd: string;                // usually the project dir, or a sandbox worktree
  restartPolicy: "never" | "on-crash" | "always";
  maxRestarts: number;        // default 3 — no infinite crash loops
  pid?: number;
  state: "running" | "stopped" | "crashed" | "restarting";
  lastHeartbeatAt?: string;
};
```

**CLI additions:**
| Command | Purpose |
|---|---|
| `meetroom agent spawn <name> --cmd "<shell cmd>" [--sandbox <task-id>]` | Daemon launches + tracks the agent process |
| `meetroom agent stop <name>` / `restart <name>` | Lifecycle control |
| `meetroom agent logs <name> [--follow]` | Captured stdout/stderr per agent |

**Behavior:**
- The runner injects `MEETROOM_AGENT`, session id, and token into the child env, so the spawned agent's `meetroom` calls are pre-wired.
- Crash with `restartPolicy: on-crash` → restart with the *brief* (not raw history) as the re-entry prompt; the agent resumes warm.
- `--sandbox` composes with V3 #14: spawn directly inside a task's worktree.
- The web viewer gains a "runners" panel: green/red per process.

---

## 2. Budget Guardrails

**Why:** V2's cost tracking is observational. Overnight autonomy needs hard limits — an agent stuck in a loop should hit a wall, not a credit card statement.

**Data model addition:**
```ts
type Budget = {
  scope: "session" | "agent";
  agentId?: string;
  maxCostUsd?: number;
  maxTokens?: number;
  onBreach: "pause-agent" | "pause-room" | "notify-only";
  spentUsd: number;           // rolled up from usage reports
};
```

**Behavior:**
- `meetroom budget set --max-cost 20 --on-breach pause-room` (session) or `--agent <name>` (per agent).
- Breach triggers the configured action + a notification-bridge event (`budget-breached`) — this is exactly the event you want on your phone at 2am.
- Depends on agents actually reporting usage (`meetroom usage report`); the V7 adapter SDK automates that. Until then, guardrails are only as good as reporting discipline — document this loudly.

---

## 3. Room Routines (Scheduler)

**Why:** Some rooms should exist on a schedule, not on demand: nightly dependency-bump room, weekly refactor room, post-release cleanup room.

**CLI additions:**
| Command | Purpose |
|---|---|
| `meetroom routine create "<name>" --cron "0 2 * * *" --template <blueprint> [--guild <g>]` | Scheduled room creation |
| `meetroom routine list` / `delete <id>` | Manage routines |

**Behavior:**
- At fire time the daemon: creates a session from the template, spawns its runners (#1), applies budgets (#2), and posts the kickoff prompt.
- A routine's session **auto-ends** when the board is done or the budget/wall-clock cap hits — distilling memory (V2 #6) and exporting the report (V2 #10) as it goes down.
- The morning-after artifact is the export + notification, not a still-running room.

---

## 4. Liveness, Heartbeats & Task Reassignment

**Why:** Claim timeouts (V1) catch dead *claims*, not dead *agents*. An agent that crashed mid-task leaves a task stuck in `in-progress` forever.

**Behavior:**
- Every CLI call an agent makes doubles as a heartbeat (`lastSeenAt` already exists — start using it).
- `agent stalled` after N minutes without any call (configurable, default 15): status flips to `idle`, chat notice posted.
- After 2×N: status `disconnected`, claims released (existing leave logic), and **assigned in-progress tasks return to `todo`** with a `reassigned-from` note so the next claimant sees the history.
- Routing (V3 #4) deprioritizes agents with recent stall records — feeds the reputation system.

---

## 5. Attention Queue (Cross-Room Inbox)

**Why:** With routines and multiple projects, "check each web viewer" stops scaling. You need one place that answers: *what needs a human right now?*

**Data model addition:**
```ts
type AttentionItem = {
  id: string;
  sessionId: string;
  kind: "escalation" | "low-confidence-review" | "budget-breach" | "stalled-room" | "routine-failed";
  summary: string;
  createdAt: string;
  status: "open" | "acked" | "done" | "snoozed";
  snoozeUntil?: string;
};
```

**CLI additions:**
| Command | Purpose |
|---|---|
| `meetroom attention` | List open items across ALL sessions, oldest first |
| `meetroom attention ack/done/snooze <id> [--until 2h]` | Triage without opening the room |

**Behavior:**
- Everything that currently fires a webhook also lands here — webhooks are transport, the queue is state.
- Snoozed items resurface; done items link to what resolved them. The web viewer gets a global (non-session) attention page.

---

## 6. Shared Artifacts / Scratchpad

**Why:** Chat is a stream; agents also need a *place* — design notes, API sketches, decision docs that multiple agents read and revise without claiming code files.

**Data model addition:**
```ts
type Artifact = {
  id: string;
  name: string;               // e.g. "api-design.md"
  content: string;
  version: number;            // optimistic concurrency: write with expected version or fail
  updatedBy: string;
  updatedAt: string;
};
```

**Behavior:**
- `meetroom artifact write <name> --file notes.md` / `artifact read <name>` / `artifact list`.
- Version conflicts return the current content + version so the agent can merge — cheap CRDT-free concurrency that fits CLI usage.
- Artifacts are included in the join brief and survive into the session export.

---

## 7. Escalation Policies

**Why:** V1–V3 has one escalation behavior. Different rooms deserve different ladders — a nightly routine should try harder to self-resolve than a high-stakes release room.

**Data model addition:**
```ts
type EscalationPolicy = {
  onContested: ("retry-round" | "vote" | "lead-decides" | "human")[];  // ladder, in order
  humanResponseTimeoutMinutes?: number;   // nobody answers → next rung or safe-pause
  quietHours?: { from: string; to: string };  // don't page at 3am unless kind=budget-breach
};
```

**Behavior:**
- Configured at start (`--policy relaxed|strict|<file>`) or per session via `meetroom policy set`.
- `humanResponseTimeout` fixes today's silent dead-end: an escalation nobody sees eventually pauses the affected task instead of blocking the room forever.

---

## 8. Session Templates / Blueprints

**Why:** `start --guild` covers *who*; templates cover *everything else* — budgets, policies, gates, notify config, initial board.

**Behavior:**
- `.meetroom/templates/<name>.json` (project) or `~/.meetroom/templates/` (user): config + guild + budget + policy + optional pre-seeded tasks/plan description.
- `meetroom start --template nightly-deps`.
- `meetroom template save <name>` snapshots the *current* session's setup — build a good room once, reuse it forever.

---

## Suggested V4 Build Priority

1. **Liveness & reassignment (#4)** — smallest lift, fixes a real V1–V3 hole (stuck in-progress tasks); everything autonomous depends on it
2. **Budget guardrails (#2)** — non-negotiable before any unattended running
3. **Agent runner (#1)** — the centerpiece; do after #2/#4 so what it runs is safe
4. **Attention queue (#5)** — becomes necessary the week routines exist
5. **Escalation policies (#7)** — small, pairs with #5
6. **Session templates (#8)** — trivial once config surface stabilizes
7. **Shared artifacts (#6)** — useful anytime, blocks nothing
8. **Room routines (#3)** — last: it composes #1+#2+#8 and needs them stable
