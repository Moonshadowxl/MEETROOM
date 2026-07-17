# Meetroom

A local multi-agent coordination tool. Any CLI coding agent (Claude Code, Codex, GLM, DeepSeek, …) can join a shared "room," claim files and tasks, discuss and resolve disagreements, submit diffs for review, and work in the same repo without stepping on each other.

The single `meetroom` CLI binary is the only integration surface — every agent talks to a local daemon by running shell commands, so it works with any agent that can execute bash. No vendor plugins.

```
                ┌─────────────────────────┐
                │   meetroom daemon        │
                │   (localhost:7433)       │
                │  session state · claims  │
                │  chat · tasks · reviews  │
                └─────────┬────────────────┘
                          │ HTTP + SSE
        ┌─────────────────┼─────────────────┐
        │                 │                 │
   [Claude Code]      [Codex]           [Web viewer]
   in your-project/   in your-project/  (read-only UI)
```

Zero runtime dependencies. Node ≥ 18.

## Install

```sh
npm install && npm run build
npm link          # puts `meetroom` on your PATH
```

## Quick start

```sh
cd your-project/
meetroom start                # launches the daemon, creates a session, prints the viewer URL
```

Each agent (in its own terminal, same directory):

```sh
meetroom join --sxl <session-id> --name "Claude" --role Implementer
export MEETROOM_AGENT=Claude  # or pass --as Claude on each command
```

Then the working loop:

```sh
meetroom say "taking the auth endpoint"
meetroom task create "implement login" --files auth.py
meetroom task claim <task-id>            # assigns you + auto-claims its files
meetroom task move <task-id> in-progress
# ...edit code...
meetroom review submit <task-id>         # auto-generates the git diff
meetroom task move <task-id> review
# another agent:
meetroom review approve <review-id>
meetroom task move <task-id> done
```

You (the human) watch the web viewer, `meetroom listen`, or nudge the room:

```sh
meetroom prompt-all "wrap up current tasks, we ship in an hour"
meetroom prompt @Claude "your diff misses the error path"   # private
meetroom pair Claude                                        # live 1:1 lane
```

## Core rules

1. **No file is edited without a claim.** `meetroom claim <file>` locks it; a second claimant is rejected — or queued FIFO with `--wait`, and auto-granted when the holder releases. `meetroom guard install` turns this from a convention into an enforced check: a git pre-commit hook (and, with `--claude`, a Claude Code PreToolUse hook) blocks agents from touching unclaimed files. Humans and non-meetroom workflows are never blocked — the guard only enforces when `MEETROOM_AGENT` identifies an agent and the daemon is reachable.
2. **Claims time out.** Idle claims auto-release after 10 minutes (configurable via `meetroom start --claim-timeout M`) with a chat notice, and hand off to waiters.
3. **Propose → object → resolve.** `meetroom propose "<plan>"` opens a decision. No objection within the window → auto-resolved. Objection → the author gets one response round, then: 3+ agents vote (majority wins, lead agent can tie-break), otherwise it **escalates to the human**.
4. **Review gates done.** A task can't reach `review` without a submitted diff, and can't reach `done` without an approved review. Self-review is rejected by the daemon. `--confidence low` submissions require the *human* to approve.
5. **Dependencies block.** A task whose `--depends-on` tasks aren't done goes to `blocked` (with a notice) and pops back to `todo` when they finish.

## Command reference

Run `meetroom help` for the full list. Highlights by area:

| Area | Commands |
|---|---|
| Room | `start` `join` `leave` `status` `sessions` `brief` `pause` `resume` `end` `stop` `doctor` |
| Chat | `say` `prompt-all` `prompt @agent` `pair` `listen` `inbox` |
| Files | `claim [--wait]` `release` `touch` `guard install/uninstall/check` |
| Tasks | `task create/claim/move/show/assign/drop/edit/cancel` `board` `plan` (draft board from a feature description, requires approval) |
| Decisions | `propose` `object` `resolve` `reject` `vote` |
| Review | `review submit/approve/request-changes/comment/show/pr-sync` `test report` `ci report` |
| Ops | `export` `fork` `compare` `rollback` `sandbox` `usage` `memory` `reputation` |
| Extend | `plugin install/list/run` `notify configure` `roles` |

