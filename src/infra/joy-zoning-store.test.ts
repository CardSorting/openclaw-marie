import { describe, beforeEach, expect, it } from "vitest";
import { createInMemoryStore, type JoyZoningStore } from "./joy-zoning-store.js";

describe("JoyZoningStore", () => {
  let store: JoyZoningStore;

  beforeEach(() => {
    store = createInMemoryStore();
  });

  describe("violations", () => {
    it("records and retrieves violations", async () => {
      const id = await store.recordViolation({
        sessionKey: "s1",
        filePath: "src/config/config.ts",
        layer: "Domain",
        level: "block",
        message: "Domain importing Infrastructure",
        correctionHint: "Use dependency inversion",
      });
      expect(id).toBeTruthy();

      const violations = store.getRecentViolations("s1");
      expect(violations).toHaveLength(1);
      expect(violations[0].filePath).toBe("src/config/config.ts");
      expect(violations[0].level).toBe("block");
      expect(violations[0].correctionHint).toBe("Use dependency inversion");
    });

    it("returns both violations for a session", async () => {
      await store.recordViolation({
        sessionKey: "s1",
        filePath: "src/config/a.ts",
        layer: "Domain",
        level: "block",
        message: "first",
      });
      await store.recordViolation({
        sessionKey: "s1",
        filePath: "src/config/b.ts",
        layer: "Domain",
        level: "warning",
        message: "second",
      });

      const violations = store.getRecentViolations("s1");
      expect(violations).toHaveLength(2);
      const messages = violations.map((v) => v.message);
      expect(messages).toContain("first");
      expect(messages).toContain("second");
    });

    it("retrieves violations by file path", async () => {
      await store.recordViolation({
        sessionKey: "s1",
        filePath: "src/config/config.ts",
        layer: "Domain",
        level: "block",
        message: "violation A",
      });
      await store.recordViolation({
        sessionKey: "s2",
        filePath: "src/config/config.ts",
        layer: "Domain",
        level: "warning",
        message: "violation B",
      });
      await store.recordViolation({
        sessionKey: "s1",
        filePath: "src/agents/other.ts",
        layer: "Core",
        level: "warning",
        message: "violation C",
      });

      const fileViolations = store.getViolationsByFile("src/config/config.ts");
      expect(fileViolations).toHaveLength(2);
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await store.recordViolation({
          sessionKey: "s1",
          filePath: `src/config/${i}.ts`,
          layer: "Domain",
          level: "warning",
          message: `violation ${i}`,
        });
      }
      expect(store.getRecentViolations("s1", 3)).toHaveLength(3);
    });
  });

  describe("strikes", () => {
    it("increments strike count", async () => {
      expect(await store.getOrIncrementStrike("src/config/config.ts")).toBe(1);
      expect(await store.getOrIncrementStrike("src/config/config.ts")).toBe(2);
      expect(await store.getOrIncrementStrike("src/config/config.ts")).toBe(3);
      expect(store.getStrikeCount("src/config/config.ts")).toBe(3);
    });

    it("tracks independent files separately", async () => {
      await store.getOrIncrementStrike("src/config/a.ts");
      await store.getOrIncrementStrike("src/config/a.ts");
      await store.getOrIncrementStrike("src/config/b.ts");

      expect(store.getStrikeCount("src/config/a.ts")).toBe(2);
      expect(store.getStrikeCount("src/config/b.ts")).toBe(1);
    });

    it("resets a strike", async () => {
      await store.getOrIncrementStrike("src/config/config.ts");
      await store.getOrIncrementStrike("src/config/config.ts");
      await store.resetStrike("src/config/config.ts");
      expect(store.getStrikeCount("src/config/config.ts")).toBe(0);
    });

    it("returns 0 for unknown files", () => {
      expect(store.getStrikeCount("nonexistent.ts")).toBe(0);
    });

    it("returns top strikers", async () => {
      for (let i = 0; i < 3; i++) await store.getOrIncrementStrike("src/config/many.ts");
      await store.getOrIncrementStrike("src/config/one.ts");

      const top = store.getTopStrikes(5);
      expect(top).toHaveLength(2);
      expect(top[0].filePath).toBe("src/config/many.ts");
      expect(top[0].strikeCount).toBe(3);
    });
  });

  describe("sessions", () => {
    it("tracks session stats from violations", async () => {
      await store.recordViolation({
        sessionKey: "s1",
        filePath: "src/config/a.ts",
        layer: "Domain",
        level: "warning",
        message: "w1",
      });
      await store.recordViolation({
        sessionKey: "s1",
        filePath: "src/config/b.ts",
        layer: "Domain",
        level: "block",
        message: "b1",
      });
      await store.recordViolation({
        sessionKey: "s1",
        filePath: "src/config/c.ts",
        layer: "Domain",
        level: "warning",
        message: "w2",
      });

      const session = store.getSessionSummary("s1");
      expect(session).not.toBeNull();
      expect(session!.warningCount).toBe(2);
      expect(session!.blockCount).toBe(1);
    });

    it("returns null for unknown sessions", () => {
      expect(store.getSessionSummary("nonexistent")).toBeNull();
    });
  });

  describe("health summary", () => {
    it("aggregates across sessions", async () => {
      await store.recordViolation({
        sessionKey: "s1",
        filePath: "src/config/a.ts",
        layer: "Domain",
        level: "warning",
        message: "w1",
      });
      await store.recordViolation({
        sessionKey: "s2",
        filePath: "src/config/b.ts",
        layer: "Domain",
        level: "block",
        message: "b1",
      });
      await store.getOrIncrementStrike("src/config/a.ts");

      const health = store.getHealthSummary();
      expect(health.totalViolations).toBe(2);
      expect(health.totalWarnings).toBe(1);
      expect(health.totalBlocks).toBe(1);
      expect(health.filesWithStrikes).toBe(1);
    });
  });

  describe("maintenance", () => {
    it("prunes old violations", async () => {
      for (let i = 0; i < 10; i++) {
        await store.recordViolation({
          sessionKey: "s1",
          filePath: `src/config/${i}.ts`,
          layer: "Domain",
          level: "warning",
          message: `violation ${i}`,
        });
      }
      const pruned = await store.pruneViolations(5);
      expect(pruned).toBe(5);
      expect(store.getRecentViolations("s1", 20)).toHaveLength(5);
    });

    it("clears all data", async () => {
      await store.recordViolation({
        sessionKey: "s1",
        filePath: "src/config/a.ts",
        layer: "Domain",
        level: "warning",
        message: "w1",
      });
      await store.getOrIncrementStrike("src/config/a.ts");
      await store.clear();

      expect(store.getRecentViolations("s1")).toHaveLength(0);
      expect(store.getStrikeCount("src/config/a.ts")).toBe(0);
      expect(store.getSessionSummary("s1")).toBeNull();
    });
  });
});
