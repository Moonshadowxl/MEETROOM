# Meetroom — V8 Feature Spec: The Self-Improving Org

Builds on everything (V1–V7). V8's theme: **the room learns to run itself** — and earns the right to, gradually. Every feature here has the same shape: automate a judgment the human currently makes, measure whether the automation is actually good, and keep a veto lever within reach.

The governing rule for all of V8: **autonomy is granted per capability, per track record — never globally, never by default.**

---

## 1. Autonomy Levels

**Why:** "Fully autonomous" is not a switch, it's a ladder. Make the ladder explicit so every other V8 feature can hang off it.

**Data model addition:**
```ts
type AutonomyConfig = {
  level: 0 | 1 | 2 | 3 | 4;
  // L0 observe: agents propose, humans do everything
  // L1 assisted: agents claim/work, humans gate review + escalations (≈ V1–V3 default)
  // L2 supervised: agent-approved reviews merge; escalations still human
  // L3 managed: meta-agent (#2) handles escalations within veto window
  // L4 delegated: human sees reports, intervenes by exception
  vetoWindowMinutes: number;      // L3+: actions announce, wait, then execute
  capabilityOverrides?: Record<string, 0 | 1 | 2 | 3 | 4>;  // e.g. { "merge": 1, "task-assignment": 4 }
};
```

**Behavior:**
- Set per session (`start --autonomy 2`) or per template; policy rules (V6 #3) always outrank autonomy — L4 still can't merge `src/payments/` without a human if policy says so.
- Every gate in the system consults one function: `allowed(action, autonomyLevel, trackRecord)`. One choke point, auditable.

## 2. Meta-Agent Operator

**Why:** V4's attention queue collects what needs a human. At L3+, most items don't actually need a *human* — they need a *decision-maker with context*.

**Behavior:**
- A designated operator model (`MEETROOM_OPERATOR` command, same pluggable pattern as summarizer/planner/reviewer) is fed each attention item + room state and returns a structured action: `resolve-proposal`, `reassign-task`, `adjust-budget`, `wake-human`.
- Actions execute after the veto window (#1): announced in chat + notification, executed if no operator objects in N minutes.
- `wake-human` is always available and never penalized — an operator model that escalates honestly is a good operator.
- Every meta-agent decision lands in the audit chain (V6 #4) marked `actor: meta-agent`, with the full input it saw. Reviewability is the price of the privilege.

## 3. Retrospective Engine

**Why:** Sessions end and their lessons evaporate. The export (V2 #10) records *what happened*; nothing records *what should change*.

**Behavior:**
- On session end, generate a retro: time-in-column stats, review bounce rates, escalation causes, budget accuracy, timeout hit rates — deterministic math first, optional model narrative on top.
- Retros produce **suggested config diffs** ("claim timeout hit 9× on migration files → suggest 25m for `db/migrations/**`"), applied to the session's template only with approval — or automatically at autonomy L3+ with the veto window.
- Retros accumulate in `.meetroom/retros/`; the routing and timeout learners (V5) read them as labeled ground truth.

## 4. Simulation / Dry-Run Mode

**Why:** A bad task decomposition (V3 #13) wastes real hours and real dollars. Historical data (V5) is good enough to price a plan *before* running it.

**Behavior:**
- `meetroom simulate "<feature description>"` → drafts the plan (V3 #13 machinery), then estimates per-task: predicted turnaround (nearest-neighbor over completed tasks), predicted cost (per-agent historical burn), conflict risk (V5 #2), and a critical path.
- Output: "6 tasks, est. 4.2 agent-hours, ~$11, longest path schema→api→tests, risk: task 3 and 5 both touch auth.py."
- Prediction accuracy is itself tracked (predicted vs. actual on approved plans) and reported in retros (#3) — the simulator has to earn trust like everything else.

## 5. Fleet Learning

**Why:** Every room learns alone (V5). Ten rooms across five projects re-learn the same lessons about the same agents.

**Behavior:**
- Opt-in per project: completed-task records (agent identity, complexity, turnaround, rework — **no code, no chat, no filenames**) roll up to `~/.meetroom/fleet-stats.json`.
- Routing priors, adaptive timeouts, and simulation estimates blend fleet stats with local stats (local wins as it accumulates — a project's own history beats the fleet average).
- Strictly stats, strictly local disk, strictly opt-in. This is not telemetry; nothing leaves the machine unless V6 org tooling explicitly aggregates it.

## 6. Self-Healing Rooms

**Why:** At L3+, nobody is watching for pathological states: every task blocked, two agents deadlocked on each other's waitlists, a regression merged an hour ago.

**Behavior:**
- **Deadlock detector:** waitlist cycles and fully-blocked boards → auto-diagnose, post the dependency cycle to chat, and (L3+) reorder or split the knot via the meta-agent; below L3, attention item.
- **Regression tripwire:** if a task's verification (#7) or CI goes red *after* its merge to done, auto-open a fix task linked to the culprit, assign per routing, and at L4 optionally auto-rollback (V3 #9) the offending branch behind the veto window.
- **Stall spiral:** room-wide throughput ≈ 0 for M minutes with budget burning → pause the room, page the human. Doing nothing expensively is the one failure mode never allowed to continue.

## 7. Outcome Verification (goal tests)

**Why:** Review + CI verify the *code*. Nothing verifies the *goal* — "the login endpoint actually logs a user in" is checkable, so check it.

**Data model addition (extends `Task`):**
```ts
type Task = {
  // ...V7 fields
  verify?: { command: string; timeoutSeconds: number };   // exit 0 = goal met
  verifyResult?: { passed: boolean; output: string; at: string };
};
```

**Behavior:**
- `task create "add login" --verify "curl -sf localhost:8000/login -d '...' | grep token"` — the acceptance test is written *at task creation*, before implementation bias sets in.
- `done` requires a passing verify run (like CI, V3 #3, but local and goal-shaped); `meetroom verify run <task-id>` executes in the task's sandbox (V3 #14).
- Verify commands are the natural artifact for the QA role (V3 #7) to author — and the ground truth that makes every learner in V5/V8 honest.

## 8. Epics (long-horizon work)

**Why:** Sessions are days; real projects are quarters. Nothing today connects "this month's ten sessions" to "the migration we're actually doing."

**Data model addition (`.meetroom/epics.json`, travels with the repo):**
```ts
type Epic = {
  id: string;
  title: string;
  northStar: string;            // the outcome, phrased so verify-style checks can attach
  taskRefs: { sessionId: string; taskId: string }[];
  status: "active" | "done" | "abandoned";
};
```

**Behavior:**
- `meetroom epic create "Postgres migration"` · `task create ... --epic <id>` · `meetroom epic status` shows cross-session progress.
- Session briefs mention active epics; the planner (V3 #13) and simulator (#4) take `--epic` to decompose *toward the north star* with memory of every previous session's contribution.
- Retros roll up per epic, not just per session — "are we getting faster at this migration?" finally has an answer.

---

## Suggested V8 Build Priority

1. **Autonomy levels (#1)** — the framework everything else keys off; small, do first
2. **Outcome verification (#7)** — immediately useful even at L1, and generates the ground truth for all learning
3. **Retrospective engine (#3)** — deterministic stats first; starts compounding value from the next session onward
4. **Epics (#8)** — small data model, big orientation payoff
5. **Simulation (#4)** — needs V5 history + #3 accuracy tracking
6. **Self-healing (#6)** — detector-only first (attention items), actions once the meta-agent exists
7. **Fleet learning (#5)** — wants months of data; start collecting early, act on it late
8. **Meta-agent (#2)** — last and highest-stakes: it inherits every safeguard the rest of V8 built
