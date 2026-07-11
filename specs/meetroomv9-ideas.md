# Meetroom V9 — candidate features (ideas, not yet committed)

Suggestions from the 2026-07 bug sweep. Ordered by expected value ÷ effort.
Nothing here is implemented; each item states the problem it solves.

## 1. Event log compaction & state-endpoint paging
`GET /state` returns the **entire** session — chat log, events, review diffs —
on every web-viewer refresh. Long sessions make the viewer (and any polling
agent) quadratic. Add `?fields=` selection and `?events-since=` paging, and a
`meetroom compact <id>` that archives old events past a threshold. This is the
first real scalability wall the tool will hit.

## 2. First-class npm publish
`npm i -g meetroom` beats clone-and-link. Needs: `files` allowlist in
package.json, `prepublishOnly: npm test`, shipping `dist/` + `src/web/`, and a
CI release workflow. Zero-dependency install is already true — capitalize on it.

## 3. Web viewer: task & claim actions
The viewer can pause/resume, decide reviews, and resolve proposals, but tasks
and claims are read-only. Add create/assign/move on the board and a
force-release button on claims (operator-gated). This is the natural next
increment of V7 #5.

## 4. `meetroom watch` TUI
A single-terminal curses-style dashboard (board + chat + attention) for people
who never open the browser. The SSE stream already carries everything needed.

## 5. Agent-level scopes on the session token
Today every agent in a remote session shares one token and agent identity is
honor-system: any tokenholder can act *as* any agentId. Mint per-agent tokens
at join (`token:agentId` binding, enforced server-side) so a compromised or
buggy agent can't impersonate its reviewer. Biggest remaining trust gap.

## 6. Merge-queue awareness
Reviews know about PRs, but two approved tasks can still race to merge
conflicting diffs. A tiny merge queue — `task move done` enqueues, daemon
serializes "merge slots" per repo — closes the last collision window the tool
doesn't cover.

## 7. Routine catch-up policy
Routines fire only if the daemon is awake at the matching minute; a laptop
asleep at 02:00 silently skips the nightly session. Record `lastFiredAt`
vs. expected schedule and offer `catchUp: "once" | "skip"` per routine.

## 8. Structured agent capabilities
`strengths` are free-text keywords matched by substring. A small controlled
vocabulary (languages, frameworks, task kinds) with weights would make routing
suggestions meaningfully better without any model calls.

## 9. Session archive format
`end` + `purge` keep a markdown report, but there's no way to *re-open* an
archived session read-only. A `meetroom archive export/open <id>` pair (single
`.mra` file: snapshot + events + report) would make sessions portable evidence.

## 10. Windows support pass
Runner spawning uses `sh -c`, adapters are POSIX shell, and paths assume `/`.
A compat pass (cmd/PowerShell templates, `shell: true` spawns) opens the tool
to a large audience at modest cost.
