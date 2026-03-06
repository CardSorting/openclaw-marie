import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/skill-auto-create");

/** Iterations between autonomous skill creation nudges. */
export const AUTO_CREATE_INTERVAL = 15;

const sessionIterationCounts = new Map<string, number>();

/**
 * Track an iteration (e.g., a tool call or a message turn) for a session.
 * Returns whether an autonomous skill creation nudge is due.
 */
export function trackIteration(sessionKey: string): boolean {
  const current = (sessionIterationCounts.get(sessionKey) ?? 0) + 1;
  sessionIterationCounts.set(sessionKey, current);
  return current % AUTO_CREATE_INTERVAL === 0;
}

/**
 * Reset iteration count for a session.
 */
export function resetIterationCount(sessionKey: string): void {
  sessionIterationCounts.delete(sessionKey);
}

/**
 * Build the agent-facing prompt for autonomous skill creation.
 */
export function buildAutoCreatePrompt(recentPatterns: string[]): string {
  const lines = [
    "## 🛠️ Autonomous Skill Creation Nudge",
    "",
    "Examine your recent patterns and identify whether a reusable skill has emerged.",
    "A skill is a self-contained procedure (SKILL.md) that helps you or other agents",
    "perform recurring complex tasks consistently.",
    "",
    "### Recent Patterns Observed:",
    ...recentPatterns.map((p) => `- ${p}`),
    "",
    "If a new skill pattern exists, propose its structure using `skill_propose`.",
    "The skill will enter the quarantine pipeline before it is elevated to trust.",
  ];

  return lines.join("
");
}
