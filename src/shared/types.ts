// Core data model for Meetroom V1–V3.

export type AgentStatus = "waiting" | "active" | "idle" | "disconnected";

export type Agent = {
  id: string;
  name: string;
  age?: string;
  personality?: string;
  vibe?: string;
  role: string; // prebuilt or freehand
  status: AgentStatus;
  joinedAt: string;
  lastSeenAt: string;
  // V3 #4 — cost/capability-aware routing
  costTier?: "low" | "medium" | "high";
  strengths?: string[];
  // Stable identity across sessions (defaults to name); used for reputation.
  identity: string;
};

export type FileClaim = {
  filepath: string;
  agentId: string;
  status: "claimed" | "editing" | "done";
  claimedAt: string;
  lastActivityAt: string; // for timeout auto-release
};

// V2 #2 — dependency-aware claiming
export type ClaimWaitlist = {
  filepath: string;
  waitingAgentIds: string[]; // FIFO queue
};

export type Proposal = {
  id: string;
  authorId: string;
  content: string;
  objections: { agentId: string; reason: string; ts: string }[];
  authorResponse?: string; // the one allowed back-and-forth round
  status: "open" | "contested" | "voting" | "resolved" | "rejected" | "escalated";
  // V2 #9 — voting
  votes?: { agentId: string; vote: "yes" | "no" }[];
  createdAt: string;
  resolvedAt?: string;
};

export type TaskStatus = "todo" | "in-progress" | "review" | "done" | "blocked";

// V2 #1 — task board
export type Task = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignedAgentId?: string;
  files: string[]; // files this task owns
  dependsOn?: string[]; // other task ids that must be "done" first
  createdAt: string;
  updatedAt: string;
  // V3 #3 / #7 — gates
  requiresCI?: boolean;
  requiresTests?: boolean;
  testResult?: "passed" | "failed";
  // V3 #4 — routing
  estimatedComplexity?: "trivial" | "moderate" | "complex";
  suggestedAgentId?: string;
  // V5 #2 — conflict prediction (advisory)
  conflictWarnings?: string[];
  // V8 #7 — outcome verification (goal tests)
  verify?: { command: string; timeoutSeconds?: number };
  verifyResult?: { passed: boolean; output: string; at: string };
  // V8 #8 — epic membership
  epicId?: string;
  // V4 #4 — reassignment history
  reassignedFrom?: string[];
  // Timeline bookkeeping
  claimedAt?: string;
  doneAt?: string;
};

// V2 #3 — diff-based review gate
export type Review = {
  id: string;
  taskId: string;
  authorAgentId: string;
  reviewerAgentId?: string;
  diff: string; // unified diff or git patch
  status: "pending" | "approved" | "changes-requested";
  comments: { agentId: string; line?: number; text: string; ts: string }[];
  // V3 #6 — confidence scoring
  authorConfidence?: "low" | "medium" | "high";
  // V3 #2 — PR integration
  prUrl?: string;
  // V5 #3 — review copilot first pass
  copilotFindings?: { severity: "info" | "warn" | "blocker"; line?: number; text: string }[];
  copilotVerdict?: "looks-clean" | "needs-attention";
  createdAt: string;
  updatedAt: string;
};

// V3 #3 — CI/CD hook
export type CIStatus = {
  taskId: string;
  provider: "github-actions" | "gitlab-ci" | "generic-webhook";
  status: "pending" | "passed" | "failed";
  url?: string;
  updatedAt: string;
};

// V3 #1 — plugins
export type Plugin = {
  id: string;
  name: string; // e.g. "eslint-runner"
  command: string; // shell command template the CLI invokes locally
  installedBy: string; // agentId
  scope: "session" | "project"; // project = persists via .meetroom/plugins.json
  // V7 #2 — permissions manifest (dangerous permissions need confirmation)
  manifest?: {
    permissions: ("read-fs" | "write-fs" | "network" | "secrets")[];
    description?: string;
  };
};

export type ChatMessage = {
  agentId: string; // "human" for operator messages, "system" for daemon notices
  message: string;
  ts: string;
  // V2 #8 — selective broadcast; when set, message is private to this agent.
  to?: string;
};

export type SessionEvent = {
  ts: string;
  type: string; // e.g. "claim", "release", "task-move", "review-approved", "escalation"
  agentId?: string;
  data?: Record<string, unknown>;
  hash?: string; // V6 #4 — sha256(prevHash + canonical(event)): tamper-evident chain
};

