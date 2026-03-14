import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getStrategicEvolutionStore,
  resetStrategicEvolutionStoreForTest,
  type PersistentBashSession,
} from "./strategic-evolution-store.js";

describe("StrategicEvolutionStore", () => {
  let testDbPath: string;
  let store: Awaited<ReturnType<typeof getStrategicEvolutionStore>>;

  beforeEach(async () => {
    resetStrategicEvolutionStoreForTest();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-"));
    testDbPath = path.join(tmpDir, "test-strategic.sqlite");
    store = await getStrategicEvolutionStore(testDbPath);
  });

  afterEach(() => {
    resetStrategicEvolutionStoreForTest();
    if (fs.existsSync(testDbPath)) {
      // Optional: cleanup
    }
  });

  it("should record and retrieve metrics", async () => {
    const sessionKey = "test-session";
    await store.recordMetric({
      sessionKey,
      type: "sentiment",
      value: 0.8,
      metadata: { info: "test" },
    });

    const metrics = store.getRecentMetrics({ sessionKey, type: "sentiment" });
    expect(metrics.length).toBe(1);
    expect(metrics[0].value).toBe(0.8);
    expect(JSON.parse(metrics[0].metadata!)).toEqual({ info: "test" });
  });

  it("should detect fragility trend correctly", async () => {
    // 1. Stable
    const sessionStable = "fragile-session-stable";
    for (let i = 0; i < 5; i++) {
      await store.recordMetric({
        sessionKey: sessionStable,
        type: "semantic_fragility",
        value: 0.2,
      });
    }
    expect(store.getRecentFragilityTrend(sessionStable)).toBe("stable");

    // 2. Regressing (Increasing fragility)
    const sessionRegressing = "fragile-session-regressing";
    for (let i = 0; i < 5; i++) {
      await store.recordMetric({
        sessionKey: sessionRegressing,
        type: "semantic_fragility",
        value: 0.1 + i * 0.1,
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(store.getRecentFragilityTrend(sessionRegressing)).toBe("regressing");

    // 3. Improving (Decreasing fragility)
    const sessionImproving = "fragile-session-improving";
    for (let i = 0; i < 5; i++) {
      await store.recordMetric({
        sessionKey: sessionImproving,
        type: "semantic_fragility",
        value: 0.5 - i * 0.1,
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(store.getRecentFragilityTrend(sessionImproving)).toBe("improving");
  });

  it("should reconcile entropy with temporal weighting", async () => {
    const sessionKeyRecent = "recent-fail";
    const sessionKeyOld = "old-fail";
    const filePathRecent = "src/recent.ts";
    const filePathOld = "src/old.ts";

    const now = Date.now();

    // Record entropy for both
    await store.recordMetric({
      sessionKey: sessionKeyRecent,
      type: "architectural_entropy",
      value: 1.0,
      metadata: { filePath: filePathRecent },
    });
    await store.recordMetric({
      sessionKey: sessionKeyOld,
      type: "architectural_entropy",
      value: 1.0,
      metadata: { filePath: filePathOld },
    });

    // Record bash history
    const recentFail: PersistentBashSession = {
      id: "fail-1",
      command: "npm test",
      sessionKey: sessionKeyRecent,
      startedAt: now - 1000,
      endedAt: now - 500,
      status: "error",
      exitCode: 1,
      aggregated: "fail",
      tail: "fail",
      truncated: false,
      totalOutputChars: 4,
    };

    const oldFail: PersistentBashSession = {
      id: "fail-2",
      command: "npm test",
      sessionKey: sessionKeyOld,
      startedAt: now - 10 * 3600 * 1000,
      endedAt: now - 10 * 3600 * 1000 + 500,
      status: "error",
      exitCode: 1,
      aggregated: "fail",
      tail: "fail",
      truncated: false,
      totalOutputChars: 4,
    };

    await store.saveBashHistory(recentFail);
    await store.saveBashHistory(oldFail);

    const hotspots = store.reconcileEntropy({ limit: 10 });

    // The recent failure should have a higher weighted score and thus appear first
    expect(hotspots[0]).toBe(filePathRecent);
    expect(hotspots).toContain(filePathOld);
  });

  it("should track recall hits", async () => {
    const sessionKey = "test-session";
    const lineHash = "abc123hash";

    await store.recordRecallHit(sessionKey, lineHash);
    await store.recordRecallHit(sessionKey, lineHash);

    const hits = store.getRecallHits(sessionKey, lineHash);
    expect(hits).toBe(2);
  });

  it("should calculate stats", async () => {
    const sessionKey = "stats-session";

    await store.recordMetric({ sessionKey, type: "discovery", value: 10 });
    await store.recordMetric({ sessionKey, type: "discovery", value: 20 });
    await store.recordMetric({ sessionKey, type: "discovery", value: 30 });

    const stats = store.getStats({ sessionKey, type: "discovery" });
    expect(stats.count).toBe(3);
    expect(stats.mean).toBe(20);
    expect(stats.stdDev).toBeGreaterThan(0);
  });

  it("should persist and retrieve session state", async () => {
    const sessionKey = "test-session";
    const stateKey = "turn_count";
    const stateValue = 42;

    await store.setSessionState(sessionKey, stateKey, stateValue);
    const retrieved = store.getSessionState<number>(sessionKey, stateKey);

    expect(retrieved).toBe(stateValue);
  });

  it("should handle complex objects in session state", async () => {
    const sessionKey = "test-session";
    const stateKey = "perf";
    const stateValue = { latencies: [100, 200], mutationActive: true };

    await store.setSessionState(sessionKey, stateKey, stateValue);
    const retrieved = store.getSessionState<typeof stateValue>(sessionKey, stateKey);

    expect(retrieved).toEqual(stateValue);
  });

  it("should update existing session state on conflict", async () => {
    const sessionKey = "test-session";
    const stateKey = "status";

    await store.setSessionState(sessionKey, stateKey, "initial");
    await store.setSessionState(sessionKey, stateKey, "updated");

    const retrieved = store.getSessionState<string>(sessionKey, stateKey);
    expect(retrieved).toBe("updated");
  });
});
