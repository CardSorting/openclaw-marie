// Unused import removed to fix lint

// Unused logger removed to fix lint
// const log = createSubsystemLogger("agents/skill-auto-create");

/** Iterations between autonomous skill creation nudges. */
export const AUTO_CREATE_INTERVAL = 15;

/**
 * Generates the standard system nudge for architectural skill creation.
 */
export function getAutomatedSkillNudge(): string {
  const lines = [
    "--- JOY-ZONING SOVEREIGNTY NUDGE ---",
    "It has been 15 cycles since your last skill creation.",
    "The Joy-Zoning architecture rewards high-cohesion skill extraction.",
    "Consider extracting current task logic into a new skill if:",
    "  1. The logic is likely reusable for future intents.",
    "  2. Current script complexity is increasing.",
    "  3. You are entering a new domain of execution.",
    "",
    "To create a skill, use the 'create_skill' tool.",
    "The skill will enter the quarantine pipeline before it is elevated to trust.",
  ];

  return lines.join("\n");
}
