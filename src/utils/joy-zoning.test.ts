import { describe, expect, it } from "vitest";
import {
  getLayer,
  validateDependency,
  validateSmells,
  detectCrossLayerImports,
  validateJoyZoning,
  suggestLayerForContent,
  getTargetPath,
  getFileLayerContext,
  getCorrectionHint,
} from "./joy-zoning.js";

describe("JoyZoning Utility", () => {
  describe("getLayer", () => {
    it("maps agent paths to Core", () => {
      expect(getLayer("src/agents/pi-tools.ts")).toBe("Core");
      expect(getLayer("src/agents/pi-embedded-runner/run.ts")).toBe("Core");
    });

    it("maps specific policy files to Domain", () => {
      expect(getLayer("src/agents/pi-tools.policy.ts")).toBe("Domain");
      expect(getLayer("src/agents/joy-zoning.policy.ts")).toBe("Domain");
    });

    it("maps config/types to Domain", () => {
      expect(getLayer("src/config/config.ts")).toBe("Domain");
      expect(getLayer("src/types/tools.ts")).toBe("Domain");
    });

    it("maps infra paths to Infrastructure", () => {
      expect(getLayer("src/infra/db.ts")).toBe("Infrastructure");
      expect(getLayer("src/browser/launch.ts")).toBe("Infrastructure");
      expect(getLayer("src/gateway/server.ts")).toBe("Infrastructure");
      expect(getLayer("src/providers/openai.ts")).toBe("Infrastructure");
      expect(getLayer("src/secrets/vault.ts")).toBe("Infrastructure");
    });

    it("maps channel paths to UI", () => {
      expect(getLayer("src/slack/client.ts")).toBe("UI");
      expect(getLayer("src/telegram/bot.ts")).toBe("UI");
      expect(getLayer("src/discord/gateway.ts")).toBe("UI");
      expect(getLayer("src/tui/render.ts")).toBe("UI");
      expect(getLayer("src/cli/main.ts")).toBe("UI");
      expect(getLayer("src/channels/web.ts")).toBe("UI");
      expect(getLayer("src/whatsapp/handler.ts")).toBe("UI");
      expect(getLayer("src/signal/listener.ts")).toBe("UI");
    });

    it("maps utils/logging to Plumbing", () => {
      expect(getLayer("src/utils/joy-zoning.ts")).toBe("Plumbing");
      expect(getLayer("src/logging/subsystem.ts")).toBe("Plumbing");
      expect(getLayer("src/shared/helpers.ts")).toBe("Plumbing");
      expect(getLayer("src/utils.ts")).toBe("Plumbing");
      expect(getLayer("src/logger.ts")).toBe("Plumbing");
      expect(getLayer("src/markdown/render.ts")).toBe("Plumbing");
    });

    it("defaults to Core for unknown src paths", () => {
      expect(getLayer("src/unknown-dir/foo.ts")).toBe("Core");
    });

    it("defaults to Plumbing for non-src paths", () => {
      expect(getLayer("package.json")).toBe("Plumbing");
      expect(getLayer("scripts/build.ts")).toBe("Plumbing");
    });
  });

  describe("validateDependency", () => {
    it("blocks Domain -> Core", () => {
      const result = validateDependency("src/config/config.ts", "src/agents/pi-tools.ts");
      expect(result).toContain("Domain layer");
      expect(result).toContain("should not depend on Core");
    });

    it("blocks Domain -> Infrastructure", () => {
      const result = validateDependency("src/config/config.ts", "src/infra/db.ts");
      expect(result).toContain("Domain layer");
      expect(result).toContain("Infrastructure");
    });

    it("blocks Domain -> UI", () => {
      const result = validateDependency("src/config/config.ts", "src/slack/client.ts");
      expect(result).toContain("Domain layer");
      expect(result).toContain("UI");
    });

    it("allows Domain -> Plumbing", () => {
      expect(validateDependency("src/config/config.ts", "src/utils/helpers.ts")).toBeNull();
    });

    it("blocks Core -> UI", () => {
      const result = validateDependency("src/agents/pi-tools.ts", "src/slack/client.ts");
      expect(result).toContain("Core layer");
      expect(result).toContain("UI");
    });

    it("allows Core -> Infrastructure", () => {
      expect(validateDependency("src/agents/pi-tools.ts", "src/infra/db.ts")).toBeNull();
    });

    it("blocks Infrastructure -> UI", () => {
      const result = validateDependency("src/infra/fetch.ts", "src/slack/client.ts");
      expect(result).toContain("Infrastructure layer");
      expect(result).toContain("UI");
    });

    it("warns UI -> Infrastructure", () => {
      const result = validateDependency("src/slack/client.ts", "src/infra/db.ts");
      expect(result).toContain("Architectural Smell");
    });

    it("allows UI -> Core", () => {
      expect(validateDependency("src/slack/client.ts", "src/agents/pi-tools.ts")).toBeNull();
    });

    it("blocks Plumbing -> Domain", () => {
      const result = validateDependency("src/utils/helpers.ts", "src/config/config.ts");
      expect(result).toContain("Plumbing layer");
      expect(result).toContain("Domain");
    });

    it("blocks Plumbing -> Core", () => {
      const result = validateDependency("src/utils/helpers.ts", "src/agents/pi-tools.ts");
      expect(result).toContain("Plumbing layer");
      expect(result).toContain("Core");
    });

    it("allows same-layer dependencies", () => {
      expect(validateDependency("src/agents/a.ts", "src/agents/b.ts")).toBeNull();
    });
  });

  describe("validateSmells", () => {
    it("detects multiple classes in Domain", () => {
      const errors = validateSmells("src/config/models.ts", "class Foo {} class Bar {}");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Multiple classes");
    });

    it("ignores multiple classes outside Domain", () => {
      expect(validateSmells("src/agents/runner.ts", "class Foo {} class Bar {}")).toHaveLength(0);
    });

    it("detects 'any' in Domain", () => {
      const errors = validateSmells("src/config/models.ts", "const x: any = 1");
      expect(errors.some((e) => e.includes("'any' type"))).toBe(true);
    });

    it("detects 'any' in Infrastructure", () => {
      const errors = validateSmells("src/infra/db.ts", "function get(): any {}");
      expect(errors.some((e) => e.includes("'any' type"))).toBe(true);
    });

    it("ignores 'any' in Core", () => {
      expect(validateSmells("src/agents/runner.ts", "const x: any = 1")).toHaveLength(0);
    });

    it("detects forbidden I/O calls in Domain", () => {
      const errors = validateSmells("src/config/loader.ts", 'import fs from "fs"; fs.readFile()');
      expect(errors.some((e) => e.includes("Forbidden call"))).toBe(true);
    });
  });

  describe("detectCrossLayerImports", () => {
    it("detects Domain importing Infrastructure", () => {
      const violations = detectCrossLayerImports('import { db } from "../infra/db.js"', "Domain");
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("Infrastructure");
    });

    it("detects Domain importing UI", () => {
      const violations = detectCrossLayerImports(
        'import { render } from "../slack/render.js"',
        "Domain",
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("UI");
    });

    it("detects Domain platform leakage", () => {
      const violations = detectCrossLayerImports('import fs from "node:fs"', "Domain");
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("PLATFORM LEAKAGE");
    });

    it("detects Plumbing importing application layers", () => {
      const violations = detectCrossLayerImports(
        'import { foo } from "../agents/bar.js"',
        "Plumbing",
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("zero dependencies");
    });

    it("detects Infrastructure importing UI", () => {
      const violations = detectCrossLayerImports(
        'import { sendMsg } from "../telegram/bot.js"',
        "Infrastructure",
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("Infrastructure layer cannot import from UI");
    });

    it("allows Core importing Infrastructure", () => {
      expect(detectCrossLayerImports('import { db } from "../infra/db.js"', "Core")).toHaveLength(
        0,
      );
    });
  });

  describe("validateJoyZoning", () => {
    it("combines smell and cross-layer errors", () => {
      const result = validateJoyZoning(
        "src/config/models.ts",
        'const x: any = 1;\nimport { db } from "../infra/db.js"',
      );
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });

    it("passes clean Domain code", () => {
      const result = validateJoyZoning(
        "src/config/models.ts",
        "export interface Config { name: string; }",
      );
      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("suggestLayerForContent", () => {
    it("suggests UI for React content", () => {
      const result = suggestLayerForContent('import React from "react"');
      expect(result).not.toBeNull();
      expect(result!.layer).toBe("UI");
    });

    it("suggests Infrastructure for I/O content", () => {
      const result = suggestLayerForContent('import fs from "node:fs"');
      expect(result).not.toBeNull();
      expect(result!.layer).toBe("Infrastructure");
    });

    it("suggests Plumbing for stateless exports", () => {
      const result = suggestLayerForContent(
        "export function formatDate(d: Date) { return d.toISOString(); }",
      );
      expect(result).not.toBeNull();
      expect(result!.layer).toBe("Plumbing");
    });

    it("returns null when uncertain", () => {
      expect(suggestLayerForContent("class MyService { private db; }")).toBeNull();
    });
  });

  describe("getTargetPath", () => {
    it("extracts from 'path'", () => {
      expect(getTargetPath({ path: "/foo/bar.ts" })).toBe("/foo/bar.ts");
    });

    it("extracts from 'file_path'", () => {
      expect(getTargetPath({ file_path: "/foo/bar.ts" })).toBe("/foo/bar.ts");
    });

    it("extracts from 'absolutePath'", () => {
      expect(getTargetPath({ absolutePath: "/foo/bar.ts" })).toBe("/foo/bar.ts");
    });

    it("returns null for missing params", () => {
      expect(getTargetPath(null)).toBeNull();
      expect(getTargetPath(undefined)).toBeNull();
      expect(getTargetPath({})).toBeNull();
    });
  });

  describe("getFileLayerContext", () => {
    it("returns Domain context", () => {
      expect(getFileLayerContext("src/config/config.ts")).toContain("DOMAIN");
    });

    it("returns Core context", () => {
      expect(getFileLayerContext("src/agents/runner.ts")).toContain("CORE");
    });

    it("returns Plumbing context", () => {
      expect(getFileLayerContext("src/utils/helpers.ts")).toContain("PLUMBING");
    });
  });

  describe("getCorrectionHint", () => {
    it("generates fix for import violations", () => {
      const hint = getCorrectionHint(["Domain layer should not depend on Infrastructure"]);
      expect(hint).toContain("Move the import");
    });

    it("generates fix for 'any' types", () => {
      const hint = getCorrectionHint(["'any' type detected"]);
      expect(hint).toContain("typed interface");
    });

    it("deduplicates fixes", () => {
      const hint = getCorrectionHint(["import error A", "import error B"]);
      expect(hint.match(/Move the import/g)?.length).toBe(1);
    });
  });
});
