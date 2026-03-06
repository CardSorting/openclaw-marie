
import { describe, it, expect, beforeEach } from "vitest";
import { validateJoyZoning, detectCrossLayerImports } from "../src/utils/joy-zoning.js";
import { evaluateToolCall, setStoreForTest } from "../src/agents/joy-zoning.policy.ts";
import { createInMemoryStore } from "../src/infra/joy-zoning-store.js";

describe("Joy-Zoning Sovereign Integrity (Phase 9)", () => {
  let store: any;

  beforeEach(() => {
    store = createInMemoryStore();
    setStoreForTest(store);
  });

  describe("Zero-Value Thresholds (Domain Purity)", () => {
    it("should allow 'import type' from Infrastructure into Domain", () => {
      const content = "import type { DBClient } from '../infra/db';";
      const violations = detectCrossLayerImports(content, "Domain");
      expect(violations).toHaveLength(0);
    });

    it("should block concrete 'import' from Infrastructure into Domain", () => {
      const content = "import { DBClient } from '../infra/db';";
      const violations = detectCrossLayerImports(content, "Domain");
      expect(violations).toContain("DOMAIN PURITY: Domain layer cannot import concrete values from Infrastructure. Use 'import type' and dependency inversion.");
    });

    it("should block concrete 'import' from UI into Domain", () => {
      const content = "import { Button } from '../ui/components';";
      const violations = detectCrossLayerImports(content, "Domain");
      expect(violations[0]).toMatch(/DOMAIN PURITY: Domain layer cannot import concrete values from UI/);
    });
  });

  describe("Graph-Based Circularity Detection", () => {
    it("should detect direct self-cycles", () => {
      const cycle = store.detectCycle("src/domain/a.ts", "src/domain/a.ts");
      expect(cycle).toEqual(["src/domain/a.ts", "src/domain/a.ts"]);
    });

    it("should detect complex 3-file cycles (A -> B -> C -> A)", () => {
      store.recordDependency("src/domain/a.ts", "src/domain/b.ts");
      store.recordDependency("src/domain/b.ts", "src/domain/c.ts");
      
      const cycle = store.detectCycle("src/domain/c.ts", "src/domain/a.ts");
      expect(cycle).toEqual(["src/domain/c.ts", "src/domain/a.ts", "src/domain/b.ts", "src/domain/c.ts"]);
    });

    it("should block tool calls that create cycles", () => {
      store.recordDependency("src/domain/a.ts", "src/domain/b.ts");
      
      const res = evaluateToolCall({
        toolName: "edit",
        filePath: "src/domain/b.ts",
        importPaths: ["src/domain/a.ts"],
        sessionKey: "cycle-test"
      });

      expect(res?.level).toBe("block");
      expect(res?.message).toContain("ARCHITECTURAL CYCLE");
    });
  });

  describe("Enriched attribution", () => {
    it("should store agentId and thought snippets in violations", () => {
      evaluateToolCall({
        toolName: "edit",
        filePath: "src/domain/logic.ts",
        content: "import { raw } from '../infra/db';", // Content violation
        sessionKey: "attr-test",
        agentId: "agent-007",
        thought: "I need this db connection directly for speed."
      });

      const violations = store.getRecentViolations("attr-test");
      expect(violations[0].agentId).toBe("agent-007");
      expect(violations[0].thoughtSnippet).toBe("I need this db connection directly for speed.");
    });
  });

  describe("Hardening regressions (Phases 5-8)", () => {
    it("should respect [JZ:OVERRIDE] break-glass", () => {
      const res = evaluateToolCall({
        toolName: "edit",
        filePath: "src/domain/logic.ts",
        content: "import { raw } from '../infra/db';", 
        sessionKey: "override-test",
        thought: "I know this is bad but [JZ:OVERRIDE] I am in a hurry."
      });

      expect(res?.level).toBe("warning");
      expect(res?.message).toContain("[CRITICAL OVERRIDE]");
    });

    it("should flag Mega-Files (> 500 lines)", () => {
      const megaContent = "// line\n".repeat(501);
      const res = validateJoyZoning("src/domain/big.ts", megaContent);
      expect(res.errors.some(e => e.includes("Mega-File"))).toBe(true);
    });
  });

  describe("Phase 10: Absolute Perimeter & Self-Preservation", () => {
    describe("Self-Preservation", () => {
      it("should block modification of Joy-Zoning policy", () => {
        const res = evaluateToolCall({
          toolName: "edit",
          filePath: "src/agents/joy-zoning.policy.ts",
          content: "console.log('tampered');",
          sessionKey: "test-self"
        });
        expect(res?.level).toBe("block");
        expect(res?.message).toContain("SELF-PRESERVATION");
      });

      it("should block modification of Joy-Zoning store", () => {
        const res = evaluateToolCall({
          toolName: "edit",
          filePath: "src/infra/joy-zoning-store.ts",
          content: "DELETE FROM jz_violations;",
          sessionKey: "test-self"
        });
        expect(res?.level).toBe("block");
        expect(res?.message).toContain("SELF-PRESERVATION");
      });
    });

    describe("Destruction Prevention", () => {
      it("should block deletion of files in Domain layer", () => {
        const res = evaluateToolCall({
          toolName: "delete_file",
          filePath: "src/domain/critical-logic.ts",
          sessionKey: "test-delete"
        });
        expect(res?.level).toBe("block");
        expect(res?.message).toContain("DESTRUCTION PREVENTION");
      });

      it("should block deletion of files in Core layer", () => {
        const res = evaluateToolCall({
          toolName: "remove_file",
          filePath: "src/core/agent-orchestrator.ts",
          sessionKey: "test-delete"
        });
        expect(res?.level).toBe("block");
        expect(res?.message).toContain("DESTRUCTION PREVENTION");
      });

      it("should allow deletion of files in UI layer (low-risk)", () => {
        const res = evaluateToolCall({
          toolName: "delete_file",
          filePath: "src/ui/old-button.tsx",
          sessionKey: "test-delete"
        });
        expect(res).toBeNull();
      });
    });

    describe("Bash Interception", () => {
      it("should block destructive rm commands via bash", () => {
        const res = evaluateToolCall({
          toolName: "bash",
          command: "rm -rf src/domain",
          sessionKey: "test-bash"
        } as any);
        expect(res?.level).toBe("block");
        expect(res?.message).toContain("DESTRUCTIVE BASH INTERCEPTED");
      });

      it("should block sneaky moves via bash", () => {
        const res = evaluateToolCall({
          toolName: "run_command",
          command: "mv src/domain/Logic.ts src/plumbing/Logic.ts",
          sessionKey: "test-bash"
        } as any);
        expect(res?.level).toBe("block");
        expect(res?.message).toContain("DESTRUCTIVE BASH INTERCEPTED");
      });
    });

    describe("Multilateral Path Validation (Rename/Move)", () => {
      it("should block moving Domain files to lower layers (Layer Evasion)", () => {
        const res = evaluateToolCall({
          toolName: "move",
          filePath: "src/domain/MyPolicy.ts",
          newPath: "src/infrastructure/MyPolicy.ts",
          sessionKey: "test-move"
        });
        expect(res?.level).toBe("block");
        expect(res?.message).toContain("LAYER EVASION");
      });

      it("should allow moving within the same layer", () => {
        const res = evaluateToolCall({
          toolName: "rename",
          filePath: "src/domain/OldName.ts",
          newPath: "src/domain/NewName.ts",
          sessionKey: "test-move"
        });
        expect(res).toBeNull();
      });
    });
  });

  describe("Phase 11: Ultimate Resilience", () => {
    describe("Regex evasion prevention", () => {
      it("should block multi-line concrete imports", () => {
        const content = `import {
          DBClient
        } from '../infra/db';`;
        const violations = detectCrossLayerImports(content, "Domain");
        expect(violations).toContain("DOMAIN PURITY: Domain layer cannot import concrete values from Infrastructure. Use 'import type' and dependency inversion.");
      });

      it("should block dynamic import() from forbidden layers", () => {
        const content = "const db = await import('../infra/db');";
        const violations = detectCrossLayerImports(content, "Domain");
        expect(violations).toContain("DOMAIN PURITY: Dynamic imports or 'require' from Infrastructure are blocked in Domain.");
      });

      it("should block require() from forbidden layers", () => {
        const content = "const fs = require('../infra/fs-adapter');";
        const violations = detectCrossLayerImports(content, "Domain");
        expect(violations).toContain("DOMAIN PURITY: Dynamic imports or 'require' from Infrastructure are blocked in Domain.");
      });
      
      it("should handle imports with unusual whitespace and comments", () => {
        const content = "import /* bypass attempt */ { val } from \n\n '../infra/db'";
        const violations = detectCrossLayerImports(content, "Domain");
        expect(violations).toHaveLength(1);
      });
    });

    describe("Architectural Quarantine", () => {
      it("should block imports into CORE if target has > 10 strikes", () => {
        const infraPath = "src/infra/leaky-adapter.ts";
        for (let i = 0; i < 11; i++) {
          store.getOrIncrementStrike(infraPath, "Leaking state");
        }
        
        const res = evaluateToolCall({
          toolName: "edit",
          filePath: "src/agents/Orchestrator.ts", 
          importPaths: [infraPath],
          sessionKey: "quarantine-test"
        });

        expect(res?.level).toBe("block");
        expect(res?.message).toContain("ARCHITECTURAL QUARANTINE");
      });
    });

    describe("High-Concurrency Persistence (Busy-Retry)", () => {
      it("should survive 50 rapid-fire concurrent violations without SQLITE_BUSY failure", async () => {
        const tasks = Array.from({ length: 50 }).map((_, i) => {
          return new Promise((resolve) => {
            setTimeout(() => {
               const res = evaluateToolCall({
                  toolName: "edit",
                  filePath: `src/domain/file-${i}.ts`,
                  content: ": any",
                  sessionKey: "concurrency-session",
                  agentId: `agent-${i}`
               });
               resolve(res);
            }, Math.random() * 50);
          });
        });

        const results = await Promise.all(tasks);
        expect(results.every(r => r !== null)).toBe(true);
        
        const summary = store.getSessionSummary("concurrency-session");
        expect(summary.blockCount).toBe(50);
      }, 10000);
    });
  });
});
