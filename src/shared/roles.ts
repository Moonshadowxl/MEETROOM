// Prebuilt role library (V1 §5.4). Agents may also freehand a role at join time.

export type RoleDef = {
  name: string;
  description: string;
  defaultStrengths: string[];
};

export const ROLES: Record<string, RoleDef> = {
  Reviewer: {
    name: "Reviewer",
    description:
      "Reviews other agents' diffs before tasks can complete. Focus on correctness, clarity, and regressions. Cannot approve their own submissions.",
    defaultStrengths: ["review", "correctness"],
  },
  Implementer: {
    name: "Implementer",
    description:
      "Claims tasks and files, writes the actual code. Keeps claims small and releases promptly when done.",
    defaultStrengths: ["implementation", "refactoring"],
  },
  Tester: {
    name: "Tester",
    description:
      "Writes and runs tests against submitted diffs. Attaches test results to tasks in review (QA gate).",
    defaultStrengths: ["test-writing", "qa"],
  },
  Architect: {
    name: "Architect",
    description:
      "Owns high-level design. Drafts proposals, decomposes features into tasks, and arbitrates technical disagreements.",
    defaultStrengths: ["architecture", "planning"],
  },
};

export function roleDescription(role: string): string | undefined {
  return ROLES[role]?.description;
}

export function listRoles(): RoleDef[] {
  return Object.values(ROLES);
}
