import { promises as fs } from "node:fs";
import {
  onDiagnosticEvent,
  type DiagnosticEventPayload,
  emitDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type JoyZoningLayer } from "../security/TspPolicyPlugin.js";
import { fluidPolicyEngine } from "./FluidPolicyEngine.js";
import { rollbackToLastSnapshot, readMemoryState } from "./marie-memory.js";
import {
  getStrategicEvolutionStore,
  type StrategicEvolutionStore,
} from "./strategic-evolution-store.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";

// ── Systemic Health Registry (breaks circular dependency with JoyZoning) ──
let _healthProvider: (() => Promise<number>) | null = null;

export function registerHealthProvider(provider: () => Promise<number>) {
  _healthProvider = provider;
}

export async function getSystemicHealthScore(): Promise<number> {
  if (_healthProvider) {
    return await _healthProvider();
  }
  return 0.8; // Default baseline if not registered
}

const log = createSubsystemLogger("agents/evolutionary-pilot");

const VERIFICATION_WINDOW = 20;
const ROLLBACK_THRESHOLD_Z = 2.5;

interface SessionPerformance {
  latencies: number[];
  successes: number[];
  mutationActive: boolean;
  interactionCount: number;
}

/**
 * Initialize the EvolutionaryPilot by subscribing to diagnostic events.
 */
export async function initEvolutionaryPilot() {
  const store = await getStrategicEvolutionStore();

  // Autonomous Maintenance Cycle
  void store.maintenance().catch((err: unknown) => log.error(`Maintenance failed: ${String(err)}`));

  onDiagnosticEvent(async (event: DiagnosticEventPayload) => {
    if (event.type === "model.usage" && event.sessionKey) {
      void handleUsageEvent(event.sessionKey, event.durationMs ?? 0).catch(() => {});
    } else if (event.type === "message.processed" && event.sessionKey) {
      void handleOutcomeEvent(event.sessionKey, event.outcome === "completed" ? 1 : 0).catch(
        () => {},
      );
    } else if (event.type === "strategic.metric" && event.sessionKey) {
      void handleStrategicMetric(event.sessionKey, event.metricType, event.value).catch(() => {});
      if (event.metricType === "semantic_fragility") {
        void handleFragilityEvent(event.sessionKey, event.value).catch(() => {});
      }
    } else if (event.type === "agent.remediation" && event.sessionKey) {
      void handleRemediationEvent(event.sessionKey, event.success).catch(() => {});
    } else if (event.type === "agent.compaction" && event.sessionKey) {
      void handleCompactionEvent(event.sessionKey, event.efficiency).catch(() => {});
    } else if (event.type === "jz.violation" && event.sessionKey) {
      void handleEntropyEvent(event.sessionKey, event.filePath, event.level).catch(() => {});
    }
  });

  registerHealthProvider(computeSystemicHealth);

  log.info("EvolutionaryPilot initialized and listening for performance metrics.");
}

/**
 * Calculates a global health score (0-1) based on systemic success rates, latencies, and architectural entropy.
 */
async function computeSystemicHealth(): Promise<number> {
  const store = await getStrategicEvolutionStore();
  const successStats = store.getStats({ type: "success_rate" });
  const entropyStats = store.getStats({ type: "architectural_entropy" });

  let score = 0.8; // Default baseline

  if (successStats.count > 0) {
    score = successStats.mean;
  }

  // Penalize health based on architectural entropy (violations)
  if (entropyStats.count > 0) {
    // Entropy mean near 1.0 means lots of blocks. Near 0.2 means warnings.
    // We want health to drop as entropy mean or count increases.
    const entropyPenalty = Math.min(0.4, entropyStats.mean * (entropyStats.count / 10));
    score -= entropyPenalty;
  }

  return Math.max(0.1, score);
}

/**
 * Mark a mutation as active for a session (e.g. after memory flush).
 */
