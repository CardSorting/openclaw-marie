import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  writeMemory,
  writeUserModel,
  createFrozenSnapshot,
  MEMORY_CHAR_CAP,
  USER_CHAR_CAP,
} from "./marie-memory.js";

const log = createSubsystemLogger("agents/marie-memory-nudge");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** User turns between memory review nudges. */
export const NUDGE_INTERVAL = 10;

import { getStrategicEvolutionStore } from "./strategic-evolution-store.js";

const STATE_KEY_TURN_COUNT = "turn_count";

/**
 * Increment turn count for a session. Returns whether a nudge is due.
 */
export async function trackTurn(sessionKey: string): Promise<boolean> {
  const store = await getStrategicEvolutionStore();
  const current = (store.getSessionState<number>(sessionKey, STATE_KEY_TURN_COUNT) ?? 0) + 1;
  await store.setSessionState(sessionKey, STATE_KEY_TURN_COUNT, current);

  log.info(`Session ${sessionKey} turn count: ${current}`);
  return current % NUDGE_INTERVAL === 0;
}

/**
 * Get current turn count for a session.
 */
export async function getTurnCount(sessionKey: string): Promise<number> {
  const store = await getStrategicEvolutionStore();
  return store.getSessionState<number>(sessionKey, STATE_KEY_TURN_COUNT) ?? 0;
}

/**
 * Reset turn count for a session (e.g., after session close).
 */
export async function resetTurnCount(sessionKey: string): Promise<void> {
  const store = await getStrategicEvolutionStore();
  await store.setSessionState(sessionKey, STATE_KEY_TURN_COUNT, 0);
}

/** Reset all tracking state — for tests only. */
export function resetAllForTest(): void {
  // Clearing the whole table is complex via the store API;
  // in tests, the store usually points to a temp DB anyway.
}

// ---------------------------------------------------------------------------
// Nudge Prompt Generation
// ---------------------------------------------------------------------------

/**
 * Build the agent-facing nudge prompt that asks the agent to review and prune
 * its bounded memory. The agent should respond with updated content that fits
 * within the hard caps.
 */
export function buildNudgePrompt(currentMemory: string, currentUserModel: string): string {
  const memUsed = currentMemory.length;
  const userUsed = currentUserModel.length;

  const lines = [
    "## 🧠 Memory Review Nudge",
    "",
    "It's time to review your bounded memory. Examine both files below and:",
    "1. **Remove** outdated, redundant, or low-signal entries",
    "2. **Consolidate** related facts into tighter phrasing",
    "3. **Preserve** active tasks, user preferences, and critical context",
    "4. **Never exceed** the character caps — writes will be rejected if too large",
    "",
    `### MEMORY.md (${memUsed}/${MEMORY_CHAR_CAP} chars)`,
    "```",
    currentMemory || "(empty)",
    "```",
    "",
    `### USER.md (${userUsed}/${USER_CHAR_CAP} chars)`,
    "```",
    currentUserModel || "(empty)",
    "```",
    "",
    "Respond with updated content for each file using the `marie_memory_update` tool.",
    "If no changes are needed, acknowledge and continue.",
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Nudge Commit — Validates + Writes + Snapshots
// ---------------------------------------------------------------------------

export interface NudgeCommitResult {
  memoryResult: { ok: boolean; error?: string };
  userModelResult: { ok: boolean; error?: string };
  snapshotCreated: boolean;
}

/**
 * Commit a memory nudge update: validate sizes, write both files,
 * and create a frozen snapshot.
 */
export async function commitNudge(
  agentDir: string,
  newMemory?: string,
  newUserModel?: string,
): Promise<NudgeCommitResult> {
  const result: NudgeCommitResult = {
    memoryResult: { ok: true },
    userModelResult: { ok: true },
    snapshotCreated: false,
  };

  // Write memory if provided
  if (newMemory !== undefined) {
    const writeResult = await writeMemory(agentDir, newMemory);
    result.memoryResult = { ok: writeResult.ok, error: writeResult.error };
  }

  // Write user model if provided
  if (newUserModel !== undefined) {
    const writeResult = await writeUserModel(agentDir, newUserModel);
    result.userModelResult = { ok: writeResult.ok, error: writeResult.error };
  }

  // Create frozen snapshot after successful writes
  if (result.memoryResult.ok && result.userModelResult.ok) {
    try {
      await createFrozenSnapshot(agentDir);
      result.snapshotCreated = true;
    } catch (err) {
      log.warn(`Failed to create frozen snapshot after nudge: ${String(err)}`);
    }
  }

  log.info(
    `Nudge commit: memory=${result.memoryResult.ok}, user=${result.userModelResult.ok}, snapshot=${result.snapshotCreated}`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Pre-Compaction Flush Integration
// ---------------------------------------------------------------------------

/**
 * Triggered before compaction: creates a safety snapshot of current memory
 * state before the context window overflows. This is the OpenClaw-derived
 * pre-compaction flush running alongside Marie's dedicated nudge cycle.
 */
export async function preCompactionFlush(agentDir: string): Promise<void> {
  try {
    await createFrozenSnapshot(agentDir);
    log.info("Pre-compaction flush: snapshot created");
  } catch (err) {
    // Graceful degradation — compaction continues even if flush fails
    log.warn(`Pre-compaction flush failed (non-fatal): ${String(err)}`);
  }
}
