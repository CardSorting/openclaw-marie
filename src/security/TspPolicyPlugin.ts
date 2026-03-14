import ts from "typescript";

export type JoyZoningLayer = "Domain" | "Core" | "Infrastructure" | "UI" | "Plumbing";

export interface TspViolation {
  message: string;
  line: number;
  character: number;
  nodeText: string;
  severity: "block" | "warning";
}

export class TspPolicyPlugin {
  private static readonly NODE_BUILTINS = new Set([
    "fs",
    "path",
    "os",
    "child_process",
    "http",
    "https",
    "net",
    "dgram",
    "cluster",
    "crypto",
    "stream",
    "buffer",
    "url",
    "util",
    "vm",
    "v8",
    "worker_threads",
  ]);

  private static readonly INFRA_PATHS = [
    "infra",
    "infrastructure",
    "browser",
    "gateway",
    "providers",
    "secrets",
    "security",
    "web",
  ];

  private static readonly UI_PATHS = [
    "ui",
    "slack",
    "telegram",
    "discord",
    "tui",
    "channels",
    "terminal",
    "cli",
    "whatsapp",
    "imessage",
    "line",
    "signal",
    "wizard",
  ];

  private static readonly APP_PATHS = [
    "agents",
    "config",
    "types",
    ...TspPolicyPlugin.INFRA_PATHS,
    ...TspPolicyPlugin.UI_PATHS,
  ];

