import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { 
  getStrategicEvolutionStore, 
  resetStrategicEvolutionStoreForTest 
} from "./strategic-evolution-store.js";
import { 
  getDiagnosticSessionState, 
  saveDiagnosticSessionState, 
  resetDiagnosticSessionStateForTest 
} from "../logging/diagnostic-session-state.js";
import { recordToolCall } from "./tool-loop-detection.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Hardening Pass 2: Persistence", () => {
  const tempDir = path.join(os.tmpdir(), `openclaw-test-${Math.random().toString(36).slice(2)}`);
  const sessionKey = "test-session-pass2";

  beforeEach(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = tempDir;
    resetStrategicEvolutionStoreForTest();
    resetDiagnosticSessionStateForTest();
  });

  afterEach(() => {
    resetStrategicEvolutionStoreForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should persist and hydrate PendingToolCallState", () => {
    const sm = SessionManager.inMemory();
    const guard1 = installSessionToolResultGuard(sm, { sessionKey });

    // Add a tool call
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_persistent", name: "persistent_tool", arguments: {} }],
    } as any);

    expect(guard1.getPendingIds()).toContain("call_persistent");

    // "Restart" - create a new guard for the same session
    const sm2 = SessionManager.inMemory();
    const guard2 = installSessionToolResultGuard(sm2, { sessionKey });

    // Should have hydrated from store
    expect(guard2.getPendingIds()).toContain("call_persistent");
    
    // Deleting should also persist
    guard2.clearPendingToolResults();
    
    const sm3 = SessionManager.inMemory();
    const guard3 = installSessionToolResultGuard(sm3, { sessionKey });
    expect(guard3.getPendingIds()).toEqual([]);
  });

  it("should persist and hydrate Diagnostic SessionState (loop history)", () => {
    const ref = { sessionKey };
    const state = getDiagnosticSessionState(ref);
    
    // Simulate recording a tool call
    recordToolCall(state, "test_loop_tool", { arg: 1 }, "call_1");
    expect(state.toolCallHistory).toHaveLength(1);
    
    // Save to persistent store
    saveDiagnosticSessionState(ref);
    
    // Wipe in-memory state
    resetDiagnosticSessionStateForTest();
    
    // Hydrate
    const state2 = getDiagnosticSessionState(ref);
    expect(state2.toolCallHistory).toBeDefined();
    expect(state2.toolCallHistory).toHaveLength(1);
    expect(state2.toolCallHistory![0].toolName).toBe("test_loop_tool");
  });

  it("should persist and hydrate warning buckets", () => {
    const ref = { sessionKey };
    const state = getDiagnosticSessionState(ref);
    
    if (!state.toolLoopWarningBuckets) state.toolLoopWarningBuckets = new Map();
    state.toolLoopWarningBuckets.set("test_key", 5);
    
    saveDiagnosticSessionState(ref);
    resetDiagnosticSessionStateForTest();
    
    const state2 = getDiagnosticSessionState(ref);
    expect(state2.toolLoopWarningBuckets).toBeDefined();
    expect(state2.toolLoopWarningBuckets!.get("test_key")).toBe(5);
  });
});
