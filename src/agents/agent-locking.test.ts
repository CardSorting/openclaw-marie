import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { emitDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { initEvolutionaryPilot } from "./evolutionary-pilot.js";
import {
  getStrategicEvolutionStore,
  resetStrategicEvolutionStoreForTest,
  type StrategicEvolutionStore,
} from "./strategic-evolution-store.js";

describe("Agent Locking - Compaction & Remediation", () => {
  let testDbPath: string;
  let store: StrategicEvolutionStore;

  beforeEach(async () => {
    resetStrategicEvolutionStoreForTest();
    resetDiagnosticEventsForTest();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-locking-"));
    testDbPath = path.join(tmpDir, "test-strategic-locking.sqlite");
    store = await getStrategicEvolutionStore(testDbPath);
    await initEvolutionaryPilot();
  });

  afterEach(() => {
    resetStrategicEvolutionStoreForTest();
    resetDiagnosticEventsForTest();
  });

  it("should release compaction lock on completion", async () => {
    const sessionKey = "main-session";
    const subagentSessionKey = "compaction-subagent";

    // 1. Acquire lock (simulating marie-memory-compactor)
    const lockKey = `compact:${sessionKey}`;
    const acquired = await store.acquireLock(lockKey, 3600_000);
    expect(acquired).toBe(true);

    // 2. Set subagent state
    await store.setSessionState(subagentSessionKey, "is_compaction", true);
    await store.setSessionState(subagentSessionKey, "compaction_source_session", sessionKey);

    // 3. Emit completion event
    emitDiagnosticEvent({
      type: "message.processed",
      sessionKey: subagentSessionKey,
      outcome: "completed",
      channel: "internal",
    });

    // Wait for async handler
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 4. Verify lock is released
    const stillLocked = await store.acquireLock(lockKey, 1000);
    expect(stillLocked).toBe(true); // Should be true because it was released and we can acquire it again
  });

  it("should release remediation lock on completion", async () => {
    const sessionKey = "main-session";
    const subagentSessionKey = "remediation-subagent";
    const filePath = "src/toxic.ts";

    // 1. Acquire lock (simulating FluidPolicyEngine)
    const lockKey = `remediate:${filePath}`;
    const acquired = await store.acquireLock(lockKey, 3600_000);
    expect(acquired).toBe(true);

    // 2. Set subagent state
    await store.setSessionState(subagentSessionKey, "is_remediation", true);
    await store.setSessionState(subagentSessionKey, "remediation_file", filePath);
    await store.setSessionState(subagentSessionKey, "remediation_source_session", sessionKey);
    await store.setSessionState(subagentSessionKey, "remediation_layer", "Domain");

    // 3. Emit completion event (will trigger handleRemediationCompletion)
    // We need to mock fs.readFile because handleRemediationCompletion reads the file
    vi.mock("node:fs/promises", async () => {
      return {
        promises: {
          readFile: vi.fn().mockResolvedValue("content"),
        },
      };
    });

    emitDiagnosticEvent({
      type: "message.processed",
      sessionKey: subagentSessionKey,
      outcome: "completed",
      channel: "internal",
    });

    // Wait for async handler
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 4. Verify lock is released
    const stillLocked = await store.acquireLock(lockKey, 1000);
    expect(stillLocked).toBe(true);
  });
});
