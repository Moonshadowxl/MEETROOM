# Meetroom — V5 Feature Spec: The Intelligence Layer

Builds on V4 (ops & autonomy). V5's theme: **the room gets smarter, not just busier**. Everything here replaces a dumb heuristic from V1–V4 with something that learns from the data the earlier versions have been collecting — reputation records, task histories, claim durations, review outcomes.

A deliberate constraint carried through this spec: every intelligent feature must **degrade gracefully to the V3 heuristic** when no model/provider is configured. Intelligence is an upgrade, never a dependency.

---

## 1. Semantic Claims (symbol-level locking)

**Why:** File-level claims serialize work that isn't actually conflicting. Two agents editing different functions in a 3k-line `api.ts` shouldn't block each other.

**Data model addition:**
```ts
type SemanticClaim = {
  filepath: string;
  symbol: string;             // "class AuthService" / "function login" / "lines:120-180"
  agentId: string;
  claimedAt: string;
  lastActivityAt: string;
};
```

**Behavior:**
- `meetroom claim src/api.ts --symbol "handleLogin"` — parsed via tree-sitter (bundled grammars for the top ~10 languages; `lines:A-B` range fallback for everything else).
- Two symbol claims in one file coexist unless their ranges overlap; a *file-level* claim still trumps and blocks all symbol claims (coarse beats fine, never surprises).
- Release/timeout/waitlist semantics identical to V1/V2 — same sweeps, same chat notices.
- **Honest cost note:** this is the hardest feature in V5. Ship `lines:A-B` first (a week), tree-sitter symbols second (a month).

---

## 2. Conflict Prediction

**Why:** The best conflict is one that never happens. At task creation, the daemon already knows every other task's files and text — use them.

**Behavior:**
- On `task create`, compute overlap: shared files (exact), shared symbols (if #1 is live), and text similarity against open tasks (embeddings when a provider is configured, TF-IDF cosine when not).
- Above threshold → warning on the task + chat notice: `"task-x likely conflicts with task-y (both touch auth.py + similar scope) — consider a dependsOn"`.
- One-keystroke fix: `meetroom task link <a> --depends-on <b>` accepts the suggestion.
- Never blocks creation. Advisory only, like routing (V3 #4).

---

## 3. Review Copilot (automatic first pass)

**Why:** Peer review (V2 #3) has latency — the reviewer agent is busy with its own task. A cheap automatic first pass catches the obvious problems in seconds and makes the peer's job faster.

**Data model addition (extends `Review`):**
```ts
type Review = {
  // ...V3 fields
  copilotFindings?: { severity: "info" | "warn" | "blocker"; line?: number; text: string }[];
  copilotVerdict?: "looks-clean" | "needs-attention";
};
```

**Behavior:**
- On `review submit`, the daemon pipes the diff through `MEETROOM_REVIEWER` (any LLM CLI, stdin→JSON findings). No command configured → step is skipped silently.
- Findings attach as review comments from agent `"copilot"`; **the copilot cannot approve** — it's a triage layer, the self-review ban stays intact.
- `copilotVerdict: needs-attention` + `authorConfidence: low` (V3 #6) is the strongest "human should look" signal in the system — route it to the attention queue (V4 #5).

---

## 4. Learned Routing

**Why:** V3 routing is keyword matching. By V5 there are hundreds of completed tasks with known outcomes — who finished what, how fast, with how much rework. That's a training set.

**Behavior:**
- Score(agent, task) blends: reputation on *similar past tasks* (nearest neighbors by embedding/TF-IDF), current load, cost tier vs. estimated complexity, and stall history (V4 #4).
- Complexity estimation upgrades from regex to a classification call when a provider exists — with the actual turnaround feeding back as the label. The estimator gets better every session, silently.
- Output shape unchanged: still a *suggestion* on the task (`suggestedAgentId`), still human/agent-overridable. Same API, better brain.

---

## 5. Memory Graph + Recall

**Why:** `.meetroom/memory.json` (V2 #6) is a flat list. After 50 sessions it's a junk drawer. Decisions need structure and search.

**Data model change (supersedes flat decisions):**
```ts
type MemoryNode = {
  id: string;
  kind: "decision" | "convention" | "gotcha" | "architecture";
  summary: string;
  links: { files?: string[]; taskIds?: string[]; supersedes?: string };  // graph edges
  sourceSessionId: string;
  date: string;
};
```

**Behavior:**
- `meetroom recall "how do we handle auth tokens"` — semantic search over memory (embeddings if configured, keyword otherwise). Agents are told in the brief to `recall` before proposing.
- `supersedes` edges solve stale memory: a new decision that contradicts an old one *replaces* it in briefs instead of coexisting confusingly.
- File links mean `meetroom claim auth.py` can print: `"relevant memory: 'tokens are opaque, never JWTs' (mmm-x3f2)"` — memory reaches the agent at exactly the moment it matters.
- Migration: existing flat decisions import as unlinked `decision` nodes. Hand-editability stays sacred.

---

## 6. Cross-Project Memory Federation

**Why:** Conventions ("snake_case DB columns", "no default exports") are usually *yours*, not the project's. Re-teaching every repo is waste.

**Behavior:**
- `~/.meetroom/global-memory.json` holds nodes explicitly promoted: `meetroom memory promote <node-id>`.
- Briefs merge global + project memory, project wins on conflict (a repo's local convention beats your general one).
- **Opt-in promotion only.** Nothing auto-globalizes — one project's weird decision must never leak into another silently.

---

## 7. Adaptive Timeouts

**Why:** 10 minutes (V1 default) is wrong in both directions: too short for a gnarly migration file, too long for a README. The daemon has claim-duration history per file; use it.

**Behavior:**
- Effective timeout = clamp(p90 of historical active-claim durations for that file, min 5m, max 45m), falling back to the session default with no history.
- `meetroom claim <file> --timeout 30` still overrides everything — explicit beats learned.
- Log the learned value on claim (`"claimed auth.py (learned timeout: 22m)"`) so behavior is never mysterious.

---

## 8. Diff-Aware Briefs ("what changed since I left")

**Why:** The V2 brief is a full snapshot. An agent (or human) returning after an hour needs the *delta*, not the world.

**Behavior:**
- `meetroom brief --since <ts|last>` — events, decisions, board moves, and review outcomes since the timestamp (default: your agent's `lastSeenAt`).
- The V4 agent runner uses this automatically on restart: crashed agents re-enter with "here's what happened while you were down" instead of the full brief.
- Pure composition of existing data (events timeline + memory) — no new state, ship it early.

---

## Suggested V5 Build Priority

1. **Diff-aware briefs (#8)** — no new state, immediate value, V4 runner wants it
2. **Adaptive timeouts (#7)** — small, self-contained, data already exists
3. **Memory graph + recall (#5)** — the foundation the rest of the intelligence reads from
4. **Conflict prediction (#2)** — advisory, safe to ship rough and tune
5. **Review copilot (#3)** — high leverage, gated only on a configured model
6. **Learned routing (#4)** — needs #5's similarity machinery; do after
7. **Cross-project federation (#6)** — small, but wants #5 mature first
8. **Semantic claims (#1)** — biggest lift and the most correctness-sensitive; `lines:A-B` early, tree-sitter last