// V2 #10 — cost/token tracking per agent
export type AgentUsage = {
  agentId: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

export type NotifyConfig = {
  // V2 #4 webhook + V3 #11 adapters
  webhooks: { url: string; kind: "generic" | "slack" | "discord" }[];
  events: string[]; // which event types trigger a POST
};

// V3 #13 — natural-language task decomposition draft (requires explicit approval)
export type DraftPlan = {
  id: string;
  description: string;
  tasks: { title: string; description: string; files: string[]; dependsOnIndex?: number[] }[];
  status: "draft" | "approved" | "discarded";
  createdAt: string;
};

export type SessionConfig = {
  claimTimeoutMinutes: number; // default 10
  objectionTimeoutMinutes: number; // auto-resolve window, default 5
  requirePrMergeForDone: boolean; // V3 #2, default false ("approved" is enough)
  leadAgentId?: string; // V2 #9 — optional tie-breaking lead
  // V4 #4 — liveness thresholds
  stallMinutes: number; // no CLI call for this long → idle (2× → disconnected)
  // V4 #7 — escalation policy
  escalation?: {
    humanResponseTimeoutMinutes?: number; // unanswered escalation → attention/pause
    pauseRoomOnUnanswered?: boolean;
  };
  // V8 #1 — autonomy ladder (0 observe … 4 delegated)
  autonomy?: { level: 0 | 1 | 2 | 3 | 4; vetoWindowMinutes: number };
  // V8 #5 — opt-in fleet stats collection
  fleetLearning?: boolean;
};

// ---- V4: operations & autonomy -------------------------------------------

export type AgentRunner = {
  agentName: string;
  command: string;
  cwd: string;
  restartPolicy: "never" | "on-crash" | "always";
  maxRestarts: number;
  restarts: number;
  pid?: number;
  state: "running" | "stopped" | "crashed" | "restarting";
  startedAt?: string;
};

export type Budget = {
  scope: "session" | "agent";
  agentId?: string;
  maxCostUsd?: number;
  maxTokens?: number;
  onBreach: "pause-agent" | "pause-room" | "notify-only";
  breachedAt?: string;
};

export type AttentionItem = {
  id: string;
  sessionId: string;
  kind: "escalation" | "low-confidence-review" | "budget-breach" | "stalled-room" | "routine-failed" | "deadlock" | "regression" | "meta-agent-action";
  summary: string;
  createdAt: string;
  status: "open" | "acked" | "done" | "snoozed";
  snoozeUntil?: string;
};

export type Artifact = {
  id: string;
  name: string;
  content: string;
  version: number; // optimistic concurrency
  updatedBy: string;
  updatedAt: string;
};

export type Routine = {
  id: string;
  name: string;
  cron: string; // 5-field cron expression
  cwd: string;
  template?: string;
  guild?: string;
  lastFiredAt?: string;
  enabled: boolean;
};

// V4 #8 — session blueprint (stored as JSON in .meetroom/templates/ or ~/.meetroom/templates/)
export type SessionTemplate = {
  name: string;
  type?: SessionType;
  config?: Partial<SessionConfig>;
  roster?: { name: string; role: string; costTier?: "low" | "medium" | "high"; strengths?: string[] }[];
  budgets?: Budget[];
  notify?: NotifyConfig;
  planDescription?: string; // auto-drafts a board (still approval-gated)
  runners?: { agentName: string; command: string; restartPolicy?: AgentRunner["restartPolicy"] }[];
};

export type Session = {
  id: string; // format: mmm-xxxx / sxx-xxxx / sxl-xxxx
  createdAt: string;
  cwd: string; // the project directory the session is tracking
  status: "active" | "paused" | "ended"; // V2 #7 pause/resume
  agents: Agent[];
  claims: FileClaim[];
  waitlists: ClaimWaitlist[];
  proposals: Proposal[];
  tasks: Task[];
  reviews: Review[];
  ciStatuses: CIStatus[];
  plugins: Plugin[];
  chatLog: ChatMessage[];
  events: SessionEvent[];
  usage: AgentUsage[];
  draftPlans: DraftPlan[];
  notify: NotifyConfig;
  config: SessionConfig;
  // V2 #4 — remote sessions
  remote: boolean;
  token?: string;
  // V3 #8/#9 — forking & rollback
  forkedFrom?: string;
  baseCommit?: string; // HEAD of cwd when the session started, for rollback
  guild?: string;
  // V4 — operations & autonomy
  runners: AgentRunner[];
  budgets: Budget[];
  artifacts: Artifact[];
  // V5 #1 — line-range claims
  semanticClaims: SemanticClaim[];
  // V7 #3 — inbound integration secrets (HMAC), keyed by source name
  integrations: { source: string; secret: string }[];
};

// ---- V5: intelligence layer ------------------------------------------------

export type SemanticClaim = {
  filepath: string;
  startLine: number;
  endLine: number;
  agentId: string;
  claimedAt: string;
  lastActivityAt: string;
};

// V5 #5 — memory graph node (supersedes V2's flat decision list)
export type MemoryNode = {
  id: string;
  kind: "decision" | "convention" | "gotcha" | "architecture";
  summary: string;
  links: { files?: string[]; taskIds?: string[]; supersedes?: string };
  sourceSessionId: string;
  date: string;
};

// ---- V6: teams & trust -------------------------------------------------------

export type Operator = {
  id: string;
  name: string;
  role: "owner" | "maintainer" | "reviewer" | "observer";
  keyHash: string; // sha256 of the api key; the key itself is shown once
  createdAt: string;
};

// V6 #3 — policy rule (.meetroom/policy.json, committed with the repo)
export type PolicyRule = {
  id: string;
  match: { paths?: string[]; taskComplexity?: string[] };
  require: ("human-review" | "two-reviewers" | "ci-pass" | "tests-pass")[];
};

// ---- V8: self-improving org ---------------------------------------------------

export type Epic = {
  id: string;
  title: string;
  northStar: string;
  taskRefs: { sessionId: string; taskId: string }[];
  status: "active" | "done" | "abandoned";
  createdAt: string;
};

// V2 #6 — persistent project memory (.meetroom/memory.json, keyed by cwd)
export type ProjectMemory = {
  projectPath: string;
  decisions: { summary: string; date: string; sourceSessionId: string }[];
  conventions: string[];
};

// V3 #5 — agent reputation (persisted across sessions, keyed by identity)
export type AgentReputation = {
  agentIdentity: string;
  tasksCompleted: number;
  reviewPassRate: number; // % approved without changes-requested
  avgReworkCount: number; // avg changes-requested cycles before approval
  avgTurnaroundMinutes: number;
};

// V3 #10 — guilds / persistent teams
export type Guild = {
  id: string;
  name: string;
  members: { agentIdentity: string; defaultRole: string; costTier?: "low" | "medium" | "high"; strengths?: string[] }[];
};

export type SessionType = "mmm" | "sxx" | "sxl";
