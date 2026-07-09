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

1. **No file is edited without a claim.** `meetroom claim <file>` locks it; a second claimant is rejected — or queued FIFO with `--wait`, and auto-granted when the holder releases.
2. **Claims time out.** Idle claims auto-release after 10 minutes (configurable via `meetroom start --claim-timeout M`) with a chat notice, and hand off to waiters.
3. **Propose → object → resolve.** `meetroom propose "<plan>"` opens a decision. No objection within the window → auto-resolved. Objection → the author gets one response round, then: 3+ agents vote (majority wins, lead agent can tie-break), otherwise it **escalates to the human**.
4. **Review gates done.** A task can't reach `review` without a submitted diff, and can't reach `done` without an approved review. Self-review is rejected by the daemon. `--confidence low` submissions require the *human* to approve.
5. **Dependencies block.** A task whose `--depends-on` tasks aren't done goes to `blocked` (with a notice) and pops back to `todo` when they finish.

## Command reference

Run `meetroom help` for the full list. Highlights by area:

| Area | Commands |
|---|---|
| Room | `start` `join` `leave` `status` `sessions` `brief` `pause` `resume` `end` |
| Chat | `say` `prompt-all` `prompt @agent` `pair` `listen` `inbox` |
| Files | `claim [--wait]` `release` `touch` |
| Tasks | `task create/claim/move` `board` `plan` (draft board from a feature description, requires approval) |
| Decisions | `propose` `object` `resolve` `vote` |
| Review | `review submit/approve/request-changes/comment/show/pr-sync` `test report` `ci report` |
| Ops | `export` `fork` `compare` `rollback` `sandbox` `usage` `memory` `reputation` |
| Extend | `plugin install/list/run` `notify configure` `guild create/list` `roles` |

## Feature map (V1 → V3)

**V1 — core:** daemon + JSON persistence (`data/sessions/<id>.json`), join with profiles (prebuilt roles: Reviewer, Implementer, Tester, Architect — or freehand name/age/personality/vibe), chat, file claims with timeout auto-release, propose/object/resolve/escalate, read-only web viewer, `prompt-all`.

**V2:** task board over file claims · claim waitlists (`--wait`) · diff-based review gate · remote sessions (`start --remote` binds all interfaces + per-session token for non-localhost joins) · auto-brief on join + `meetroom brief` · persistent project memory (`.meetroom/memory.json`, distilled at `meetroom end`, hand-editable) · pause/resume · private `prompt @agent` · proposal voting with lead tie-break · timeline events, `export --format md|json`, per-agent token/cost tracking (`usage report/show`).

**V3:** plugins (shell command templates; `--project` scope persists in `.meetroom/plugins.json`) · PR integration (`review submit --pr` pushes `meetroom/<session>/<task>` and opens a PR via `gh`/`glab` or `MEETROOM_PR_CMD`; sync back with `review pr-sync` or the webhook endpoint) · CI gate (`--requires-ci`; generic webhook — see `meetroom ci webhook-url`) · cost/capability-aware routing (complexity estimate + suggested agent on every task) · agent reputation (`.meetroom/reputation.json`, informational) · confidence scoring · QA test gate (`--requires-tests` + `test report`) · session fork/compare · rollback to the session's base commit · guilds (`~/.meetroom/guilds.json`) · Slack/Discord/webhook notification bridge · pair mode · natural-language task decomposition (`plan`, approval-gated) · sandboxed execution via git worktrees (`sandbox <task-id>`).

## Environment variables

| Variable | Purpose |
|---|---|
| `MEETROOM_PORT` | daemon port (default 7433) |
| `MEETROOM_AGENT` | which joined agent your commands act as |
| `MEETROOM_DATA_DIR` | where session JSON lives (default `<package>/data/sessions`) |
| `MEETROOM_SUMMARIZER` | shell command (stdin→stdout) used to distill decisions into memory, e.g. an LLM CLI |
| `MEETROOM_PLANNER` | shell command for `meetroom plan` decomposition (JSON in/out); heuristic fallback otherwise |
| `MEETROOM_PR_CMD` | PR-creation command template for `review submit --pr` (`{branch}`, `{title}`) |
| `MEETROOM_HOME` | where guilds are stored (default `~/.meetroom`) |

## Remote sessions

```sh
meetroom start --remote          # binds 0.0.0.0, prints a session token
# on another machine:
meetroom join --sxl <id> --name "Cloud-1" --role Tester \
  --host <daemon-host> --port 7433 --token <token>
meetroom notify configure --slack-webhook https://hooks.slack.com/...   # escalations reach you anywhere
```

## Development

```sh
npm run build   # tsc → dist/
npm test        # builds, then node --test (36 tests: claims, resolution, tasks/gates, sessions, HTTP e2e)
```

Layout follows the spec: `src/daemon/` (state + rules), `src/cli/` (command router + thin HTTP client), `src/web/` (no-build viewer), `src/shared/` (types + roles), `tests/`.
