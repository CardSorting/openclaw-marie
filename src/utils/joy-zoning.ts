import path from "node:path";

export type JoyZoningLayer = "Domain" | "Core" | "Infrastructure" | "UI" | "Plumbing";

export interface JoyZoningValidation {
  success: boolean;
  errors: string[];
}

// ── Layer Mapping ───────────────────────────────────────────────────────────

const LAYER_MAP: Record<string, JoyZoningLayer> = {
  // Domain: High-level policies, core business rules, entity definitions
  "src/agents/joy-zoning.policy.ts": "Domain",
  "src/agents/pi-tools.policy.ts": "Domain",
  "src/domain/": "Domain",
  "src/config/": "Domain",
  "src/types/": "Domain",

  // Core: Orchestration, agent logic, session management
  "src/agents/": "Core",
  "src/commands/": "Core",
  "src/cron/": "Core",
  "src/routing/": "Core",
  "src/sessions/": "Core",
  "src/hooks/": "Core",
  "src/plugins/": "Core",
  "src/plugin-sdk/": "Core",
  "src/acp/": "Core",
  "src/auto-reply/": "Core",
  "src/memory/": "Core",

  // Infrastructure: External integrations, DB, IO, platform specifics
  "src/infra/": "Infrastructure",
  "src/browser/": "Infrastructure",
  "src/media/": "Infrastructure",
  "src/media-understanding/": "Infrastructure",
  "src/providers/": "Infrastructure",
  "src/secrets/": "Infrastructure",
  "src/security/": "Infrastructure",
  "src/gateway/": "Infrastructure",
  "src/web/": "Infrastructure",
  "src/link-understanding/": "Infrastructure",

  // UI: Interaction channels, TUI, display logic
  "src/channels/": "UI",
  "src/tui/": "UI",
  "src/terminal/": "UI",
  "src/slack/": "UI",
  "src/telegram/": "UI",
  "src/discord/": "UI",
  "src/whatsapp/": "UI",
  "src/imessage/": "UI",
  "src/line/": "UI",
  "src/signal/": "UI",
  "src/cli/": "UI",
  "src/wizard/": "UI",
  "src/ui/": "UI",

  // Plumbing: Low-level utilities, foundational helpers
  "src/utils/": "Plumbing",
  "src/utils.ts": "Plumbing",
  "src/logging/": "Plumbing",
  "src/logging.ts": "Plumbing",
  "src/logger.ts": "Plumbing",
  "src/i18n/": "Plumbing",
  "src/shared/": "Plumbing",
  "src/test-utils/": "Plumbing",
  "src/test-helpers/": "Plumbing",
  "src/markdown/": "Plumbing",
};

export function getLayer(filePath: string): JoyZoningLayer {
  // Use relative path from CWD to ensure consistency regardless of absolute path prefix
  const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
  const normalizedPath = relativePath.startsWith("src/") ? relativePath : `src/${relativePath}`;

  // Specific file match first
  if (LAYER_MAP[normalizedPath]) {
    return LAYER_MAP[normalizedPath];
  }

  // Directory match — longest prefix wins to avoid false matches
  let bestMatch: { key: string; layer: JoyZoningLayer } | null = null;
  for (const [key, layer] of Object.entries(LAYER_MAP)) {
    if (key.endsWith("/") && normalizedPath.startsWith(key)) {
      if (!bestMatch || key.length > bestMatch.key.length) {
        bestMatch = { key, layer };
      }
    }
  }
  if (bestMatch) {
    return bestMatch.layer;
  }

  // Default to Core if in src, otherwise Plumbing
  if (normalizedPath.startsWith("src/")) {
    return "Core";
  }
  return "Plumbing";
}

/**
 * Strips comments and string literals to prevent false positives in regex-based scanning.
 */
function stripComments(content: string): string {
  // Remove block comments and line comments
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
}

