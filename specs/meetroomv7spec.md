# Meetroom — V7 Feature Spec: Ecosystem

Builds on V6 (teams & trust). V7's theme: **meetroom stops being a tool and becomes a platform** — other people's agents, other people's tools, other people's workflows plug in without touching meetroom's core.

---

## 1. Agent Adapter Kit

**Why:** Every agent vendor needs the same glue: join on start, poll the inbox, report usage, exit cleanly. Today each user hand-writes that prompt/wrapper. Ship it.

**Behavior:**
- `meetroom adapter generate <claude|codex|generic> --name "Claude-1" --role Implementer` writes a ready-to-run wrapper script that:
  - joins the session (or activates a guild slot), exports `MEETROOM_AGENT`,
  - injects the brief + meetroom usage instructions into the agent's system prompt,
  - traps exit to `meetroom leave`, and (where the vendor CLI reports it) pipes token counts to `meetroom usage report`.
- Adapters are plain shell — inspectable, hackable, no runtime dependency on meetroom internals.
- The V4 agent runner consumes these directly: `meetroom agent spawn Claude-1 --adapter claude`.

## 2. Plugin Manifests & Permissions

**Why:** V3 plugins are raw shell templates any agent can run. Before a marketplace can exist, plugins need to declare what they touch.

**Data model addition (extends `Plugin`):**
```ts
type Plugin = {
  // ...V3 fields
  manifest?: {
    permissions: ("read-fs" | "write-fs" | "network" | "secrets")[];
    description: string;
    checksum?: string;        // integrity check for shared plugins
  };
};
```

**Behavior:**
- Installing a plugin with `write-fs`/`network`/`secrets` permissions requires operator confirmation (once per plugin+version).
- `plugin run` refuses if the manifest references a secret the session hasn't granted.
- Full sandboxed runtimes (WASM/containers) stay out of scope — manifests + confirmation raise the bar from "anything goes" to "informed consent" at 5% of the cost.

## 3. Inbound Integration Webhooks

**Why:** V3's notification bridge is outbound-only. Slack threads, issue trackers, and CI systems also need to *talk back*.

**Behavior:**
- `POST /api/sessions/:id/inbound` with `{ source, author, text, signature? }` → lands in room chat as `[slack] dana: ship it`.
- Per-source shared-secret signatures (HMAC) so a public endpoint can't be spammed into your room.
- `meetroom integration add slack --secret ...` prints the exact URL + payload contract; thin glue on the Slack/Jira side is the user's 10 lines, not ours.

## 4. Task Sync (Jira / Linear / GitHub Issues)

**Why:** Teams already have a board. Meetroom's board (V2) should mirror it, not compete with it.

**Behavior:**
- `meetroom sync configure github --repo owner/name --label meetroom` — issues with the label appear as tasks; task status moves post back as issue comments/labels.
- Sync is **eventually consistent and conflict-shy**: the external tracker wins on title/description, meetroom wins on status while a session is live.
- Same adapter interface for Jira/Linear (`sync configure jira --project KEY ...`); each adapter is ~200 lines against their REST APIs, credentialed via V6 secrets.

## 5. Interactive Web Viewer

**Why:** The read-only viewer (V1) predates operators (V6). Once humans have identity and permissions, the viewer should *act*: approve reviews, resolve escalations, prompt agents.

**Behavior:**
- Approve / request-changes / resolve / vote / prompt-all / pause — each button calls the same HTTP API the CLI uses, authenticated with the operator key (stored in localStorage, entered once).
- Role-gated client-side *and* server-side (server is the truth; the UI just hides what you can't do).
- Still no build step. Still plain HTML+JS. The viewer's simplicity is a feature.

## 6. Published API Contract (OpenAPI)

**Why:** Third parties can't build on an undocumented API. The HTTP surface is already stable; write it down and promise it.

**Behavior:**
- `GET /api/openapi.json` serves the spec; `meetroom api docs` opens a rendered view.
- Semantic versioning of the API independent of the CLI; breaking changes gated behind `/api/v2/` paths.
- Contract tests in CI: the spec is generated from the same route table the server runs, so drift is structurally impossible.

## 7. Blueprint & Guild Gallery (import/export)

**Why:** Good room setups (V4 templates + guilds + policies) are knowledge. Make them portable.

**Behavior:**
- `meetroom bundle export my-setup.mrb` — one JSON bundle: template + guild + policy + plugin manifests (never secrets, never memory).
- `meetroom bundle import <file|url>` with a dry-run diff of what it would install, and operator confirmation for anything carrying plugin permissions (#2).
- A "gallery" is just a git repo of `.mrb` files — no hosted infrastructure required to start sharing.

## 8. IDE Presence (VS Code extension)

**Why:** Agents live in terminals; humans live in editors. Claims and board state belong in the gutter, not in a fourth terminal tab.

**Behavior:**
- Read-only first pass: status bar (room/agents), file decorations for claimed files ("🔒 held by Codex"), board in a side panel — all over the existing HTTP API + SSE.
- Write actions (claim from editor, approve review) come later, using the operator key like the web viewer.
- **Build last.** It's the largest UI investment for the smallest core-value gain, same reasoning as V3's pair mode.

---

## Suggested V7 Build Priority

1. **Agent adapter kit (#1)** — removes the biggest real-world adoption friction, tiny lift
2. **Inbound webhooks (#3)** — small, completes the notification loop V3 started
3. **Plugin manifests (#2)** — prerequisite for sharing anything safely
4. **Blueprint gallery (#7)** — cheap once manifests exist
5. **OpenAPI contract (#6)** — cheap, unblocks third parties permanently
6. **Interactive viewer (#5)** — moderate lift, big daily-use payoff
7. **Task sync (#4)** — per-provider grind; do GitHub first, others on demand
8. **IDE presence (#8)** — last, by design