  /**
   * Performs deep AST-based audit of TypeScript source code for architectural violations.
   */
  public audit(filePath: string, content: string, layer: JoyZoningLayer): TspViolation[] {
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const violations: TspViolation[] = [];

    const visit = (node: ts.Node) => {
      // 1. Check Imports/Exports
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        this.checkImportExport(node, sourceFile, layer, violations);
      }

      // 2. Dependency Inversion: Domain should prefer Interfaces/Types for external use
      if (layer === "Domain" && ts.isClassDeclaration(node) && this.isExported(node)) {
        const hasInterface = this.hasImplementedInterface(node);
        if (!hasInterface) {
          violations.push(
            this.createViolation(
              node,
              sourceFile,
              `⚠️ ARCHITECTURAL SMELL: Exported class in Domain should implement an interface for Dependency Inversion.`,
              "warning",
            ),
          );
        }
      }

      // 3. Export Control: Infrastructure should not export concrete classes to Domain
      if (layer === "Infrastructure" && ts.isClassDeclaration(node) && this.isExported(node)) {
        violations.push(
          this.createViolation(
            node,
            sourceFile,
            `INFRASTRUCTURE ISOLATION: Concrete class '${node.name?.getText(sourceFile)}' is exported. Ensure Domain only interacts via interfaces.`,
            "warning",
          ),
        );
      }

      // 4. Check for 'any' type in Domain/Infrastructure
      if (layer === "Domain" || layer === "Infrastructure") {
        if (ts.isTypeReferenceNode(node) && node.getText(sourceFile) === "any") {
          violations.push(
            this.createViolation(
              node,
              sourceFile,
              `⚠️ DISCERNMENT WARNING: 'any' type detected — use a typed interface or generic.`,
              "warning",
            ),
          );
        }
        if (node.kind === ts.SyntaxKind.AnyKeyword) {
          violations.push(
            this.createViolation(
              node,
              sourceFile,
              `⚠️ DISCERNMENT WARNING: 'any' type detected — use a typed interface or generic.`,
              "warning",
            ),
          );
        }
      }

      // 5. Check for forbidden I/O calls in Domain
      if (layer === "Domain") {
        if (ts.isCallExpression(node)) {
          this.checkForbiddenCalls(node, sourceFile, violations);
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);

    return violations;
  }

  private isExported(node: ts.ClassDeclaration): boolean {
    return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
  }

  private hasImplementedInterface(node: ts.ClassDeclaration): boolean {
    if (!node.heritageClauses) {
      return false;
    }
    return node.heritageClauses.some((c) => c.token === ts.SyntaxKind.ImplementsKeyword);
  }

  private checkImportExport(
    node: ts.ImportDeclaration | ts.ExportDeclaration,
    sourceFile: ts.SourceFile,
    layer: JoyZoningLayer,
    violations: TspViolation[],
  ) {
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) {
      return;
    }

    const modulePath = node.moduleSpecifier.text;
    const isTypeOnly = ts.isImportDeclaration(node)
      ? node.importClause?.isTypeOnly === true
      : node.isTypeOnly;

    // A. Domain Purity: No concrete imports from Infrastructure/UI
    if (layer === "Domain" && !isTypeOnly) {
      if (this.isMatchingPath(modulePath, TspPolicyPlugin.INFRA_PATHS)) {
        violations.push(
          this.createViolation(
            node,
            sourceFile,
            `DOMAIN PURITY: Domain layer cannot import concrete values from Infrastructure. Use 'import type' and dependency inversion.`,
          ),
        );
      }
      if (this.isMatchingPath(modulePath, TspPolicyPlugin.UI_PATHS)) {
        violations.push(
          this.createViolation(
            node,
            sourceFile,
            `DOMAIN PURITY: Domain layer cannot import concrete values from UI. Domain must be platform-agnostic (use 'import type').`,
          ),
        );
      }
    }

    // B. Platform Leakage: No Node.js builtins in Domain
    if (layer === "Domain") {
      const isBuiltin =
        modulePath.startsWith("node:") || TspPolicyPlugin.NODE_BUILTINS.has(modulePath);
      if (isBuiltin) {
        violations.push(
          this.createViolation(
            node,
            sourceFile,
            `PLATFORM LEAKAGE: Domain layer must not depend on platform-specific modules (${modulePath}).`,
          ),
        );
      }
    }

    // C. Plumbing Isolation: No dependencies on application layers
    if (layer === "Plumbing") {
      if (this.isMatchingPath(modulePath, TspPolicyPlugin.APP_PATHS)) {
        violations.push(
          this.createViolation(
            node,
            sourceFile,
            `PLUMBING ISOLATION: Plumbing/Utils should have zero dependencies on application layers (${modulePath}).`,
          ),
        );
      }
    }

    // D. Infrastructure Isolation: No imports from UI
    if (layer === "Infrastructure") {
      if (this.isMatchingPath(modulePath, TspPolicyPlugin.UI_PATHS)) {
        violations.push(
          this.createViolation(
            node,
            sourceFile,
            `INFRASTRUCTURE ISOLATION: Infrastructure layer cannot import from UI — use events or callbacks.`,
          ),
        );
      }
    }
  }

  private checkForbiddenCalls(
    node: ts.CallExpression,
    sourceFile: ts.SourceFile,
    violations: TspViolation[],
  ) {
    const expressionText = node.expression.getText(sourceFile);
    const forbiddenPatterns = ["fetch", "fs.", "child_process", "axios", "http."];

    for (const pattern of forbiddenPatterns) {
      if (expressionText.includes(pattern)) {
        violations.push(
          this.createViolation(
            node,
            sourceFile,
            `DOMAIN PURITY: Forbidden call '${pattern}' in Domain layer — delegate to Infrastructure.`,
          ),
        );
      }
    }
  }

  private isMatchingPath(modulePath: string, patterns: string[]): boolean {
    const normalized = modulePath.toLowerCase();
    // Match relative paths like ../infra or openclaw/plugin-sdk (if aliased)
    return patterns.some(
      (p) =>
        normalized.includes(`/${p}`) ||
        normalized.includes(`\\${p}`) ||
        normalized.startsWith(`${p}/`) ||
        normalized.startsWith(`${p}\\`) ||
        normalized === p,
    );
  }

  private createViolation(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    message: string,
    severity: "block" | "warning" = "block",
  ): TspViolation {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return {
      message,
      line: line + 1,
      character: character + 1,
      nodeText: node.getText(sourceFile),
      severity,
    };
  }
}
