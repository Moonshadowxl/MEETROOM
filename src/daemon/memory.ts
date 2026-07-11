import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MemoryNode, ProjectMemory, Session } from "../shared/types.js";
import { entityId, now } from "../shared/ids.js";

// V2 #6 — persistent project memory. Lives at .meetroom/memory.json inside
// the *project* directory so it travels with the repo, and is plain JSON so a
// human can curate it by hand.

function memoryPath(cwd: string): string {
  return join(cwd, ".meetroom", "memory.json");
}

export function loadMemory(cwd: string): ProjectMemory {
  const p = memoryPath(cwd);
  if (existsSync(p)) {
    try {
      const memory = JSON.parse(readFileSync(p, "utf8")) as ProjectMemory;
      migrateToGraph(memory);
      return memory;
    } catch {
      // fall through to fresh memory
    }
  }
  return { projectPath: cwd, decisions: [], conventions: [], nodes: [] };
}

/** V5 #5 — flat decisions auto-migrate to graph nodes (kept in both shapes). */
function migrateToGraph(memory: ProjectMemory): void {
  memory.nodes ??= [];
  for (const d of memory.decisions) {
    if (!memory.nodes.some((n) => n.summary === d.summary)) {
      memory.nodes.push({ id: entityId("mem"), kind: "decision", summary: d.summary, links: {}, sourceSessionId: d.sourceSessionId, date: d.date });
    }
  }
  for (const c of memory.conventions) {
    if (!memory.nodes.some((n) => n.summary === c)) {
      memory.nodes.push({ id: entityId("mem"), kind: "convention", summary: c, links: {}, sourceSessionId: "manual", date: now() });
    }
  }
}

export function saveMemory(cwd: string, memory: ProjectMemory): void {
  mkdirSync(join(cwd, ".meetroom"), { recursive: true });
  writeFileSync(memoryPath(cwd), JSON.stringify(memory, null, 2));
}

/**
 * Distill the session into durable decisions at session end. If a summarizer
 * command is configured (MEETROOM_SUMMARIZER — e.g. an LLM CLI that reads
 * stdin and prints a one-line summary), each item is piped through it;
 * otherwise the raw proposal/task text is stored as-is.
 */
export function distillSessionIntoMemory(session: Session): ProjectMemory {
  const memory = loadMemory(session.cwd);
  const date = now();
  const items: { text: string; taskId?: string; files?: string[] }[] = [];
  for (const p of session.proposals) {
    if (p.status === "resolved") items.push({ text: `Decision: ${p.content}` });
  }
  for (const t of session.tasks) {
    if (t.status === "done") items.push({ text: `Completed: ${t.title}`, taskId: t.id, files: t.files });
  }
  for (const item of items) {
    const summary = summarize(item.text);
    if (!memory.decisions.some((d) => d.summary === summary)) {
      memory.decisions.push({ summary, date, sourceSessionId: session.id });
      memory.nodes!.push({
        id: entityId("mem"),
        kind: "decision",
        summary,
        links: { files: item.files?.length ? item.files : undefined, taskIds: item.taskId ? [item.taskId] : undefined },
        sourceSessionId: session.id,
        date,
      });
    }
  }
  saveMemory(session.cwd, memory);
  return memory;
}

// ---- V5 #5 recall + V5 #6 global federation -------------------------------------

function globalMemoryPath(): string {
  return join(process.env.MEETROOM_HOME ?? join(homedir(), ".meetroom"), "global-memory.json");
}

export function loadGlobalMemory(): MemoryNode[] {
  if (!existsSync(globalMemoryPath())) return [];
  try {
    return JSON.parse(readFileSync(globalMemoryPath(), "utf8")) as MemoryNode[];
  } catch {
    return [];
  }
}

/** Explicitly promote a project memory node to the user-global store. */
export function promoteMemoryNode(cwd: string, nodeId: string): { ok: boolean; error?: string; node?: MemoryNode } {
  const memory = loadMemory(cwd);
  const node = memory.nodes?.find((n) => n.id === nodeId);
  if (!node) return { ok: false, error: `no memory node ${nodeId}` };
  const global = loadGlobalMemory();
  if (!global.some((n) => n.summary === node.summary)) {
    global.push({ ...node, links: {} }); // file/task links are project-specific
    mkdirSync(join(globalMemoryPath(), ".."), { recursive: true });
    writeFileSync(globalMemoryPath(), JSON.stringify(global, null, 2));
  }
  return { ok: true, node };
}

/** Active memory (superseded nodes filtered out), project + global merged. */
export function activeMemoryNodes(cwd: string): MemoryNode[] {
  const project = loadMemory(cwd).nodes ?? [];
  const global = loadGlobalMemory();
  const all = [...project, ...global.filter((g) => !project.some((p) => p.summary === g.summary))];
  const superseded = new Set(all.map((n) => n.links.supersedes).filter(Boolean));
  return all.filter((n) => !superseded.has(n.id));
}

/** V5 #5 — keyword recall over the memory graph (embedding-free fallback). */
export function recallMemory(cwd: string, query: string, limit = 8): { node: MemoryNode; score: number }[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return [];
  return activeMemoryNodes(cwd)
    .map((node) => {
      const hay = `${node.kind} ${node.summary} ${(node.links.files ?? []).join(" ")}`.toLowerCase();
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0) / terms.length;
      return { node, score };
    })
    .filter((r) => r.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** One path is the other, or a suffix of it at a path-segment boundary — so
 *  "a.ts" matches "src/a.ts" but not "data.ts". */
export function pathTailMatches(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long === short || long.endsWith(`/${short}`);
}

/** Memory that mentions a file — surfaced at claim time, when it matters most. */
export function memoryForFile(cwd: string, filepath: string): MemoryNode[] {
  return activeMemoryNodes(cwd)
    .filter((n) => n.links.files?.some((f) => pathTailMatches(f, filepath)))
    .slice(0, 5);
}

function summarize(text: string): string {
  const cmd = process.env.MEETROOM_SUMMARIZER;
  if (cmd) {
    try {
      return execFileSync("sh", ["-c", cmd], { input: text, encoding: "utf8", timeout: 30_000 }).trim() || text;
    } catch {
      return text; // summarizer failure must never lose the decision
    }
  }
  return text;
}
