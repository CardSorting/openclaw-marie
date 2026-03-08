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
    it("returns null for non-file-modifying tools", () => {
      expect(evaluateToolCall({ toolName: "read", filePath: "/w/src/agents/foo.ts" })).toBeNull();
    });

    it("returns null for paths outside src/", () => {
      expect(evaluateToolCall({ toolName: "write", filePath: "/w/package.json" })).toBeNull();
    });

    it("detects Domain -> Core via import paths", () => {
      const result = evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        importPaths: ["/w/src/agents/pi-tools.ts"],
        sessionKey: "s1",
      });
      expect(result).not.toBeNull();
      expect(result!.level).toBe("block");
      expect(result!.sourceLayer).toBe("Domain");
    });

    it("detects Core -> UI via import paths", () => {
      const result = evaluateToolCall({
        toolName: "edit",
        filePath: "/w/src/agents/runner.ts",
        importPaths: ["/w/src/slack/api.ts"],
        sessionKey: "s1",
      });
      expect(result).not.toBeNull();
      expect(result!.sourceLayer).toBe("Core");
      expect(result!.targetLayer).toBe("UI");
    });

    it("allows valid dependencies", () => {
      expect(
        evaluateToolCall({
          toolName: "write",
          filePath: "/w/src/agents/runner.ts",
          importPaths: ["/w/src/utils/helpers.ts"],
          sessionKey: "s1",
        }),
      ).toBeNull();
    });
  });

  describe("evaluateToolCall — content validation", () => {
    it("detects 'any' type in Domain content", () => {
      const result = evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: "const x: any = 1;",
        sessionKey: "s1",
      });
      expect(result).not.toBeNull();
      expect(result!.level).toBe("block"); // Domain first strike = block
      expect(result!.violations).toBeDefined();
      expect(result!.correctionHint).toBeDefined();
    });

    it("detects cross-layer imports in Domain content", () => {
      const result = evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: 'import { db } from "../infra/db.js"',
        sessionKey: "s1",
      });
      expect(result).not.toBeNull();
      expect(result!.violations!.some((v) => v.includes("Infrastructure"))).toBe(true);
    });

    it("warns when new file content doesn't match location", () => {
      const result = evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/slack/db-adapter.ts",
        content: 'import fs from "node:fs"; export function readFile() {}',
        sessionKey: "s1",
      });
      expect(result).not.toBeNull();
      expect(result!.level).toBe("warning");
      expect(result!.message).toContain("looks like it belongs");
    });

    it("passes clean Domain code", () => {
      expect(
        evaluateToolCall({
          toolName: "write",
          filePath: "/w/src/config/settings.ts",
          content: "export interface Config { name: string; }",
          sessionKey: "s1",
        }),
      ).toBeNull();
    });
  });

  describe("strike-based progressive enforcement", () => {
    it("blocks Domain content violation on first strike", () => {
      const result = evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: "const x: any = 1;",
        sessionKey: "s-strike",
      });
      expect(result!.level).toBe("block");
      expect(result!.message).toContain("Strike 1");
    });

    it("degrades to warning on second strike (same file)", () => {
      evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: "const x: any = 1;",
        sessionKey: "s-strike",
      });
      const result = evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: "const y: any = 2;",
        sessionKey: "s-strike",
      });
      expect(result!.level).toBe("warning");
      expect(result!.message).toContain("Strike 2");
    });

    it("non-Domain content violations are always warnings", () => {
      const result = evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/infra/adapter.ts",
        content: "const x: any = 1;",
        sessionKey: "s-infra",
      });
      expect(result!.level).toBe("warning");
    });
  });

  describe("clearStrikesForFile", () => {
    it("resets strike count for a file", () => {
      evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: "const x: any = 1;",
        sessionKey: "s-clear",
      });
      clearStrikesForFile("s-clear", "/w/src/config/settings.ts");
      // Next violation should be strike 1 again (block)
      const result = evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: "const y: any = 2;",
        sessionKey: "s-clear",
      });
      expect(result!.level).toBe("block");
      expect(result!.message).toContain("Strike 1");
    });
  });

  describe("progressive path enforcement", () => {
    it("escalates warnings to blocks after threshold", () => {
      const sessionKey = "s-escalation";
      for (let i = 0; i < __testing.MAX_WARNINGS_BEFORE_BLOCK; i++) {
        const result = evaluateToolCall({
          toolName: "write",
          filePath: `/w/src/slack/handler-${i}.ts`,
          importPaths: ["/w/src/infra/db.ts"],
          sessionKey,
        });
        expect(result!.level).toBe("warning");
      }
      // Next should be a block
      const result = evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/slack/handler-final.ts",
        importPaths: ["/w/src/infra/db.ts"],
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

    it("includes session audit when violations exist", () => {
      evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/slack/handler.ts",
        importPaths: ["/w/src/infra/db.ts"],
        sessionKey: "s-audit",
      });
      const summary = buildAuditSummary("s-audit");
      expect(summary).toContain("Current Session Audit");
      expect(summary).toContain("Warnings: 1");
    });

    it("shows strike count in session audit", () => {
      evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: "const x: any = 1;",
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

    it("returns null when config.enabled is false", () => {
      setConfigForTest({ enabled: false });
      const result = evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: "const x: any = 1;",
        sessionKey: "s-disabled",
      });
      expect(result).toBeNull();
    });

    it("downgrades blocks to warnings when strictness is 'advisory'", () => {
      setConfigForTest({ strictness: "advisory" });
      const result = evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/config/settings.ts",
        content: "const x: any = 1;",
        sessionKey: "s-advisory",
      });
      expect(result).not.toBeNull();
      expect(result!.level).toBe("warning"); // Would normally be "block"
    });

    it("upgrades warnings to blocks when strictness is 'strict'", () => {
      setConfigForTest({ strictness: "strict" });
      const result = evaluateToolCall({
        toolName: "write",
        filePath: "/w/src/infra/adapter.ts",
        content: "const x: any = 1;",
        sessionKey: "s-strict",
      });
      expect(result).not.toBeNull();
      expect(result!.level).toBe("block"); // Would normally be "warning"
    });
  });
});
