import { describe, beforeEach, expect, it } from "vitest";
import {
  evaluateToolCall,
  buildAuditSummary,
  resetPolicyStateForTest,
  clearStrikesForFile,
  setConfigForTest,
  __testing,
} from "./joy-zoning.policy.js";

describe("JoyZoning Policy Engine", () => {
  beforeEach(() => {
    resetPolicyStateForTest();
  });

  describe("evaluateToolCall — path validation", () => {
    it("returns null for non-file-modifying tools", async () => {
      expect(
        await evaluateToolCall({ toolName: "read", filePath: "/w/src/agents/foo.ts" }),
      ).toBeNull();
    });

    it("returns null for paths outside src/", async () => {
      expect(await evaluateToolCall({ toolName: "write", filePath: "/w/package.json" })).toBeNull();
    });

    it("detects Domain -> Core via import paths", async () => {
      const result = await evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        importPaths: ["/w/src/agents/pi-tools.ts"],
        sessionKey: "s1",
      });
      expect(result).not.toBeNull();
      expect(result!.level).toBe("block");
      expect(result!.sourceLayer).toBe("Domain");
    });

    it("detects Core -> UI via import paths", async () => {
      const result = await evaluateToolCall({
        toolName: "edit",
        filePath: "/w/src/agents/runner.ts",
        importPaths: ["/w/src/slack/api.ts"],
        sessionKey: "s1",
      });
      expect(result).not.toBeNull();
      expect(result!.sourceLayer).toBe("Core");
      expect(result!.targetLayer).toBe("UI");
    });

    it("allows valid dependencies", async () => {
      expect(
        await evaluateToolCall({
          toolName: "write",
          filePath: "/w/src/agents/runner.ts",
          importPaths: ["/w/src/utils/helpers.ts"],
          sessionKey: "s1",
        }),
      ).toBeNull();
    });
  });

  describe("evaluateToolCall — content validation", () => {
    it("detects 'any' type in Domain content", async () => {
      const result = await evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: "const x: any = 1;",
        sessionKey: "s1",
      });
      expect(result).not.toBeNull();
      expect(result!.level).toBe("warning"); // Domain 'any' is a discernment warning
      expect(result!.violations).toBeDefined();
      expect(result!.correctionHint).toBeDefined();
    });

    it("detects cross-layer imports in Domain content", async () => {
      const result = await evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: 'import { db } from "../infra/db.js"',
        sessionKey: "s1",
      });
      expect(result).not.toBeNull();
      expect(result!.level).toBe("block");
      expect(result!.violations!.some((v) => v.includes("Infrastructure"))).toBe(true);
    });

    it("warns when new file content doesn't match location", async () => {
      const result = await evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/slack/db-adapter.ts",
        content: 'import fs from "node:fs"; export function readFile() {}',
        sessionKey: "s1",
      });
      expect(result).not.toBeNull();
      expect(result!.level).toBe("warning");
      expect(result!.message).toContain("looks like it belongs");
    });

    it("passes clean Domain code", async () => {
      expect(
        await evaluateToolCall({
          toolName: "write",
          filePath: "/w/src/config/settings.ts",
          content: "export interface Config { name: string; }",
          sessionKey: "s1",
        }),
      ).toBeNull();
    });
  });

  describe("strike-based progressive enforcement", () => {
    it("blocks Domain content violation on first strike", async () => {
      const result = await evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: 'import { db } from "../infra/db.js"',
        sessionKey: "s-strike",
      });
      expect(result!.level).toBe("block");
      expect(result!.message).toContain("ARCHITECTURAL CORRECTION REQUIRED");
    });

    it("degrades to warning on second strike (same file)", async () => {
      await evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: 'import { db } from "../infra/db.js"',
        sessionKey: "s-strike",
      });
      const result = await evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: 'import { db2 } from "../infra/db.js"',
        sessionKey: "s-strike",
      });
      expect(result!.level).toBe("warning");
      expect(result!.message).toContain("Strike 2");
    });

    it("non-Domain content violations are always warnings", async () => {
      const result = await evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/infra/adapter.ts",
        content: "const x: any = 1;",
        sessionKey: "s-infra",
      });
      expect(result!.level).toBe("warning");
    });
  });

  describe("clearStrikesForFile", () => {
    it("resets strike count for a file", async () => {
      await evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: 'import { db } from "../infra/db.js"',
        sessionKey: "s-clear",
      });
      clearStrikesForFile("s-clear", "/w/src/config/settings.ts");
      // Next violation should be strike 1 again (block)
      const result = await evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: 'import { db2 } from "../infra/db.js"',
        sessionKey: "s-clear",
      });
      expect(result!.level).toBe("block");
      expect(result!.message).toContain("ARCHITECTURAL CORRECTION REQUIRED");
    });
  });

  describe("progressive path enforcement", () => {
    it("escalates warnings to blocks after threshold", async () => {
      const sessionKey = "s-escalation";
      for (let i = 0; i < __testing.MAX_WARNINGS_BEFORE_BLOCK; i++) {
        const result = await evaluateToolCall({
          toolName: "write",
          filePath: `/w/src/agents/handler-${i}.ts`, // Use Core layer for escalation
          importPaths: ["/w/src/slack/api.ts"], // Core -> UI is a violation
          sessionKey,
        });
        expect(result!.level).toBe("warning");
      }
      // Next should be a block
      const result = await evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/agents/handler-final.ts",
        importPaths: ["/w/src/slack/api.ts"],
        sessionKey,
      });
      expect(result!.level).toBe("block");
    });
  });

  describe("buildAuditSummary", () => {
    it("includes layer guide", () => {
      const summary = buildAuditSummary();
      expect(summary).toContain("JOY-ZONING");
      expect(summary).toContain("DOMAIN");
      expect(summary).toContain("CORE");
      expect(summary).toContain("INFRASTRUCTURE");
      expect(summary).toContain("PLUMBING");
      expect(summary).toContain("Dependency Flow");
      expect(summary).toContain("Violations Are Detected");
    });

    it("includes session audit when violations exist", async () => {
      await evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/agents/handler.ts",
        importPaths: ["/w/src/slack/api.ts"],
        sessionKey: "s-audit",
      });
      const summary = buildAuditSummary("s-audit");
      expect(summary).toContain("Current Session Audit");
      expect(summary).toContain("Warnings: 1");
    });

    it("shows strike count in session audit", async () => {
      await evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: 'import { db } from "../infra/db.js"',
        sessionKey: "s-strikes-audit",
      });
      const summary = buildAuditSummary("s-strikes-audit");
      expect(summary).toContain("Files with strikes: 1");
    });
  });

  describe("config-aware behavior", () => {
    beforeEach(() => {
      setConfigForTest(null); // Reset to default
    });

    it("returns null when config.enabled is false", async () => {
      setConfigForTest({ enabled: false });
      const result = await evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: "const x: any = 1;",
        sessionKey: "s-disabled",
      });
      expect(result).toBeNull();
    });

    it("downgrades blocks to warnings when strictness is 'advisory'", async () => {
      setConfigForTest({ strictness: "advisory" });
      const result = await evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: 'import { db } from "../infra/db.js"',
        sessionKey: "s-advisory",
      });
      expect(result).not.toBeNull();
      expect(result!.level).toBe("warning"); // Would normally be "block"
    });

    it("upgrades warnings to blocks when strictness is 'strict'", async () => {
      setConfigForTest({ strictness: "strict" });
      const result = await evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/infra/adapter.ts",
        importPaths: ["/w/src/slack/api.ts"], // Infrastructure -> UI is a violation
        sessionKey: "s-strict",
      });
      expect(result).not.toBeNull();
      expect(result!.level).toBe("block"); // Would normally be "warning"
    });
  });
});
