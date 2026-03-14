import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CronConfig } from "../config/types.cron.js";
import { sweepAutonomyNudges, resetAutonomyNudgeThrottle } from "./autonomy-nudge.js";
import type { CronServiceState, Logger } from "./service/state.js";

function createTestLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("sweepAutonomyNudges", () => {
  let tmpDir: string;
  let storePath: string;
  const log = createTestLogger();

  beforeEach(async () => {
    resetAutonomyNudgeThrottle();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autonomy-nudge-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  const createTestState = (nowMs: number, cronConfig: CronConfig = {}): CronServiceState => {
    return {
      deps: {
        nowMs: () => nowMs,
        log,
        storePath: path.join(tmpDir, "cron.json"),
        cronEnabled: true,
        cronConfig,
        sessionStorePath: storePath,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn() as unknown as CronServiceState["deps"]["runIsolatedAgentJob"],
      },
      store: null,
      timer: null,
      running: false,
      op: Promise.resolve(),
      warnedDisabled: false,
      storeLoadedAtMs: null,
      storeFileMtimeMs: null,
    };
  };

  it("nudges idle autonomy task sessions (heuristics)", async () => {
    const now = Date.now();
    const store = {
      "agent:main:acp:task1": {
        sessionId: "s1",
        updatedAt: now - 6 * 60_000, // 6m ago
        acp: {
          state: "idle",
        },
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const state = createTestState(now, { autonomyNudge: { enabled: true, idleMinutes: 5 } });
    await sweepAutonomyNudges({ state, sessionStorePath: storePath });

    expect(state.deps.enqueueSystemEvent).toHaveBeenCalledWith(
      "Continue with your task.",
      expect.objectContaining({ sessionKey: "agent:main:acp:task1" }),
    );
  });

  it("nudges explicitly autonomous sessions", async () => {
    const now = Date.now();
    const store = {
      "agent:main:acp:s1": {
        sessionId: "s1",
        updatedAt: now - 6 * 60_000,
        acp: {
          state: "idle",
          isAutonomous: true,
        },
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const state = createTestState(now, { autonomyNudge: { enabled: true, idleMinutes: 5 } });
    await sweepAutonomyNudges({ state, sessionStorePath: storePath });

    expect(state.deps.enqueueSystemEvent).toHaveBeenCalledWith(
      "Continue with your task.",
      expect.objectContaining({ sessionKey: "agent:main:acp:s1" }),
    );
  });

  it("uses continuation token in nudge text", async () => {
    const now = Date.now();
    const store = {
      "agent:main:acp:s1": {
        sessionId: "s1",
        updatedAt: now - 6 * 60_000,
        acp: {
          state: "idle",
          isAutonomous: true,
          taskContinuationToken: "step-42",
        },
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const state = createTestState(now, { autonomyNudge: { enabled: true, idleMinutes: 5 } });
    await sweepAutonomyNudges({ state, sessionStorePath: storePath });

    expect(state.deps.enqueueSystemEvent).toHaveBeenCalledWith(
      "Continue with your task. (Continuation token: step-42)",
      expect.objectContaining({ sessionKey: "agent:main:acp:s1" }),
    );
  });

  it("escalates nudge messages", async () => {
    const now = Date.now();
    const store = {
      "agent:main:acp:s1": {
        sessionId: "s1",
        updatedAt: now - 10 * 60_000,
        acp: {
          state: "idle",
          isAutonomous: true,
          nudgeCount: 1,
        },
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const state = createTestState(now, { autonomyNudge: { enabled: true, idleMinutes: 5 } });
    await sweepAutonomyNudges({ state, sessionStorePath: storePath });

    expect(state.deps.enqueueSystemEvent).toHaveBeenCalledWith(
      "Progress check: Are you still working on your autonomous task?",
      expect.objectContaining({ sessionKey: "agent:main:acp:s1" }),
    );

    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated["agent:main:acp:s1"].acp.nudgeCount).toBe(2);
  });

  it("respects explicit nextNudgeAt", async () => {
    const now = Date.now();
    const store = {
      "agent:main:acp:s1": {
        sessionId: "s1",
        updatedAt: now - 1 * 60_000, // 1m ago
        acp: {
          state: "idle",
          isAutonomous: true,
          nextNudgeAt: now - 100, // Should have nudged 100ms ago
        },
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const state = createTestState(now, { autonomyNudge: { enabled: true, idleMinutes: 5 } });
    await sweepAutonomyNudges({ state, sessionStorePath: storePath });

    expect(state.deps.enqueueSystemEvent).toHaveBeenCalled();

    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated["agent:main:acp:s1"].acp.nextNudgeAt).toBeUndefined();
  });

  it("respects per-session nudgeIntervalMs", async () => {
    const now = Date.now();
    const store = {
      "agent:main:acp:s1": {
        sessionId: "s1",
        updatedAt: now - 3 * 60_000, // 3m ago
        acp: {
          state: "idle",
          isAutonomous: true,
          runtimeOptions: {
            nudgeIntervalMs: 2 * 60_000, // 2m override
          },
        },
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const state = createTestState(now, { autonomyNudge: { enabled: true, idleMinutes: 10 } });
    await sweepAutonomyNudges({ state, sessionStorePath: storePath });

    expect(state.deps.enqueueSystemEvent).toHaveBeenCalled();
  });

  it("respects nudgeSchedule (cron)", async () => {
    const now = new Date("2026-03-13T12:00:05Z").getTime(); // 5s past noon
    const store = {
      "agent:main:acp:s1": {
        sessionId: "s1",
        updatedAt: now - 1 * 60_000, // 1m ago
        acp: {
          state: "idle",
          isAutonomous: true,
          nudgeSchedule: "0 0 12 * * *", // Every day at noon
          lastNudgeAt: new Date("2026-03-12T12:00:00Z").getTime(), // Yesterday at noon
        },
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const state = createTestState(now, { autonomyNudge: { enabled: true, idleMinutes: 60 } });
    await sweepAutonomyNudges({ state, sessionStorePath: storePath });

    expect(state.deps.enqueueSystemEvent).toHaveBeenCalled();
  });

  it("does not nudge too early for nudgeSchedule", async () => {
    const now = new Date("2026-03-13T11:59:59Z").getTime(); // 1s before noon
    const store = {
      "agent:main:acp:s1": {
        sessionId: "s1",
        updatedAt: now - 1 * 60_000,
        acp: {
          state: "idle",
          isAutonomous: true,
          nudgeSchedule: "0 0 12 * * *",
          lastNudgeAt: new Date("2026-03-12T12:00:00Z").getTime(), // Yesterday at noon
        },
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const state = createTestState(now, { autonomyNudge: { enabled: true, idleMinutes: 60 } });
    await sweepAutonomyNudges({ state, sessionStorePath: storePath });

    expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("respects idleMinutes config", async () => {
    const now = Date.now();
    const store = {
      "agent:main:acp:task1": {
        sessionId: "s1",
        updatedAt: now - 3 * 60_000, // 3m ago
        acp: {
          state: "idle",
        },
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    // Default 5m - should not nudge
    const state1 = createTestState(now);
    await sweepAutonomyNudges({ state: state1, sessionStorePath: storePath });
    expect(state1.deps.enqueueSystemEvent).not.toHaveBeenCalled();

    resetAutonomyNudgeThrottle();

    // Configured 2m - should nudge
    const state2 = createTestState(now, { autonomyNudge: { enabled: true, idleMinutes: 2 } });
    await sweepAutonomyNudges({ state: state2, sessionStorePath: storePath });
    expect(state2.deps.enqueueSystemEvent).toHaveBeenCalled();
  });

  it("updates lastActivityAt after nudging", async () => {
    const now = Date.now();
    const store = {
      "agent:main:acp:task1": {
        sessionId: "s1",
        updatedAt: now - 10 * 60_000,
        acp: {
          state: "idle",
        },
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const state = createTestState(now, { autonomyNudge: { enabled: true } });
    await sweepAutonomyNudges({ state, sessionStorePath: storePath });

    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated["agent:main:acp:task1"].acp.lastActivityAt).toBe(now);
  });
});
