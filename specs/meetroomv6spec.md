# Meetroom — V6 Feature Spec: Teams & Trust

Builds on V4 (autonomy) and V5 (intelligence). V6's theme: **more than one human**. Everything so far assumes a single operator who owns the machine, the repo, and the budget. V6 makes meetroom safe for a team — and for codebases where "an agent merged something bad" is an incident, not an anecdote.

This is the version where security stops being optional. Several items here (TLS, real auth) should be treated as prerequisites for using V2's `--remote` mode anywhere that matters.

---

## 1. Multi-Operator Support (humans as first-class citizens)

**Why:** Today there is exactly one `"human"` agent id. Two teammates watching the same room are indistinguishable — in chat, in approvals, in the audit trail.

**Data model addition:**
```ts
type Operator = {
  id: string;
  name: string;
  email?: string;
  role: "owner" | "maintainer" | "reviewer" | "observer";
  apiKey: string;             // hashed at rest
};
```

**Behavior:**
- `meetroom operator invite <name> --role reviewer` → prints a join key; teammate runs `meetroom login --key ...`.
- Chat/approvals/resolves attribute to the actual operator (`"escalation resolved by dana"`).
- Role gates: **observer** reads; **reviewer** reviews + votes; **maintainer** everything except budget/policy/operator changes; **owner** everything.
- The magic string `"human"` remains as an alias for the sole operator in single-user rooms — zero friction is preserved for the solo case.

---

## 2. Transport Security (TLS + real tokens)

**Why:** V2 remote mode is plaintext HTTP with a bearer token. Fine on a home LAN, unacceptable anywhere else.

**Behavior:**
- `meetroom start --remote --tls` — auto-generates a self-signed cert (printed fingerprint; clients pin it) or takes `--cert/--key` for real certs.
- Per-operator API keys (#1) replace the single shared session token; agents get scoped keys that can claim/say/review but never change policy or budgets.
- Keys are revocable live: `meetroom operator revoke <name>` cuts access mid-session without restarting the room.
- Plain HTTP stays the default for localhost — the solo laptop workflow doesn't pay the ceremony tax.

---

## 3. Policy Engine (rules as code)

**Why:** V1–V5 gates (review, CI, tests) are per-task flags. Teams need *invariants*: "nothing under `src/payments/` merges without a human," regardless of who created the task or forgot which flag.

**Data model addition (`.meetroom/policy.json`, committed to the repo):**
```ts
type PolicyRule = {
  id: string;
  match: { paths?: string[]; taskComplexity?: string[]; agentTierAtMost?: string };
  require: ("human-review" | "two-reviewers" | "ci-pass" | "tests-pass" | "owner-approval")[];
  deny?: ("self-merge" | "force-done" | "low-tier-agents")[];
};
```

**Behavior:**
- Evaluated daemon-side on every `task move` and `review decide` — CLI flags can *add* gates but never remove what policy demands.
- Policy lives in the repo → reviewed like code, versioned like code, applies to every session in that project automatically.
- `meetroom policy check <task-id>` explains exactly which rules bind a task and what's still unsatisfied — no mystery rejections.

---

## 4. Tamper-Evident Audit Log

**Why:** The events timeline (V2 #10) is editable JSON on disk. For compliance-shaped questions — *who approved this, when, and was the record altered?* — that's not evidence.

**Behavior:**
- Each event gains `hash = sha256(prevHash + canonical(event))` — a hash chain. `meetroom audit verify` walks it and reports the first broken link.
- `meetroom audit export --from <date>` produces a signed bundle (events + verification) for handoff to whoever asks.
- Approvals/policy changes/budget changes record the operator key fingerprint that made them.
- Not blockchain. One file, one chain, verifiable offline. That's all anyone actually needs.

---

## 5. Secrets Management

**Why:** V3 plugins and PR/CI integrations need tokens. Today they end up in env vars and — worse — occasionally in chat logs and exports.

**Behavior:**
- `meetroom secret set GITHUB_TOKEN` (prompted, never argv) → stored encrypted at rest (OS keychain where available, age-encrypted file otherwise).
- Plugins/PR commands reference `{secret:GITHUB_TOKEN}` in templates; the daemon injects at exec time — the value never enters session state.
- **Redaction sweep:** chat messages, artifacts, and exports are scanned for known secret values and replaced with `[redacted:NAME]` before persistence. Agents paste tokens by accident; the daemon should be the last line of defense.

---

## 6. Hosted Relay & Daemon Federation

**Why:** V2 `--remote` requires a reachable daemon (port forwarding, static IP). The V2 spec's "optional relay server" is now worth building properly.

**Behavior:**
- `meetroom relay serve` — a thin, self-hostable rendezvous: daemons connect *outbound* (WSS), rooms get stable addresses (`relay.example.com/r/sxl-x3f2`), NAT traversal for free.
- The relay sees only encrypted frames between daemon and clients (E2E via the session keys from #2) — a compromised relay can drop traffic, not read it.
- `meetroom join --relay relay.example.com --sxl <id>` — everything else unchanged; the transport swap is invisible above the client layer, exactly like V2 promised.

---

## 7. Org Dashboard & Cost Centers

**Why:** V4's attention queue answers "what needs me now." Teams also need the slow questions: what did agent-fleet cost this month, per project? Whose reviews bounce most? Which rooms stall?

**Behavior:**
- `meetroom org report --month 2026-07` aggregates across all sessions/projects the daemon (or relay) has seen: cost per project, reputation league table, escalation rates, review turnaround percentiles.
- Sessions tag a cost center at start (`--cost-center platform-team`); budgets (V4 #2) can be set per cost center, not just per room.
- Web viewer grows an org page (operator-gated, observer-visible) rendering the same report live.

---

## 8. Data Retention & Privacy Controls

**Why:** Chat logs contain code, and code is IP. Sessions accumulate forever by default, on whatever disk the daemon runs on.

**Behavior:**
- Retention policy in config: `{ sessions: "90d", chatLogs: "30d", exports: "keep" }` — the daemon prunes on schedule, logging (to the audit chain) *that* it pruned, never *what*.
- `meetroom session purge <id> --keep-report` — distill memory + export the report, then delete raw chat/diff payloads. The "what we decided" outlives the "everything everyone said."
- Diff payloads in reviews (potentially the whole codebase over time) are the biggest liability — purge trims them first.

---

## Suggested V6 Build Priority

1. **Transport security (#2)** — prerequisite for taking remote mode seriously; do first, everything else assumes it
2. **Multi-operator (#1)** — the identity layer that policy, audit, and org features all reference
3. **Policy engine (#3)** — highest team-safety leverage per line of code
4. **Secrets management (#5)** — small, and every integration keeps tripping over its absence
5. **Audit log (#4)** — cheap once operator identity exists; retrofitting hashes later is painful, so don't wait too long
6. **Retention controls (#8)** — small, boring, someone will ask for it the first week a team adopts this
7. **Org dashboard (#7)** — aggregation over data that #1–#6 make trustworthy
8. **Hosted relay (#6)** — biggest lift, and only matters once multiple orgs/machines are real; last, same as networking was in V2
