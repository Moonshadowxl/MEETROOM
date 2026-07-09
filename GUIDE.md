# Meetroom — The Master Guide

Everything the README doesn't tell you: what meetroom is actually good at, where it will bite you, how to run rooms that work, and the tricks that only become obvious after a few sessions.

For the feature-by-feature reference, see [README.md](README.md) and the design docs in [`specs/`](specs/). This guide is about *using* the thing well.

---

## 1. What meetroom is (and isn't)

Meetroom is a **coordination layer**, not an agent. It doesn't write code, doesn't call models, doesn't decide anything. It gives N coding agents (any vendor — the only requirement is "can run a shell command") a shared place to:

- **claim** files and tasks so they don't collide,
- **discuss** and settle disagreements without you refereeing every one,
- **gate** work behind reviews, tests, CI, policy, and goal verification,
- **remember** decisions across sessions,
- and **escalate** to you only when it's actually your call.

It is deliberately boring technology: one daemon, JSON on disk, plain HTTP + SSE, zero runtime dependencies. Every "intelligent" feature (routing, conflict prediction, copilot review, planning) has a deterministic fallback and works with no model configured — LLM hooks are upgrades, never requirements.

### When to use it

- 2–5 agents working the same repo at the same time.
- Long or unattended runs where you want gates and budgets instead of hope.
- Mixed fleets (Claude + Codex + a cheap local model) where routing and cost tracking matter.
- Any time you've been burned by two agents editing the same file.

### When NOT to use it

- **One agent, one task.** The ceremony costs more than it saves. Just run the agent.
- **Throwaway scripts.** Claims and reviews are overhead when the blast radius is one file you'll delete tomorrow.
- **Hard-real-time collaboration.** The granularity is claims and messages, not keystrokes. Two agents genuinely co-editing one function still needs one agent to own it.
- **Untrusted code from strangers.** Sandboxing is git worktrees, not containers. It protects against clumsiness, not malice.

---

## 2. Honest pros and cons

### Pros

- **Vendor-neutral by construction.** The CLI is the whole integration surface. Any agent that can run bash is a first-class citizen; no SDK, no plugin per vendor.
- **The review gate changes agent behavior.** Once `done` requires another agent's approval, quality goes up even before a human looks — agents write for a reader.
- **Everything is inspectable.** Session state is one JSON file. Memory, policy, epics, plugins are hand-editable files in your repo. When something's confusing, `cat` it.
- **Gates compose.** Review + tests + CI + policy + verify all stack on the same `task move done` choke point. Adding a gate never requires touching another gate.
- **Graceful degradation.** No model configured → heuristics. No operators configured → solo mode, zero ceremony. No CI → in-room test gate. The floor is always usable.
- **The audit chain is cheap insurance.** Hash-chained events mean "who approved this and when" always has a verifiable answer.

### Cons

- **Agents must cooperate.** Meetroom can't force an agent to claim before editing (V1 chose warning over hard-block). A sloppy prompt makes a sloppy citizen — the adapter scripts exist precisely to bake the rules into the agent's system prompt.
- **Usage tracking is honor-system.** Budgets enforce only what agents report via `usage report`. Until your adapter automates it, treat cost numbers as a floor, not truth.
- **Polling latency.** Agents without a live `listen` stream notice chat/waitlist grants on their next CLI call. Sub-second reaction times aren't a design goal.
- **The daemon is a single point of coordination.** It restarts cleanly (state is on disk) but there's no HA story, and runner processes don't survive a daemon restart.
- **Localhost trust model by default.** Anything on localhost can talk to the daemon. Operators/TLS/tokens exist (V6) but you have to turn them on.
- **Learned features need data.** Adaptive timeouts, routing, simulation are only as good as the history — the first sessions run on defaults and honest guesses.

---

## 3. Setting up a room that works — recipes

### Recipe A: you + two agents, supervised (the default day)

```sh
cd your-project
meetroom start --agents 2
# terminal 2 and 3 (or use adapters, below):
meetroom join --sxl <id> --name Claude --role Implementer --cost-tier high
meetroom join --sxl <id> --name Codex --role Reviewer --cost-tier medium
```

Keep the web viewer open. Create tasks yourself (`task create`), let agents claim them, approve reviews from the viewer or `review approve`. This is autonomy L1 — the sweet spot until you trust the loop.

### Recipe B: adapters + runners (agents that join themselves)

```sh
meetroom adapter generate claude --name Claude-1 --role Implementer
meetroom agent spawn Claude-1 --cmd "./meetroom-claude-claude-1.sh" --restart on-crash
meetroom agent logs Claude-1
```

