import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectMemory, Session } from "../shared/types.js";
import { now } from "../shared/ids.js";

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
      return JSON.parse(readFileSync(p, "utf8")) as ProjectMemory;
    } catch {
      // fall through to fresh memory
    }
  }
  return { projectPath: cwd, decisions: [], conventions: [] };
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
  const items: string[] = [];
  for (const p of session.proposals) {
    if (p.status === "resolved") items.push(`Decision: ${p.content}`);
  }
  for (const t of session.tasks) {
    if (t.status === "done") items.push(`Completed: ${t.title}`);
  }
  for (const raw of items) {
    const summary = summarize(raw);
    if (!memory.decisions.some((d) => d.summary === summary)) {
      memory.decisions.push({ summary, date, sourceSessionId: session.id });
    }
  }
  saveMemory(session.cwd, memory);
  return memory;
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
