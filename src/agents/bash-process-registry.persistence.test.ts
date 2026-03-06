import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { 
  addSession, 
  markBackgrounded, 
  markExited, 
  listFinishedSessions, 
  resetProcessRegistryForTests,
  getFinishedSession
} from "./bash-process-registry.js";
import { 
  getStrategicEvolutionStore, 
  resetStrategicEvolutionStoreForTest 
} from "./strategic-evolution-store.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";

describe("bash process registry persistence", () => {
  beforeEach(() => {
    resetProcessRegistryForTests();
    resetStrategicEvolutionStoreForTest();
    // Ensure tables are empty
    const store = getStrategicEvolutionStore();
    (store as any).db.prepare("DELETE FROM sev_bash_history").run();
    (store as any).db.prepare("DELETE FROM sev_session_state").run();
  });

  afterEach(() => {
    resetProcessRegistryForTests();
    resetStrategicEvolutionStoreForTest();
  });

  it("persists finished backgrounded sessions to StrategicEvolutionStore", async () => {
    const store = getStrategicEvolutionStore();
    const session = createProcessSessionFixture({
      id: "persisted-sess",
      command: "echo persisted",
      backgrounded: true,
    });

    addSession(session);
    markExited(session, 0, null, "completed");

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
    const store = getStrategicEvolutionStore();
    
    // Manually insert into DB to simulate existing history
    const now = Date.now();
    store.saveBashHistory({
      id: "hydrated-sess",
      command: "echo hydrated",
      status: "completed",
      startedAt: now - 1000,
      endedAt: now - 500,
      aggregated: "output",
      tail: "output",
      truncated: false,
      totalOutputChars: 6,
      sessionKey: "test-session"
    });

    // Verify initially empty (except for what might have happened in other tests)
    resetProcessRegistryForTests();
    expect(listFinishedSessions()).toHaveLength(0);

    // Call hydration
    const { hydrateBashHistory } = await import("./bash-process-registry.js");
    hydrateBashHistory();

    // Check in-memory
    const sessions = listFinishedSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("hydrated-sess");
    expect(sessions[0].command).toBe("echo hydrated");
  });
});