The adapter joins, injects the brief + house rules into the agent's prompt, reports leave on exit. The runner restarts it on crash (re-entering with a *delta* brief, not a cold start).

### Recipe C: the unattended overnight room

```sh
meetroom start --template nightly   # template bundles config+roster+budgets+notify
meetroom budget set --max-cost 15 --on-breach pause-room
meetroom notify configure --slack-webhook https://hooks.slack.com/...
meetroom autonomy set 2
meetroom agent spawn ... (×N)
```

Rules of thumb for unattended rooms:
1. **Never run unattended without a budget.** This is the whole reason budgets exist.
2. Set `--requires-tests` or `--verify` on every task — gates are your absence.
3. Configure escalation timeouts (`--policy` / `escalation.humanResponseTimeoutMinutes`) so an unanswered escalation pauses work instead of blocking silently.
4. In the morning: `meetroom attention`, then `meetroom retro`.

### Recipe D: the recurring maintenance room

```sh
meetroom template save deps-room --user     # after building a good setup once
meetroom routine create "nightly deps" --cron "0 2 * * *" --template deps-room
```

The routine creates the session, spawns runners from the template, and the retro + export are your morning artifact.

---

## 4. Tips & tricks

### Claims

- **`--wait` beats retrying.** Queued claims auto-grant on release and the whole room sees who's waiting — an agent that polls `claim` in a loop is doing it wrong.
- **`claim --lines 120-180`** when two agents genuinely need the same big file. Whole-file claims trump ranges, so escalating from range → file is always possible.
- **`touch` long work.** The timeout sweeper only sees `lastActivityAt`. An agent deep in a 30-minute edit should `meetroom touch <file>` occasionally — or claim with `--timeout 40` up front.
- Timeouts learn per file (p90 of history). If migrations keep timing out, that fixes itself after a few sessions — or set the override and move on.

### Tasks & the board

- **Files on tasks are load-bearing.** `task claim` auto-claims them, conflict prediction uses them, policy matches on them, memory links to them. A task with no `--files` opts out of all four.
- **Write the `--verify` command at creation time**, before implementation bias sets in. It's the cheapest "did we actually build the thing" insurance available.
- `--depends-on` at creation beats discovering the dependency as a mid-session block. `simulate "<feature>"` prices a plan *and* leaves it as an approvable draft.
- Trust the routing suggestion as a default, not a rule — it learns from reputation and stall history, but you know things it doesn't.

### Reviews

- **Never let agents rubber-stamp.** The daemon already blocks self-review; keep at least one agent whose *role* is Reviewer so approvals don't come from whoever is least busy.
- Ask agents to self-report `--confidence`. `low` routes to you automatically — that's the system working, not failing.
- Wire `MEETROOM_REVIEWER` early (any LLM CLI that reads a diff and emits JSON findings). A 30-second copilot pass before peer review measurably cuts bounce rounds.
- `review show <id>` prints the full diff in the terminal — you don't need the viewer to review.

### Chat & attention

- `prompt @agent` for course corrections; `prompt-all` only for room-wide context. Private nudges don't derail the other agents' context windows.
- `meetroom attention` is the only inbox you need across every room. Snooze liberally — snoozed items come back.
- `brief --since last` is the command agents should run at the top of every work cycle. It's the difference between "catching up" and "re-reading everything."

### Memory

- End sessions properly (`meetroom end`) — that's when decisions distill into memory. Killing the daemon skips the lesson.
- Curate `.meetroom/memory.json` occasionally; it's meant to be hand-edited. Use `supersedes` links instead of deleting — history stays, briefs stay clean.
- `memory promote` your personal conventions once, and every project gets them.

### Cost

- Make agents report usage in the adapter/prompt (`usage report --in N --out N --cost X`) — everything downstream (budgets, org report, simulation cost estimates) depends on it.
- Per-agent budgets (`--on-breach pause-agent`) are kinder than room budgets: one runaway agent stops, the room continues.

### Secrets & safety

- Put every token in `meetroom secret set` and reference `{secret:NAME}` in plugin/PR commands. You get encryption at rest *and* automatic redaction if an agent pastes the value into chat.
- Add a `.meetroom/policy.json` the day the project matters. Ten lines of policy beats remembering to pass `--requires-ci` on every risky task:

```json
[{ "id": "payments", "match": { "paths": ["src/payments/**"] }, "require": ["human-review", "ci-pass"] }]
```

- Run agents in sandboxes (`meetroom sandbox <task-id>`) for anything experimental — worktree isolation is cheap and the branch naming feeds PR integration.

### Autonomy (go slow)