export async function markMutationStart(sessionKey: string) {
  const perf = await getOrCreatePerf(sessionKey);
  perf.mutationActive = true;
  perf.interactionCount = 0;
  await savePerf(sessionKey, perf);
  log.info(`Mutation verification window started for session: ${sessionKey}`);
}

const STATE_KEY_PERF = "evolutionary_perf";

async function getOrCreatePerf(sessionKey: string): Promise<SessionPerformance> {
  const store = await getStrategicEvolutionStore();
  const existing = store.getSessionState<SessionPerformance>(sessionKey, STATE_KEY_PERF);
  if (existing) {
    return existing;
  }
  const perf: SessionPerformance = {
    latencies: [],
    successes: [],
    mutationActive: false,
    interactionCount: 0,
  };
  await store.setSessionState(sessionKey, STATE_KEY_PERF, perf);
  return perf;
}

async function savePerf(sessionKey: string, perf: SessionPerformance) {
  const store = await getStrategicEvolutionStore();
  await store.setSessionState(sessionKey, STATE_KEY_PERF, perf);
}

async function handleUsageEvent(sessionKey: string, durationMs: number) {
  const perf = await getOrCreatePerf(sessionKey);
  perf.latencies.push(durationMs);
  if (perf.latencies.length > 100) {
    perf.latencies.shift();
  }

  if (perf.mutationActive) {
    await checkPerformance(sessionKey);
  }
  await savePerf(sessionKey, perf);
}

async function handleOutcomeEvent(sessionKey: string, success: number) {
  const store = await getStrategicEvolutionStore();

  // 1. Check if this was a compaction subagent
  const isCompaction = store.getSessionState<boolean>(sessionKey, "is_compaction");
  if (isCompaction) {
    await handleCompactionCompletion(sessionKey, store);
  }

  // 2. Check if this was a remediation subagent
  const isRemediation = store.getSessionState<boolean>(sessionKey, "is_remediation");
  if (isRemediation) {
    await handleRemediationCompletion(sessionKey, store);
  }

  const perf = await getOrCreatePerf(sessionKey);
  perf.successes.push(success);
  if (perf.successes.length > 100) {
    perf.successes.shift();
  }

  if (perf.mutationActive) {
    perf.interactionCount++;
    if (perf.interactionCount >= VERIFICATION_WINDOW) {
      await finalizeMutation(sessionKey);
    } else {
      await checkPerformance(sessionKey);
      await savePerf(sessionKey, perf);
    }
  } else {
    await savePerf(sessionKey, perf);
  }
}

async function handleStrategicMetric(sessionKey: string, type: string, value: number) {
  const perf = await getOrCreatePerf(sessionKey);
  if (type === "sentiment" && value < -0.5) {
    // High frustration detected
    log.warn(`Strategic Alert: High frustration detected for session ${sessionKey}.`);
    if (perf.mutationActive) {
      log.warn(`Automatic Rollback: Extreme frustration during mutation window. Rolling back.`);
      await triggerRollback(sessionKey);
    } else {
      await savePerf(sessionKey, perf);
    }
  } else if (type === "semantic_fragility" && value > 0.4) {
    log.warn(`Cognitive Drift Alert: High semantic fragility (${value.toFixed(2)}) detected.`);
    // Fragility handled by handleFragilityEvent
  }
}

async function handleFragilityEvent(sessionKey: string, fragility: number) {
  const store = await getStrategicEvolutionStore();
  await store.recordMetric({
    sessionKey,
    type: "semantic_fragility",
    value: fragility,
  });

  const trend = store.getRecentFragilityTrend(sessionKey);

  // Autonomy Circuit Breaker: If fragility is high and regressing, block autonomous repairs.
  if (fragility > 0.6 && trend === "regressing") {
    log.error(
      `[Nervous System] CRITICAL: Semantic Fragility is high (${fragility.toFixed(2)}) and REGRESSING. Triggering Autonomy Circuit Breaker.`,
    );
    await store.setSessionState(sessionKey, "autonomy_blocked", true);
    return;
  }

  if (fragility > 0.35) {
    log.warn(
      `[Nervous System] High Semantic Fragility (${fragility.toFixed(2)}) detected. Escalating to STICT-mode memory repair.`,
    );
    // triggerAutonomousMemoryRepair will check if autonomy is blocked
  }
}

