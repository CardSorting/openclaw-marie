import { createSubsystemLogger } from "../logging/subsystem.js";
import { markMutationStart } from "./evolutionary-pilot.js";
import {
  readMemory,
  readUserModel,
  writeMemory,
  writeUserModel,
  createFrozenSnapshot,
} from "./marie-memory.js";

const log = createSubsystemLogger("agents/marie-memory-flush");

import { CortexJanitor } from "./cortex-janitor.js";

/**
 * Strip artifacts from memory content before snapshot commit.
 * Uses CortexJanitor for advanced hygiene.
 */
export async function stripArtifacts(
  content: string,
  sessionKey?: string,
): Promise<{ stripped: string; count: number }> {
  const result = await CortexJanitor.runHygiene(content, sessionKey);
  return { stripped: result.cleaned, count: result.strippedCount };
}

export interface FlushResult {
  memoryFlushed: boolean;
  userModelFlushed: boolean;
  artifactsStripped: number;
  snapshotCreated: boolean;
  error?: string;
}

/**
 * Dedicated flush for memory persistence.
 */
export async function flushMemory(agentDir: string, sessionKey?: string): Promise<FlushResult> {
  const result: FlushResult = {
    memoryFlushed: false,
    userModelFlushed: false,
    artifactsStripped: 0,
    snapshotCreated: false,
  };

  try {
    // Read current state
    const [memory, userModel] = await Promise.all([readMemory(agentDir), readUserModel(agentDir)]);

    // Strip artifacts from memory (pass sessionKey for recall-based ablation)
    const memoryStrip = await stripArtifacts(memory, sessionKey);
    const userStrip = await stripArtifacts(userModel, sessionKey);
    result.artifactsStripped = memoryStrip.count + userStrip.count;

    // Write back stripped content (only if changes were made)
    if (memoryStrip.count > 0 || sessionKey) {
      // Always write if sessionKey is provided to allow ablation even if count is 0
      const writeResult = await writeMemory(agentDir, memoryStrip.stripped);
      result.memoryFlushed = writeResult.ok;
      if (!writeResult.ok) {
        result.error = writeResult.error;
        return result;
      }
    } else {
      result.memoryFlushed = true;
    }

    if (userStrip.count > 0 || sessionKey) {
      const writeResult = await writeUserModel(agentDir, userStrip.stripped);
      result.userModelFlushed = writeResult.ok;
      if (!writeResult.ok) {
        result.error = writeResult.error;
        return result;
      }
    } else {
      result.userModelFlushed = true;
    }

    // Create frozen snapshot after flush
    await createFrozenSnapshot(agentDir);
    result.snapshotCreated = true;

    log.info(
      `Memory flush complete: ${result.artifactsStripped} artifacts stripped, snapshot created`,
    );
    await markMutationStart(agentDir);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    log.warn(`Memory flush failed: ${result.error}`);
  }

  return result;
}
