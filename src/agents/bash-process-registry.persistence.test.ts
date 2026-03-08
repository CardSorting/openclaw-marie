import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  addSession,
  markExited,
  listFinishedSessions,
  getFinishedSession,
  hydrateBashHistory,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import {
  getStrategicEvolutionStore,
  resetStrategicEvolutionStoreForTest,
  type PersistentBashSession,
} from "./strategic-evolution-store.js";

describe("bash process registry persistence", () => {
  beforeEach(async () => {
    resetProcessRegistryForTests();
    resetStrategicEvolutionStoreForTest();
    // Ensure tables are empty
    const store = await getStrategicEvolutionStore();
    // Use unknown cast to access private pool for cleanup in test
    await (
      store as unknown as {
        pool: { withWriteLock: (cb: (db: unknown) => Promise<void>) => Promise<void> };
      }
    ).pool.withWriteLock(async (db: unknown) => {
      const typedDb = db as { prepare: (s: string) => { run: () => void } };
      typedDb.prepare("DELETE FROM sev_bash_history").run();
      typedDb.prepare("DELETE FROM sev_session_state").run();
    });
  });

  afterEach(() => {
    resetProcessRegistryForTests();
    resetStrategicEvolutionStoreForTest();
  });

  it("persists finished backgrounded sessions to StrategicEvolutionStore", async () => {
    const store = await getStrategicEvolutionStore();
    const session = createProcessSessionFixture({
      id: "persisted-sess",
      command: "echo persisted",
      backgrounded: true,
    });

    addSession(session);
    markExited(session, 0, null, "completed");

    // Wait for async persistence
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Check in-memory
    expect(listFinishedSessions()).toHaveLength(1);
    expect(getFinishedSession("persisted-sess")).toBeDefined();

    // Check database
    const history = store.getBashHistory(10);
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe("persisted-sess");
    expect(history[0].command).toBe("echo persisted");
    expect(history[0].status).toBe("completed");
  });

  it("hydrates finished sessions from StrategicEvolutionStore", async () => {
    const store = await getStrategicEvolutionStore();

    // Manually insert into DB to simulate existing history
    const now = Date.now();
    const mockHistory: PersistentBashSession = {
      id: "hydrated-sess",
      command: "echo hydrated",
      status: "completed",
      startedAt: now - 1000,
      endedAt: now - 500,
      aggregated: "output",
      tail: "output",
      truncated: false,
      totalOutputChars: 6,
      sessionKey: "test-session",
    };
    await store.saveBashHistory(mockHistory);

    // Verify initially empty
    resetProcessRegistryForTests();
    expect(listFinishedSessions()).toHaveLength(0);

    // Call hydration
    await hydrateBashHistory();

    // Check in-memory
    const sessions = listFinishedSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("hydrated-sess");
    expect(sessions[0].command).toBe("echo hydrated");
  });
});
