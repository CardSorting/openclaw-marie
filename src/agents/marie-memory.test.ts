import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readMemory,
  readUserModel,
  writeMemory,
  writeUserModel,
  createFrozenSnapshot,
  getMemoryCapacity,
  getUserModelCapacity,
  readMemoryState,
  MEMORY_CHAR_CAP,
  USER_CHAR_CAP,
} from "./marie-memory.js";
import {
  trackTurn,
  getTurnCount,
  resetTurnCount,
  resetAllForTest,
  buildNudgePrompt,
  commitNudge,
  NUDGE_INTERVAL,
} from "./marie-memory-nudge.js";
import { stripArtifacts, flushMemory } from "./marie-memory-flush.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "marie-memory-test-"));
});

afterEach(async () => {
  resetAllForTest();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// marie-memory.ts
// ---------------------------------------------------------------------------

describe("marie-memory", () => {
  describe("readMemory", () => {
    it("returns empty string when file does not exist", async () => {
      const result = await readMemory(tmpDir);
      expect(result).toBe("");
    });

    it("reads existing MEMORY.md content", async () => {
      await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "hello memory", "utf8");
      const result = await readMemory(tmpDir);
      expect(result).toBe("hello memory");
    });
  });

  describe("readUserModel", () => {
    it("returns empty string when file does not exist", async () => {
      const result = await readUserModel(tmpDir);
      expect(result).toBe("");
    });

    it("reads existing USER.md content", async () => {
      await fs.writeFile(path.join(tmpDir, "USER.md"), "hello user", "utf8");
      const result = await readUserModel(tmpDir);
      expect(result).toBe("hello user");
    });
  });

  describe("writeMemory", () => {
    it("writes content within cap", async () => {
      const result = await writeMemory(tmpDir, "test content");
      expect(result.ok).toBe(true);
      expect(result.charCount).toBe(12);
      expect(result.cap).toBe(MEMORY_CHAR_CAP);

      const content = await fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf8");
      expect(content).toBe("test content");
    });

    it("rejects content exceeding MEMORY_CHAR_CAP", async () => {
      const oversized = "x".repeat(MEMORY_CHAR_CAP + 1);
      const result = await writeMemory(tmpDir, oversized);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("exceeds hard cap");
      expect(result.charCount).toBe(MEMORY_CHAR_CAP + 1);
    });

    it("accepts content at exactly MEMORY_CHAR_CAP", async () => {
      const exact = "x".repeat(MEMORY_CHAR_CAP);
      const result = await writeMemory(tmpDir, exact);
      expect(result.ok).toBe(true);
    });
  });

  describe("writeUserModel", () => {
    it("writes content within cap", async () => {
      const result = await writeUserModel(tmpDir, "user info");
      expect(result.ok).toBe(true);
      expect(result.cap).toBe(USER_CHAR_CAP);
    });

    it("rejects content exceeding USER_CHAR_CAP", async () => {
      const oversized = "x".repeat(USER_CHAR_CAP + 1);
      const result = await writeUserModel(tmpDir, oversized);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("exceeds hard cap");
    });
  });

  describe("createFrozenSnapshot", () => {
    it("creates snapshot file in snapshots directory", async () => {
      await writeMemory(tmpDir, "memory data");
      await writeUserModel(tmpDir, "user data");

      const snapshot = await createFrozenSnapshot(tmpDir);
      expect(snapshot.timestamp).toBeTruthy();
      expect(snapshot.hash).toBeTruthy();
      expect(snapshot.path).toContain("snapshots");

      const content = await fs.readFile(snapshot.path, "utf8");
      expect(content).toContain("memory data");
      expect(content).toContain("user data");
    });

    it("creates snapshots directory if it does not exist", async () => {
      const snapshot = await createFrozenSnapshot(tmpDir);
      const stat = await fs.stat(path.dirname(snapshot.path));
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe("getMemoryCapacity", () => {
    it("reports full capacity when empty", async () => {
      const cap = await getMemoryCapacity(tmpDir);
      expect(cap.used).toBe(0);
      expect(cap.remaining).toBe(MEMORY_CHAR_CAP);
      expect(cap.cap).toBe(MEMORY_CHAR_CAP);
    });

    it("reports reduced capacity after write", async () => {
      await writeMemory(tmpDir, "hello");
      const cap = await getMemoryCapacity(tmpDir);
      expect(cap.used).toBe(5);
      expect(cap.remaining).toBe(MEMORY_CHAR_CAP - 5);
    });
  });

  describe("readMemoryState", () => {
    it("returns complete state", async () => {
      await writeMemory(tmpDir, "mem");
      await writeUserModel(tmpDir, "usr");
      const state = await readMemoryState(tmpDir);
      expect(state.memory).toBe("mem");
      expect(state.userModel).toBe("usr");
    });
  });
});

// ---------------------------------------------------------------------------
// marie-memory-nudge.ts
// ---------------------------------------------------------------------------

describe("marie-memory-nudge", () => {
  describe("trackTurn", () => {
    it("returns false before reaching NUDGE_INTERVAL", () => {
      for (let i = 1; i < NUDGE_INTERVAL; i++) {
        expect(trackTurn("session-1")).toBe(false);
      }
    });

    it("returns true at exactly NUDGE_INTERVAL", () => {
      for (let i = 1; i < NUDGE_INTERVAL; i++) {
        trackTurn("session-1");
      }
      expect(trackTurn("session-1")).toBe(true);
    });

    it("returns true again at 2x NUDGE_INTERVAL", () => {
      for (let i = 1; i <= NUDGE_INTERVAL; i++) {
        trackTurn("session-1");
      }
      for (let i = 1; i < NUDGE_INTERVAL; i++) {
        expect(trackTurn("session-1")).toBe(false);
      }
      expect(trackTurn("session-1")).toBe(true);
    });

    it("tracks sessions independently", () => {
      for (let i = 1; i < NUDGE_INTERVAL; i++) {
        trackTurn("session-a");
      }
      expect(trackTurn("session-b")).toBe(false);
      expect(trackTurn("session-a")).toBe(true);
    });
  });

  describe("getTurnCount / resetTurnCount", () => {
    it("returns 0 for unknown session", () => {
      expect(getTurnCount("unknown")).toBe(0);
    });

    it("returns correct count after tracking", () => {
      trackTurn("s1");
      trackTurn("s1");
      trackTurn("s1");
      expect(getTurnCount("s1")).toBe(3);
    });

    it("resets to 0", () => {
      trackTurn("s1");
      resetTurnCount("s1");
      expect(getTurnCount("s1")).toBe(0);
    });
  });

  describe("buildNudgePrompt", () => {
    it("includes char counts and caps", () => {
      const prompt = buildNudgePrompt("some memory", "some user");
      expect(prompt).toContain("Memory Review Nudge");
      expect(prompt).toContain(`${MEMORY_CHAR_CAP}`);
      expect(prompt).toContain(`${USER_CHAR_CAP}`);
      expect(prompt).toContain("some memory");
      expect(prompt).toContain("some user");
    });

    it("handles empty content", () => {
      const prompt = buildNudgePrompt("", "");
      expect(prompt).toContain("(empty)");
    });
  });

  describe("commitNudge", () => {
    it("writes both files and creates snapshot", async () => {
      const result = await commitNudge(tmpDir, "new mem", "new usr");
      expect(result.memoryResult.ok).toBe(true);
      expect(result.userModelResult.ok).toBe(true);
      expect(result.snapshotCreated).toBe(true);

      const mem = await readMemory(tmpDir);
      expect(mem).toBe("new mem");
    });

    it("rejects oversized memory in nudge", async () => {
      const result = await commitNudge(tmpDir, "x".repeat(MEMORY_CHAR_CAP + 1));
      expect(result.memoryResult.ok).toBe(false);
      expect(result.snapshotCreated).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// marie-memory-flush.ts
// ---------------------------------------------------------------------------

describe("marie-memory-flush", () => {
  describe("stripArtifacts", () => {
    it("strips base64 data URIs", () => {
      const content = `text data:image/png;base64,${"A".repeat(200)} more`;
      const result = stripArtifacts(content);
      expect(result.count).toBe(1);
      expect(result.stripped).toContain("[artifact-stripped]");
      expect(result.stripped).not.toContain("AAAA");
    });

    it("strips large code blocks", () => {
      const code = "```\n" + "x".repeat(600) + "\n```";
      const content = `before ${code} after`;
      const result = stripArtifacts(content);
      expect(result.count).toBe(1);
      expect(result.stripped).toContain("[artifact-stripped]");
    });

    it("returns original when no artifacts found", () => {
      const content = "clean text without artifacts";
      const result = stripArtifacts(content);
      expect(result.count).toBe(0);
      expect(result.stripped).toBe(content);
    });
  });

  describe("flushMemory", () => {
    it("creates snapshot after flush", async () => {
      await writeMemory(tmpDir, "clean content");
      await writeUserModel(tmpDir, "clean user");
      const result = await flushMemory(tmpDir);
      expect(result.snapshotCreated).toBe(true);
      expect(result.memoryFlushed).toBe(true);
      expect(result.userModelFlushed).toBe(true);
    });

    it("strips artifacts during flush", async () => {
      const content = `text data:image/png;base64,${"A".repeat(200)} more`;
      await writeMemory(tmpDir, content);
      await writeUserModel(tmpDir, "clean");
      const result = await flushMemory(tmpDir);
      expect(result.artifactsStripped).toBeGreaterThan(0);

      const mem = await readMemory(tmpDir);
      expect(mem).toContain("[artifact-stripped]");
    });
  });
});
