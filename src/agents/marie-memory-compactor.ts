import { createSubsystemLogger } from "../logging/subsystem.js";
import { extractEntities } from "./evolutionary-pilot.js";
import { readMemoryState, MEMORY_CHAR_CAP, USER_CHAR_CAP } from "./marie-memory.js";
import { getStrategicEvolutionStore } from "./strategic-evolution-store.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";

const log = createSubsystemLogger("agents/marie-memory-compactor");

const COMPACTION_TRIGGER_THRESHOLD = 0.8; // 80% of cap

/**
 * Autonomous memory compactor for Marie.
 * Prunes MEMORY.md and USER.md when they approach hard caps.
 */
export async function runAutonomousCompaction(params: {
  agentDir?: string;
  sessionKey: string;
  force?: boolean;
}): Promise<void> {
  const { loadConfig } = await import("../config/config.js");
  const { resolveAgentWorkspaceDir } = await import("./agent-scope.js");
  const { parseAgentSessionKey } = await import("../routing/session-key.js");

  const cfg = loadConfig();
  const agentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  const agentDir = params.agentDir ?? (agentId ? resolveAgentWorkspaceDir(cfg, agentId) : null);

  if (!agentDir) {
    log.error(`Could not resolve agent directory for session ${params.sessionKey}`);
    return;
  }

  const { memory, userModel } = await readMemoryState(agentDir);

  const memUsed = memory.length;
  const userUsed = userModel.length;

  const memRatio = memUsed / MEMORY_CHAR_CAP;
  const userRatio = userUsed / USER_CHAR_CAP;

  if (
    !params.force &&
    memRatio < COMPACTION_TRIGGER_THRESHOLD &&
    userRatio < COMPACTION_TRIGGER_THRESHOLD
  ) {
    return;
  }

  const store = await getStrategicEvolutionStore();

  if (store.getSessionState<boolean>(params.sessionKey, "autonomy_blocked")) {
    log.warn(
      `[Nervous System] Autonomous Compaction blocked for ${params.sessionKey} due to high fragility circuit breaker.`,
    );
    return;
  }

  // Phase 3: Autonomous Governance
  const load = store.getSystemicLoad();
  if (!params.force && load.aggregate > 0.9) {
    log.warn(
      `Systemic Overload Detected (${(load.aggregate * 100).toFixed(1)}%). Deferring memory compaction for ${params.sessionKey}`,
    );
    return;
  }

  // Use Systemic Lock for Compaction
  const lockKey = `compact:${params.sessionKey}`;
  const lockAcquired = await store.acquireLock(lockKey, 3600_000); // 1 hour TTL
  if (!lockAcquired) {
    log.info(`Compaction already in progress or locked for ${params.sessionKey}`);
    return;
  }

  log.info(
    `Triggering autonomous compaction for ${params.sessionKey} (Mem: ${memRatio.toFixed(2)}, User: ${userRatio.toFixed(2)})`,
  );

  const task = `Autonomous Memory Compaction Required.
The current context window is nearing capacity. Prune and consolidate the following memory files to restore space while preserving critical facts and user preferences.

### MEMORY.md (${memUsed}/${MEMORY_CHAR_CAP} chars)
\`\`\`
${memory}
\`\`\`

### USER.md (${userUsed}/${USER_CHAR_CAP} chars)
\`\`\`
${userModel}
\`\`\`

Respond by using the marie_memory_update tool with the pruned content. Focus on high-signal information and remove redundancies.`;

  const preUsage = memUsed + userUsed;
  await store.setSessionState(params.sessionKey, "compaction_pre_usage", preUsage);

  // Semantic Loss Detection: Capture Entity Snapshot
  const entities = extractEntities(`${memory}\n${userModel}`);
  await store.setSessionState(params.sessionKey, "compaction_pre_entities", entities);

  try {
    const result = await spawnSubagentDirect(
      {
        task,
        label: "Autonomous Memory Compaction",
      },
      {
        agentSessionKey: params.sessionKey,
      },
    );

    if (result.childSessionKey) {
      await store.setSessionState(result.childSessionKey, "is_compaction", true);
      await store.setSessionState(
        result.childSessionKey,
        "compaction_source_session",
        params.sessionKey,
      );
    }
  } catch (err) {
    // Release lock on spawn failure
    await store.releaseLock(lockKey);
    throw err;
  }
}
