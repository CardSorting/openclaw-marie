import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getStrategicEvolutionStore, resetStrategicEvolutionStoreForTest } from "./strategic-evolution-store.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

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
            metadata: { info: "test" }
        });

        const metrics = store.getRecentMetrics({ sessionKey, type: "sentiment" });
        expect(metrics.length).toBe(1);
        expect(metrics[0].value).toBe(0.8);
        expect(JSON.parse(metrics[0].metadata!)).toEqual({ info: "test" });
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