function stripStrings(content: string): string {
  // Remove backtick template literals (handling nested content/escapes)
  let stripped = content.replace(/`(?:\\.|[^\\`])*`/g, "``");
  // Remove single and double quoted strings (handling escaped quotes)
  stripped = stripped.replace(/'(?:\\.|[^'\\])*'/g, "''");
  stripped = stripped.replace(/"(?:\\.|[^"\\])*"/g, '""');
  return stripped;
}

/**
 * Normalizes code for regex-based architectural checks.
 * Strips comments and merges whitespace to handle multi-line statements.
 */
function sanitizeForImportCheck(content: string): string {
  let sanitized = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  sanitized = sanitized.replace(/\s+/g, " "); // Normalize whitespace
  return sanitized;
}

// ── Content Smell Detection ─────────────────────────────────────────────────

/**
 * Validates architectural smells in the given content.
 * Layer-aware: strict checks apply only to specific layers.
 */
export function validateSmells(filePath: string, content: string): string[] {
  const errors: string[] = [];
  const layer = getLayer(filePath);
  const basename = path.basename(filePath);
  const codeOnly = stripStrings(stripComments(content));

  // Multiple classes in a single file — only enforced in Domain
  if (layer === "Domain") {
    const classCount = (codeOnly.match(/class\s+/g) || []).length;
    if (classCount > 1) {
      errors.push(`${basename}: Multiple classes in a single file — split into separate files.`);
    }
  }

  // Forbidden 'any' type — Domain and Infrastructure only
  if (layer === "Domain" || layer === "Infrastructure") {
    if (codeOnly.includes(": any") || codeOnly.includes("<any>")) {
      errors.push(
        `⚠️ DISCERNMENT WARNING: ${basename}: 'any' type detected — use a typed interface or generic.`,
      );
    }
  }

  // Forbidden direct I/O calls in Domain
  if (layer === "Domain") {
    const forbiddenTerms = ["fetch(", "fs.", "child_process", "axios", "http."];
    for (const term of forbiddenTerms) {
      if (codeOnly.includes(term)) {
        errors.push(
          `${basename}: Forbidden call '${term}' in Domain layer — delegate to Infrastructure.`,
        );
      }
    }
  }

  // Mega-File Detection (> 500 lines check for Domain/Core)
  if (layer === "Domain" || layer === "Core") {
    const lines = content.split("\n").length;
    if (lines > 500) {
      errors.push(
        `${basename}: Architectural Mega-File Detected (${lines} lines). Domain/Core logic must be decomposed into smaller, specialized modules.`,
      );
    }
  }

  return errors;
}

// ── Cross-Layer Import Detection (Regex-based) ──────────────────────────────

/**
 * Detects cross-layer violations in source content using regex pattern matching.
 * Catches violations that path-based validation can't detect (e.g., aliased imports).
 */
export function detectCrossLayerImports(content: string, layer: JoyZoningLayer): string[] {
  const violations: string[] = [];
  const codeOnly = sanitizeForImportCheck(content);

  const infraPaths =
    "(?:\\.\\.\\/infra|\\.\\.\\/infrastructure|\\.\\.\\/browser|\\.\\.\\/gateway|\\.\\.\\/providers|\\.\\.\\/secrets|\\.\\.\\/security|\\.\\.\\/web)";
  const uiPaths =
    "(?:\\.\\.\\/ui|\\.\\.\\/slack|\\.\\.\\/telegram|\\.\\.\\/discord|\\.\\.\\/tui|\\.\\.\\/channels|\\.\\.\\/terminal|\\.\\.\\/cli|\\.\\.\\/whatsapp|\\.\\.\\/imessage|\\.\\.\\/line|\\.\\.\\/signal|\\.\\.\\/wizard)";
  const appPaths =
    "(?:\\.\\.\\/agents|\\.\\.\\/config|\\.\\.\\/types|\\.\\.\\/infra|\\.\\.\\/browser|\\.\\.\\/gateway|\\.\\.\\/providers|\\.\\.\\/secrets|\\.\\.\\/security|\\.\\.\\/web|\\.\\.\\/slack|\\.\\.\\/telegram|\\.\\.\\/discord|\\.\\.\\/channels|\\.\\.\\/tui|\\.\\.\\/terminal|\\.\\.\\/cli)";

  if (layer === "Domain") {
    // 1. Concrete Imports (Zero-Value Threshold)
    const concreteImportRegex = new RegExp(
      `(?:import|export)(?!\\s+type\\s+).*?from\\s+['"]${infraPaths}.*?['"]`,
      "i",
    );
    if (concreteImportRegex.test(codeOnly)) {
      violations.push(
        "DOMAIN PURITY: Domain layer cannot import concrete values from Infrastructure. Use 'import type' and dependency inversion.",
      );
    }

    // 2. Dynamic Imports / Require evasion
    const dynamicEvasionRegex = new RegExp(
      `(?:import|require)\\s*\\(\\s*['"]${infraPaths}.*?['"]\\s*\\)`,
      "i",
    );
    if (dynamicEvasionRegex.test(codeOnly)) {
      violations.push(
        "DOMAIN PURITY: Dynamic imports or 'require' from Infrastructure are blocked in Domain.",
      );
    }

    // 3. Platform leakage (Node.js builtins)
    const nodeBuiltinRegex =
      /(?:import|export|require).*?['"](?:node:)?(?:fs|path|os|child_process|http|https|net|dgram|cluster)['"]/i;
    if (nodeBuiltinRegex.test(codeOnly)) {
      violations.push(
        "PLATFORM LEAKAGE: Domain layer must not depend on platform-specific modules.",
      );
    }

    // 4. UI imports (Zero-Value Threshold)
    const concreteUiRegex = new RegExp(
      `(?:import|export)(?!\\s+type\\s+).*?from\\s+['"]${uiPaths}.*?['"]`,
      "i",
    );
    if (concreteUiRegex.test(codeOnly)) {
      violations.push(
        "DOMAIN PURITY: Domain layer cannot import concrete values from UI. Domain must be platform-agnostic (use 'import type').",
      );
    }
  }

  if (layer === "Plumbing") {
    const plumbingDepRegex = new RegExp(
      `(?:import|export|require).*?from\\s+['"]${appPaths}.*?['"]`,
      "i",
    );
    if (plumbingDepRegex.test(codeOnly)) {
      violations.push("Plumbing/Utils should have zero dependencies on application layers.");
    }
  }

  if (layer === "Infrastructure") {
    const infraUiRegex = new RegExp(
      `(?:import|export|require).*?from\\s+['"]${uiPaths}.*?['"]`,
      "i",
    );
    if (infraUiRegex.test(codeOnly)) {
      violations.push("Infrastructure layer cannot import from UI — use events or callbacks.");
    }
  }

  return violations;
}

