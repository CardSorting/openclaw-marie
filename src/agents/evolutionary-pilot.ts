import { onDiagnosticEvent, type DiagnosticEventPayload } from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { rollbackToLastSnapshot } from "./marie-memory.js";

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
export function initEvolutionaryPilot() {
  onDiagnosticEvent((event: DiagnosticEventPayload) => {
    if (event.type === "model.usage" && event.sessionKey) {
      void handleUsageEvent(event.sessionKey, event.durationMs ?? 0).catch(() => {});
    } else if (event.type === "message.processed" && event.sessionKey) {
      void handleOutcomeEvent(event.sessionKey, event.outcome === "completed" ? 1 : 0).catch(
        () => {},
      );
    } else if (event.type === "strategic.metric" && event.sessionKey) {
      void handleStrategicMetric(event.sessionKey, event.metricType, event.value).catch(() => {});
    }
  });
  log.info("EvolutionaryPilot initialized and listening for performance metrics.");
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

import { getStrategicEvolutionStore } from "./strategic-evolution-store.js";

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
    // We need the agentDir to perform the rollback.
    // For now, we'll log it. In a real integration, we'd need to map sessionKey to agentDir.
    log.error(
      `ROLLBACK REQ: Session ${sessionKey} requires memory rollback due to performance regression.`,
    );
    // Note: In OpenClaw, the sessionKey often corresponds to a directory path or can be used to find one.
    // If sessionKey is a path:
    await rollbackToLastSnapshot(sessionKey);
  }
}