## Feature map (V1 → V3)

**V1 — core:** daemon + JSON persistence (`data/sessions/<id>.json`), join with profiles (prebuilt roles: Reviewer, Implementer, Tester, Architect — or a freehand role), chat, file claims with timeout auto-release, propose/object/resolve/escalate, read-only web viewer, `prompt-all`.

**V2:** task board over file claims · claim waitlists (`--wait`) · diff-based review gate · remote sessions (`start --remote` binds all interfaces + per-session token for non-localhost joins) · auto-brief on join + `meetroom brief` · persistent project memory (`.meetroom/memory.json`, distilled at `meetroom end`, hand-editable) · pause/resume · private `prompt @agent` · proposal voting with lead tie-break · timeline events, `export --format md|json`, per-agent token/cost tracking (`usage report/show`).

**V3:** plugins (shell command templates; `--project` scope persists in `.meetroom/plugins.json`) · PR integration (`review submit --pr` pushes `meetroom/<session>/<task>` and opens a PR via `gh`/`glab` or `MEETROOM_PR_CMD`; sync back with `review pr-sync` or the webhook endpoint) · CI gate (`--requires-ci`; generic webhook — see `meetroom ci webhook-url`) · cost/capability-aware routing (complexity estimate + suggested agent on every task) · agent reputation (`.meetroom/reputation.json`, informational) · confidence scoring · QA test gate (`--requires-tests` + `test report`) · session fork/compare · rollback to the session's base commit · Slack/Discord/webhook notification bridge · pair mode · natural-language task decomposition (`plan`, approval-gated) · sandboxed execution via git worktrees (`sandbox <task-id>`).

**V4 — operations & autonomy:** agent runner/supervisor (`agent spawn` with restart policies + logs) · budget guardrails (`budget set`, auto-pause on breach) · cron routines that create sessions from templates · liveness heartbeats with idle/disconnected detection and automatic task reassignment · cross-session attention queue (`attention` + ack/done/snooze) · versioned shared artifacts · escalation-timeout policies · session templates (`template save`, `start --template`).

**V5 — intelligence layer:** line-range claims (`claim --lines A-B`; whole-file trumps ranges) · advisory conflict prediction on task creation · review copilot first pass (`MEETROOM_REVIEWER`) · learned routing (reputation + stall history blended into suggestions) · memory graph with `recall` search, supersedes edges, and per-file surfacing at claim time · global memory promotion (`memory promote`) · adaptive per-file claim timeouts (p90 of history) · delta briefs (`brief --since last`). Every intelligent feature degrades to a deterministic heuristic with no model configured.