// ── Layering Validation ─────────────────────────────────────────────────────

/**
 * Validates dependencies between two file paths.
 * Returns an error message if the dependency violates layer rules, null if valid.
 */
export function validateDependency(sourcePath: string, targetPath: string): string | null {
  const sourceLayer = getLayer(sourcePath);
  const targetLayer = getLayer(targetPath);

  if (sourceLayer === targetLayer) {
    return null;
  }

  if (sourceLayer === "Domain" && targetLayer !== "Plumbing") {
    return `Architectural Violation: Domain layer (${path.basename(sourcePath)}) should not depend on ${targetLayer} (${path.basename(targetPath)})`;
  }

  if (sourceLayer === "Core" && targetLayer === "UI") {
    return `Architectural Violation: Core layer (${path.basename(sourcePath)}) should not depend on UI layer (${path.basename(targetPath)})`;
  }

  if (sourceLayer === "Infrastructure" && targetLayer === "UI") {
    return `Architectural Violation: Infrastructure layer (${path.basename(sourcePath)}) cannot import from UI (${path.basename(targetPath)})`;
  }

  if (sourceLayer === "UI" && targetLayer === "Infrastructure") {
    return `Architectural Smell: UI layer (${path.basename(sourcePath)}) directly depending on Infrastructure (${path.basename(targetPath)}) is discouraged. Use Core as a bridge.`;
  }

  if (
    sourceLayer === "Plumbing" &&
    ["Domain", "Core", "Infrastructure", "UI"].includes(targetLayer)
  ) {
    return `Architectural Violation: Plumbing layer (${path.basename(sourcePath)}) cannot depend on ${targetLayer} layer (${path.basename(targetPath)})`;
  }

  return null;
}

// ── Full Validation ─────────────────────────────────────────────────────────

/**
 * Full Joy-Zoning validation for file content.
 */
export function validateJoyZoning(filePath: string, content: string): JoyZoningValidation {
  const smellErrors = validateSmells(filePath, content);
  const crossLayerErrors = detectCrossLayerImports(content, getLayer(filePath));
  const allErrors = [...smellErrors, ...crossLayerErrors];

  return {
    success: allErrors.length === 0,
    errors: allErrors,
  };
}

// ── Content-Based Layer Suggestion ──────────────────────────────────────────

/**
 * Analyzes code content and suggests which architectural layer best fits.
 * Returns the suggested layer and reasoning, or null if no confident suggestion.
 */
