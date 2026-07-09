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