**V6 — teams & trust:** multi-operator identity with role-gated privileged commands (`operator invite`, `login`; solo mode stays frictionless) · TLS daemon option · repo policy engine (`.meetroom/policy.json` — human-review / two-reviewers / ci-pass / tests-pass rules that per-task flags can't relax) · tamper-evident audit chain (`audit verify`) · encrypted secrets with `{secret:NAME}` exec-time substitution and automatic chat redaction · org report · session purge (keeps the report, drops payloads).

**V7 — ecosystem:** agent adapter kit (`adapter generate claude|codex|generic`) · plugin permission manifests (dangerous permissions need `--confirm`) · HMAC-signed inbound webhooks (`integration add` → external systems post into room chat) · GitHub issue sync (`sync github --repo o/n --label meetroom`) · interactive web viewer (approve/resolve/pause/prompt from the browser with an operator key) · OpenAPI contract generated from the live route table (`/api/openapi.json`) · blueprint bundles (`bundle export/import`).

**V8 — self-improving org:** autonomy levels L0–L4 (`autonomy set`; L0 = agents discuss but don't act) · meta-agent operator (`MEETROOM_OPERATOR` handles attention items at L3+ behind a veto window; `veto <action-id>`) · retrospective engine (auto-generated at session end with config suggestions; `retro`) · self-healing detectors (blocked-board deadlocks, claim cycles, post-done CI regressions) · outcome verification (`task create --verify "<cmd>"` + `verify run` gates done) · epics spanning sessions (`epic create/status`, `task create --epic`).

**Lifecycle & operations (post-V8):** full task lifecycle (`task show/assign/drop/edit/cancel`, cancelling voids dependencies and unblocks dependents; reopen with `task move <id> todo`) · proposal veto/withdraw (`reject`, also a button in the web viewer) · graceful daemon shutdown (`meetroom stop`) · environment diagnostics (`meetroom doctor`: daemon, lock, agent contexts, orphaned worktrees, `.meetroom` JSON health) · live SSE web viewer (updates push instantly; polling is only a fallback) · append-only event log (`<id>.events.ndjson` beside each session snapshot — O(1) event writes, snapshots stay lean) · replay-protected inbound webhooks (signature covers `ts.text`, 5-minute freshness window, each signature accepted once) · once operators are configured, speaking as the human requires an operator key · votes and objections must come from joined agents (no ballot stuffing) · SSE streams for remote sessions authenticate via `?token=` (EventSource can't set headers).

The V4–V8 specs live in [`specs/`](specs/); the deep-dive usage manual is [`GUIDE.md`](GUIDE.md). Not implemented from the specs (documented there as bigger lifts): the V6 hosted relay, tree-sitter symbol claims (line ranges shipped instead), and the V7 IDE extension.

## Environment variables

| Variable | Purpose |
|---|---|
| `MEETROOM_PORT` | daemon port (default 7433) |
| `MEETROOM_AGENT` | which joined agent your commands act as |
| `MEETROOM_DATA_DIR` | where session JSON lives (default `<package>/data/sessions`) |
| `MEETROOM_SUMMARIZER` | shell command (stdin→stdout) used to distill decisions into memory, e.g. an LLM CLI |
| `MEETROOM_PLANNER` | shell command for `meetroom plan` decomposition (JSON in/out); heuristic fallback otherwise |
| `MEETROOM_PR_CMD` | PR-creation command template for `review submit --pr` (`{branch}`, `{title}`) |
| `MEETROOM_REVIEWER` | shell command for the review copilot (diff on stdin → JSON findings on stdout) |
| `MEETROOM_OPERATOR` | shell command for the L3+ meta-agent (attention item JSON in → action JSON out) |
| `MEETROOM_OPERATOR_KEY` | operator key for privileged commands (or `meetroom login --key`) |
| `MEETROOM_TLS_CERT` / `MEETROOM_TLS_KEY` | serve the daemon over HTTPS |
| `MEETROOM_SCHEME` | set to `https` so the CLI talks to a TLS daemon (or pass `--https` on `join`/any command) |
| `MEETROOM_HOME` | where templates/secrets/global memory live (default `~/.meetroom`) |

## Remote sessions

```sh
meetroom start --remote          # binds 0.0.0.0, prints a session token
# on another machine:
meetroom join --sxl <id> --name "Cloud-1" --role Tester \
  --host <daemon-host> --port 7433 --token <token>
meetroom notify configure --slack-webhook https://hooks.slack.com/...   # escalations reach you anywhere
```

## Landing page (deploy on Vercel)

The landing page lives in [`landing/`](landing/) — a Vite + React + TypeScript app built with HeroUI. The repo ships a `vercel.json` that installs and builds it (`cd landing && npm install && npm run build`) and serves `landing/dist`. To develop it locally run `cd landing && npm install && npm run dev`; to publish:

```sh
npm i -g vercel
vercel           # from the repo root; accept the defaults
vercel --prod    # promote to production
```

Or connect the GitHub repo at [vercel.com/new](https://vercel.com/new) — the included config makes Vercel serve `landing/` statically. Note the daemon itself is a long-lived local process and is *not* deployable to Vercel; only the landing page is.

## Development

```sh
npm run build   # tsc → dist/
npm test        # builds, then node --test (101 tests: claims, resolution, tasks/gates, guard, sessions, HTTP e2e, regressions)
```

Layout follows the spec: `src/daemon/` (state + rules), `src/cli/` (command router + thin HTTP client), `src/web/` (no-build viewer), `src/shared/` (types + roles), `tests/`.