function calculateStats(data: number[]) {
  if (data.length === 0) {
    return { mean: 0, stdDev: 0 };
  }
  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  const stdDev = Math.sqrt(
    data.map((x) => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / data.length,
  );
  return { mean, stdDev };
}

async function checkPerformance(sessionKey: string) {
  const perf = await getOrCreatePerf(sessionKey);
  if (!perf || perf.latencies.length < 5) {
    return;
  }

  const historicalLatencies = perf.latencies.slice(0, -1);
  const currentLatency = perf.latencies[perf.latencies.length - 1];

  const { mean, stdDev } = calculateStats(historicalLatencies);
  if (stdDev > 0) {
    const zScore = (currentLatency - mean) / stdDev;
    if (zScore > ROLLBACK_THRESHOLD_Z) {
      log.warn(
        `Performance regression detected (Latency Z=${zScore.toFixed(2)}). Triggering rollback.`,
      );
      await triggerRollback(sessionKey);
    }
  }
}

async function finalizeMutation(sessionKey: string) {
  const perf = await getOrCreatePerf(sessionKey);
  if (perf) {
    perf.mutationActive = false;
    await savePerf(sessionKey, perf);
    log.info(`Mutation verified and finalized for session: ${sessionKey}`);
  }
}

async function triggerRollback(sessionKey: string) {
  const perf = await getOrCreatePerf(sessionKey);
  if (perf) {
    perf.mutationActive = false;
    await savePerf(sessionKey, perf);

    const { loadConfig } = await import("../config/config.js");
    const { resolveAgentWorkspaceDir } = await import("./agent-scope.js");
    const { parseAgentSessionKey } = await import("../routing/session-key.js");

    const cfg = loadConfig();
    const agentId = parseAgentSessionKey(sessionKey)?.agentId;

    if (agentId) {
      const agentDir = resolveAgentWorkspaceDir(cfg, agentId);
      log.warn(
        `Autonomous Rollback: Session ${sessionKey} requires memory rollback for ${agentDir}.`,
      );
      await rollbackToLastSnapshot(agentDir);
    } else {
      log.error(`ROLLBACK REQ: Could not resolve agentId from sessionKey ${sessionKey}`);
    }
  }
}

async function handleRemediationEvent(sessionKey: string, success: boolean) {
  const store = await getStrategicEvolutionStore();
  await store.recordMetric({
    sessionKey,
    type: "success_rate", // Using existing type for remediation success
    value: success ? 1 : 0,
    metadata: { activity: "remediation" },
  });
  log.info(`Remediation event recorded for ${sessionKey}: success=${success}`);
}

async function handleCompactionEvent(sessionKey: string, efficiency: number) {
  const store = await getStrategicEvolutionStore();
  await store.recordMetric({
    sessionKey,
    type: "discovery", // Repurposing discovery for novelty/compaction score
    value: efficiency,
    metadata: { activity: "compaction" },
  });
  log.info(`Compaction event recorded for ${sessionKey}: efficiency=${efficiency}`);
}

async function handleCompactionCompletion(sessionKey: string, store: StrategicEvolutionStore) {
  const sourceSession = store.getSessionState<string>(sessionKey, "compaction_source_session");
  if (!sourceSession) {
    return;
  }

  // Release Compaction Lock
  await store.releaseLock(`compact:${sourceSession}`);

  const preUsage = store.getSessionState<number>(sourceSession, "compaction_pre_usage");

  if (!preUsage) {
    return;
  }

  const { loadConfig } = await import("../config/config.js");
  const { resolveAgentWorkspaceDir } = await import("./agent-scope.js");
  const { parseAgentSessionKey } = await import("../routing/session-key.js");

  const cfg = loadConfig();
  const agentId = parseAgentSessionKey(sourceSession)?.agentId;
  if (!agentId) {
    return;
  }

  const agentDir = resolveAgentWorkspaceDir(cfg, agentId);
  const finalState = await readMemoryState(agentDir);
  const finalUsed = finalState.memory.length + finalState.userModel.length;

  const efficiency = Math.max(0, 1 - finalUsed / preUsage);

  // Semantic Integrity Audit
  const preEntities =
    store.getSessionState<string[]>(sourceSession, "compaction_pre_entities") ?? [];
  const postEntities = extractEntities(`${finalState.memory}\n${finalState.userModel}`);
  const lostEntities = preEntities.filter((e) => !postEntities.includes(e));
  const lossRatio = preEntities.length > 0 ? lostEntities.length / preEntities.length : 0;

  if (lossRatio > 0.3) {
    log.warn(
      `Extreme Semantic Loss detected (${(lossRatio * 100).toFixed(1)}%). Triggering Autonomous Repair.`,
    );
    await triggerAutonomousMemoryRepair(sourceSession, lostEntities);
  }

  void handleCompactionEvent(sourceSession, efficiency).catch(() => {});

  emitDiagnosticEvent({
    type: "agent.compaction",
    sessionKey: sourceSession,
    efficiency,
  });
}

async function triggerAutonomousMemoryRepair(sessionKey: string, lostFacts: string[]) {
  const store = await getStrategicEvolutionStore();
  if (store.getSessionState<boolean>(sessionKey, "autonomy_blocked")) {
    log.warn(
      `[Nervous System] Autonomous Memory Repair blocked due to high fragility circuit breaker.`,
    );
    return;
  }

  const task = `
I am an autonomous memory repair subagent. During the last compaction cycle, the following critical facts/entities were lost or pruned too aggressively:
LOST ENTITIES:
${lostFacts.join(", ")}

TASK:
Review the current memory files and restore these missing facts in a concise, consolidated way. 
Do not just revert; integrate them back into the existing pruned structure.
`;

  await spawnSubagentDirect(
    {
      task,
      label: "Autonomous Memory Repair",
    },
    {
      agentSessionKey: sessionKey,
    },
  );
}

export function extractEntities(text: string): string[] {
  const COMMON_WORDS = new Set([
    "The",
    "And",
    "For",
    "This",
    "That",
    "With",
    "From",
    "Memory",
    "User",
    "Agent",
  ]);
  const matches = text.match(/\b[A-Z][a-z]{2,}\b/g) ?? [];
  return Array.from(new Set(matches)).filter((e) => !COMMON_WORDS.has(e));
}

async function handleRemediationCompletion(sessionKey: string, store: StrategicEvolutionStore) {
  const filePath = store.getSessionState<string>(sessionKey, "remediation_file");
  const sourceSession = store.getSessionState<string>(sessionKey, "remediation_source_session");
  const layer = store.getSessionState<JoyZoningLayer>(sessionKey, "remediation_layer");

  if (!filePath || !sourceSession || !layer) {
    return;
  }

  // Release Remediation Lock
  await store.releaseLock(`remediate:${filePath}`);

  try {
    const content = await fs.readFile(filePath, "utf8");
    const violations = await fluidPolicyEngine.audit({
      filePath,
      content,
      layer,
      toolName: "verify",
      sessionKey: sourceSession,
    });

    const blockViolations = violations.filter((v) => v.level === "block");
    const success = blockViolations.length === 0;

    void handleRemediationEvent(sourceSession, success).catch(() => {});

    if (!success) {
      log.warn(`Autonomous Remediation FAILED for ${filePath}. Triggering autonomous rollback.`);

      // Store "Lessons Learned" for next attempt
      const failureReason = blockViolations.map((v) => v.message).join("\n");
      await store.setSessionState(sourceSession, `lessons:${filePath}`, failureReason);

      const { loadConfig } = await import("../config/config.js");
      const { resolveAgentWorkspaceDir } = await import("./agent-scope.js");
      const { parseAgentSessionKey } = await import("../routing/session-key.js");

      const cfg = loadConfig();
      const agentId = parseAgentSessionKey(sourceSession)?.agentId;
      if (agentId) {
        const agentDir = resolveAgentWorkspaceDir(cfg, agentId);
        await rollbackToLastSnapshot(agentDir);
        log.info(`Rolled back ${agentDir} due to failed autonomous remediation.`);
      }
    }

    emitDiagnosticEvent({
      type: "agent.remediation",
      sessionKey: sourceSession,
      filePath,
      success,
    });
  } catch (err: unknown) {
    log.error(
      `Failed to verify remediation for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Handles incoming architectural entropy events (violations).
 * Triggers autonomous hardening if a file crosses a "Chaos Threshold".
 */
async function handleEntropyEvent(sessionKey: string, filePath: string, level: string) {
  const store = await getStrategicEvolutionStore();

  // Record entropy metric
  await store.recordMetric({
    sessionKey,
    type: "architectural_entropy",
    value: level === "block" ? 1.0 : 0.2,
    metadata: { filePath, level, activity: "jz_violation" },
  });

  // Check for entropy hotspots
  const metrics = store.getRecentMetrics({ sessionKey, type: "architectural_entropy", limit: 10 });
  const fileViolations = metrics.filter((m) => {
    try {
      const meta = JSON.parse(m.metadata || "{}") as { filePath?: string };
      return meta.filePath === filePath;
    } catch {
      return false;
    }
  });

  if (fileViolations.length >= 3) {
    log.warn(
      `[Existential Autonomy] Entropy Hotspot: ${filePath} has ${fileViolations.length} violations. Checking for failure correlation...`,
    );

    // Nervous System: Correlate with failed bash commands to find "Toxic Hotspots"
    const hotspots = store.reconcileEntropy({ limit: 20 });
    const isToxic = hotspots.includes(filePath);

    if (isToxic) {
      log.warn(
        `[Nervous System] Toxic Hotspot Confirmed: ${filePath}. Escalating repair priority.`,
      );
      await triggerAutonomousHardening(sessionKey, filePath, true);
    } else {
      await triggerAutonomousHardening(sessionKey, filePath, false);
    }
  }
}

/**
 * Spawns an Architect Subagent to refactor a file that keeps violating JoyZoning rules.
 */
async function triggerAutonomousHardening(
  sessionKey: string,
  filePath: string,
  toxic: boolean = false,
) {
  const store = await getStrategicEvolutionStore();
  if (store.getSessionState<boolean>(sessionKey, "autonomy_blocked")) {
    log.warn(
      `[Nervous System] Autonomous Hardening blocked due to high fragility circuit breaker.`,
    );
    return;
  }

  const task = `
I am an autonomous Architect Subagent. The file \`${filePath}\` has repeatedly violated JoyZoning architectural rules.
${toxic ? "\nCRITICAL: This file is a TOXIC HOTSPOT. It has been correlated with actual session failures. Fix immediately.\n" : ""}

TASK:
1. Audit \`${filePath}\` and its dependencies.
2. Refactor the code to eliminate architectural smells and illegal cross-layer imports.
3. Ensure the file conforms perfectly to JoyZoning layers (Domain, Core, Infrastructure, etc.).

Do not compromise on architectural integrity. If logic needs to be moved to a different layer, do it.
`;

  await spawnSubagentDirect(
    {
      task,
      label: toxic ? "Toxic Hotspot Repair" : "Autonomous Architectural Hardening",
    },
    {
      agentSessionKey: sessionKey,
    },
  );
}