- The ladder is L0 observe → L1 assisted (default) → L2 supervised → L3 managed → L4 delegated. **Earn each level with a few clean retros before granting the next.**
- L3+ without `MEETROOM_OPERATOR` set does nothing — the meta-agent is a hook you provide, not a built-in mind.
- The veto window is your friend: meta-agent actions announce in chat and wait. `meetroom veto <id>` costs one command; an un-vetoed bad action costs an evening.
- Policy always outranks autonomy. L4 still can't merge into a path your policy protects.

---

## 5. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `cannot reach meetroom daemon` | Daemon not running (`meetroom start` launches it) or wrong port — check `.meetroom/lock` and `MEETROOM_PORT`. |
| `no active meetroom session here` | You're in a different directory than `meetroom start` ran in, or the lock file was deleted. Pass `--session <id>` explicitly. |
| Agent's commands act as "human" | The agent didn't set `MEETROOM_AGENT` / `--as`. Every joined agent must export it (adapters do this). |
| `multiple agents joined from this directory` | Two agents share the cwd without `--as`. Set `MEETROOM_AGENT` per terminal. |
| Claims keep auto-releasing mid-work | Agent isn't calling any CLI command for >10m. Use `touch`, `--timeout`, or raise `--claim-timeout` at start. |
| Task stuck in `blocked` | `meetroom board` shows the `depends on:` line — a dependency isn't `done`. Deadlocked graphs land in `meetroom attention`. |
| `moving to review requires a submitted diff` | Run `review submit <task-id>` first; it needs a non-empty `git diff`. Committed already? It falls back to diffing against the session's base commit. |
| `task cannot move to done` | Some gate is unsatisfied. `meetroom status` shows pending reviews; check `test report`, `ci report`, `verify run`, and `GET .../tasks/:id/policy` for which rule binds. |
| Budget errors (HTTP 402) | That agent breached its cap. `budget show`, then raise it or leave it stopped — that's the guardrail doing its job. |
| `operator key required` | Operators are configured, so privileged commands need `meetroom login --key ...` (or `MEETROOM_OPERATOR_KEY`). |
| Room paused and you don't know why | `meetroom inbox` — the auto-pause reason (budget breach, unanswered escalation, meta-agent) is always posted to chat. |
| Daemon port conflict | `MEETROOM_PORT=7500 meetroom start` — everything (lock files, viewer URL) follows the port. |
| Stale lock after a crashed session | Delete `.meetroom/lock` and `meetroom start` fresh; session JSON in `data/sessions/` survives regardless. |

---

## 6. How the pieces fit (mental model)

```
                       ┌─ policy.json (repo law)
                       ├─ budgets (money law)
                       └─ autonomy level (trust law)
                                 │ all evaluated at…
 agents ── claims ── tasks ── [ task move done ] ── memory ── next session
              │         │            ▲
        waitlists   reviews ─ tests ─┤─ CI ─ verify
                                 (the one choke point)
```

Everything meaningful funnels through task state transitions. That's why the system stays comprehensible as features stack: gates are just predicates on one function (`moveTask`), and every learner (reputation, routing, timeouts, retros, simulation) reads from the same event log those transitions produce.

Three files tell you everything about a room after the fact:

- `data/sessions/<id>.json` — what happened (hash-chained)
- `.meetroom/memory.json` — what we decided
- `.meetroom/retros/<id>.json` — what should change

---

## 7. FAQ

**Do agents have to be LLMs?** No. Anything that can run shell commands can join — a human in a second terminal is a perfectly good "agent."

**Can I run multiple rooms at once?** Yes — one daemon hosts many sessions across many projects. `meetroom sessions` lists them; `meetroom attention` is the shared inbox.

**What happens if the daemon dies mid-session?** State is persisted on every mutation. Restart the daemon; sessions reload; runner processes are marked stopped (respawn them). The only loss is in-flight SSE connections.

**How do I get my usage numbers in automatically?** Wrap your agent with `adapter generate` and extend the script — most vendor CLIs print token counts you can pipe into `usage report`.

**Is remote mode safe on the open internet?** With `--remote` + TLS + operator keys it's tolerable; without TLS it's not. The spec'd relay (V6 #6) is the right long-term answer and intentionally not built yet.

**Why did my proposal auto-resolve?** Nobody objected within the objection window (default 5m). That's by design — silence is consent, so rooms don't stall on ceremony.

**Where's the line between `plan`, `simulate`, and `epic`?** `plan` drafts a board from a description. `simulate` does the same *plus* time/cost estimates. `epic` groups tasks across many sessions toward one outcome. Simulate before approving; attach to an epic if the work outlives the session.

**What wasn't built from the specs?** The hosted relay (V6 #6), tree-sitter symbol claims (V5 #1 shipped the `lines:A-B` half), and the VS Code extension (V7 #8). Each is spec'd with rationale for why it's last.
