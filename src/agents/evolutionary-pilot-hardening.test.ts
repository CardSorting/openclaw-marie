import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { emitDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { initEvolutionaryPilot } from "./evolutionary-pilot.js";
import {
  getStrategicEvolutionStore,
  resetStrategicEvolutionStoreForTest,
  type StrategicEvolutionStore,
} from "./strategic-evolution-store.js";

describe("EvolutionaryPilot - Hardening & Circuit Breaker", () => {
  let testDbPath: string;
  let store: StrategicEvolutionStore;

  beforeEach(async () => {
    resetStrategicEvolutionStoreForTest();
    resetDiagnosticEventsForTest();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-pilot-"));
    testDbPath = path.join(tmpDir, "test-strategic-pilot.sqlite");
    store = await getStrategicEvolutionStore(testDbPath);
    await initEvolutionaryPilot();
  });

  afterEach(() => {
    resetStrategicEvolutionStoreForTest();
    resetDiagnosticEventsForTest();
  });

  it("should trigger Autonomy Circuit Breaker when fragility is high and regressing", async () => {
    const sessionKey = "toxic-loop-session";

    // 1. Record some regressing fragility
    for (let i = 0; i < 5; i++) {
      await store.recordMetric({
        sessionKey,
        type: "semantic_fragility",
        value: 0.1 + i * 0.1,
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    // 2. Emit a high fragility event
    emitDiagnosticEvent({
      type: "strategic.metric",
      sessionKey,
      metricType: "semantic_fragility",
      value: 0.7,
    });

    // Wait for async handler
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 3. Verify circuit breaker is active
    const blocked = store.getSessionState(sessionKey, "autonomy_blocked");
    expect(blocked).toBe(true);
  });
});