export function suggestLayerForContent(
  content: string,
): { layer: JoyZoningLayer; reason: string } | null {
  // UI patterns
  if (/import\s+.*from\s+['"]react/i.test(content) || /jsx|tsx|component|render/i.test(content)) {
    return { layer: "UI", reason: "Contains React/JSX patterns — belongs in the UI layer." };
  }

  // I/O / adapter patterns
  if (
    /import\s+.*from\s+['"](?:node:)?(?:fs|http|https|net|child_process|pg|mysql|redis|axios)/i.test(
      content,
    )
  ) {
    return {
      layer: "Infrastructure",
      reason: "Contains I/O or external service imports — belongs in Infrastructure.",
    };
  }

  // Pure utility patterns (no class, stateless exports)
  if (
    !/class\s+/.test(content) &&
    /export\s+(?:function|const)\s+/.test(content) &&
    !/import\s+.*from\s+['"]@(?:core|infrastructure|services)/.test(content)
  ) {
    return {
      layer: "Plumbing",
      reason: "Stateless utility functions with no layer dependencies — fits Plumbing.",
    };
  }

  return null;
}

// ── Target Path Extraction ──────────────────────────────────────────────────

/**
 * Extracts target file paths from various common tool parameter names.
 * Returns an object with the primary filePath and an optional transitionPath (for renames/moves).
 */
export function getTargetPaths(params: Record<string, unknown> | null | undefined): {
  filePath: string | null;
  newPath: string | null;
} {
  if (!params) {
    return { filePath: null, newPath: null };
  }

  const filePath =
    (params.path as string) ??
    (params.file_path as string) ??
    (params.target_file as string) ??
    (params.absolutePath as string) ??
    (params.filePath as string) ??
    (params.sourcePath as string) ??
    (params.oldPath as string);

  const newPath =
    (params.newPath as string) ??
    (params.destinationPath as string) ??
    (params.targetPath as string);

  return {
    filePath: typeof filePath === "string" ? filePath : null,
    newPath: typeof newPath === "string" ? newPath : null,
  };
}

// ── Layer Context (for agent feedback) ──────────────────────────────────────

/**
 * Returns proactive architectural guidance for a given file's layer.
 */
export function getFileLayerContext(filePath: string): string {
  const layer = getLayer(filePath);
  const fileName = path.basename(filePath);

  switch (layer) {
    case "Domain":
      return `📍 ${fileName} → DOMAIN layer\n  ✅ Pure business logic, policies, type definitions\n  🚫 No I/O, no external imports, no side effects`;
    case "Core":
      return `📍 ${fileName} → CORE layer\n  ✅ Orchestration, agent coordination, prompt assembly\n  🚫 Avoid raw I/O — delegate to Infrastructure adapters`;
    case "Infrastructure":
      return `📍 ${fileName} → INFRASTRUCTURE layer\n  ✅ Adapters, API clients, persistence, external services\n  🚫 No business rules (keep those in Domain)`;
    case "UI":
      return `📍 ${fileName} → UI layer\n  ✅ Channel integrations, TUI, event handlers, display\n  🚫 No business logic, no direct I/O`;
    case "Plumbing":
      return `📍 ${fileName} → PLUMBING layer\n  ✅ Stateless utilities, formatters, pure helpers\n  🚫 No dependencies on Domain, Infrastructure, or UI`;
    default:
      return `📍 ${fileName} → INFRASTRUCTURE layer (default)\n  ✅ Adapters and integrations\n  🚫 No business rules`;
  }
}

// ── Correction Hints ────────────────────────────────────────────────────────

/**
 * Generates concise, actionable correction hints for architectural violations.
 */
export function getCorrectionHint(errors: string[]): string {
  const fixes: string[] = [];
  for (const err of errors) {
    if (err.includes("DOMAIN PURITY")) {
      fixes.push(
        "Use 'import type' and dependency inversion. Domain must only know about interfaces, not concrete implementations.",
      );
    } else if (err.includes("Dynamic imports") || err.includes("require")) {
      fixes.push(
        "Avoid dynamic import/require for application layers. Use static imports or event-to-handler mapping.",
      );
    } else if (err.includes("UI")) {
      fixes.push(
        "Use Gateway events or observer patterns to notify the UI instead of direct imports.",
      );
    } else if (err.includes("QUARANTINE") || err.includes("TAINTED")) {
      fixes.push(
        "The target file has excessive architectural debt. Refactor the target file's violates before importing it here.",
      );
    } else if (err.includes("PLATFORM LEAKAGE")) {
      fixes.push(
        "Wrap platform-specific code in an Infrastructure adapter. Domain must be platform-agnostic.",
      );
    } else if (err.includes("Mega-File")) {
      fixes.push("Decompose this module into smaller, specialized files within the same layer.");
    } else if (err.includes("ARCHITECTURAL CYCLE")) {
      fixes.push(
        "Break the circle: move shared logic to Plumbing, or use interfaces in a higher layer.",
      );
    } else if (err.includes("Forbidden call")) {
      fixes.push(
        "Move the I/O call to an Infrastructure adapter. Inject via dependency inversion.",
      );
    } else if (err.includes("any")) {
      fixes.push("Replace 'any' with a typed interface or generic.");
    }
  }
  if (fixes.length === 0) {
    fixes.push("Review the violations and restructure according to Joy-Zoning rules.");
  }

  const uniqueFixes = [...new Set(fixes)];
  return `💡 Architectural Guidance:\n${uniqueFixes.map((f) => `  → ${f}`).join("\n")}`;
}
