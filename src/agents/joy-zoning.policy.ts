import {
  getLayer,
  validateDependency,
  validateJoyZoning,
  suggestLayerForContent,
  getTargetPaths,
  getFileLayerContext,
  getCorrectionHint,
  type JoyZoningLayer,
} from "../utils/joy-zoning.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { JoyZoningStore } from "../infra/joy-zoning-store.js";
import type { JoyZoningConfig } from "../config/types.joy-zoning.js";
import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";

const log = createSubsystemLogger("agents/joy-zoning");

// ── Lazy Store Access (advisory — never breaks enforcement) ─────────────────

let _store: JoyZoningStore | null = null;
let _storeLoadAttempted = false;

function getStore(): JoyZoningStore | null {
  if (_store) return _store;
  if (_storeLoadAttempted) return null;
  _storeLoadAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getJoyZoningStore } = require("../infra/joy-zoning-store.js") as typeof import("../infra/joy-zoning-store.js");
    _store = getJoyZoningStore();
    return _store;
  } catch {
    log.info("Joy-Zoning SQLite store unavailable — running in memory-only mode");
    return null;
  }
}

/** Inject a store instance (for testing). */
export function setStoreForTest(store: JoyZoningStore | null): void {
  _store = store;
  _storeLoadAttempted = store !== null;
}

// The user's requested change for `getFileStrikes` is syntactically incorrect
// for this file as `JoyZoningStore` is an imported type, not a class defined here.
// Assuming the intent was to add this method to the `JoyZoningStore` type definition
// in `../infra/joy-zoning-store.js` and then use it here.
// For the purpose of this edit, I will add the telemetry and propagation checks
// as requested, which depend on `getFileStrikes` being available on `store`.

// ── Config Access ───────────────────────────────────────────────────────────

let _config: JoyZoningConfig | null = null;
let _configLoadAttempted = false;

export function getConfig(): JoyZoningConfig {
  if (_config) return _config;
  if (_configLoadAttempted) return {};
  _configLoadAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const configMod = require("../config/io.js") as { getRuntimeConfigSnapshot: () => { config?: { joyZoning?: JoyZoningConfig } } | null };
    const snapshot = configMod.getRuntimeConfigSnapshot();
    _config = snapshot?.config?.joyZoning ?? {};
    return _config!;
  } catch {
    return {};
  }
}

/**
 * Apply strictness config to a violation level.
 * - "advisory": always downgrade to "warning"
 * - "strict": always upgrade to "block"
 * - "enforced" (default): use the original level
 */
function applyStrictness(level: "warning" | "block"): "warning" | "block" {
  const config = getConfig();
  const strictness = config.strictness ?? "enforced";
  if (strictness === "advisory") return "warning";
  if (strictness === "strict") return "block";
  return level;
}

/** Override config for testing. */
export function setConfigForTest(config: JoyZoningConfig | null): void {
  _config = config;
  _configLoadAttempted = config !== null;
}

// ── Types ───────────────────────────────────────────────────────────────────

export type JoyZoningViolation = {
  level: "warning" | "block";
  message: string;
  sourceLayer: JoyZoningLayer;
  targetLayer?: JoyZoningLayer;
  correctionHint?: string;
  violations?: string[];
  error_retry?: boolean;
};

export type JoyZoningPolicyState = {
  /** Cumulative count of warnings issued for this session. */
  warningCount: number;
  /** Cumulative count of hard blocks issued for this session. */
  blockCount: number;
  /** Per-file strike map: tracks how many times a file has been blocked. */
  strikeMap: Map<string, number>;
  /** Recent violations for progressive enforcement. */
  recentViolations: JoyZoningViolation[];
};

// ── State ───────────────────────────────────────────────────────────────────

const sessionStates = new Map<string, JoyZoningPolicyState>();

const MAX_WARNINGS_BEFORE_BLOCK = 3;
const MAX_TRACKED_VIOLATIONS = 50;
const MAX_SESSION_STATES = 256;

export function getOrCreatePolicyState(sessionKey: string): JoyZoningPolicyState {
  let state = sessionStates.get(sessionKey);
  if (!state) {
    state = {
      warningCount: 0,
      blockCount: 0,
      strikeMap: new Map(),
      recentViolations: [],
    };
    sessionStates.set(sessionKey, state);
    // Evict oldest session if we exceed max
    if (sessionStates.size > MAX_SESSION_STATES) {
      const oldest = sessionStates.keys().next().value;
      if (oldest && oldest !== sessionKey) sessionStates.delete(oldest);
    }
  }
  return state;
}

// ── Core Evaluation ─────────────────────────────────────────────────────────

/**
 * Full pre-execution evaluation of a file-modifying tool call.
 *
 * Performs:
 * 1. Content-based smell detection & cross-layer import validation
 * 2. Path-based layer dependency validation (if import paths provided)
 * 3. Layer mismatch suggestion for new file creation
 * 4. Per-file strike-based progressive enforcement
 *
 * Returns null if allowed, otherwise returns a JoyZoningViolation.
 */
export function evaluateToolCall(params: {
  toolName: string;
  filePath?: string;
  newPath?: string;
  content?: string;
  importPaths?: string[];
  sessionKey?: string;
  thought?: string;
  agentId?: string;
}): JoyZoningViolation | null {
  // ── Config gate ──
  const config = getConfig();
  if (config.enabled === false) return null;
  const { toolName, content, importPaths, sessionKey, agentId, thought } = params;

  // ── Absolute Self-Preservation ──
  const jzInfraPaths = [
    "src/infra/joy-zoning-store.ts",
    "src/agents/joy-zoning.policy.ts",
    "src/utils/joy-zoning.ts",
  ];
  if (params.filePath && jzInfraPaths.some((p) => params.filePath!.includes(p))) {
    return {
      level: "block",
      message: `🛑 SELF-PRESERVATION: Agents are prohibited from modifying Joy-Zoning infrastructure directly. Any changes to the policy or store must be performed by the system or authorized architects.`,
      sourceLayer: "Infrastructure",
    };
  }

  // ── Bash Interception ──
  if (toolName === "bash" || toolName === "run_command") {
    const bashCmd = (params as any).command || "";
    const destructivePatterns = [
      /\brm\s+.*-rf?\b/,
      /\bmv\s+.*\bsrc\/(?:domain|core)\b/,
      /\bsed\s+.*-i\b/,
      /[>]{1,2}\s*src\/(?:domain|core)/,
    ];
    if (destructivePatterns.some((pattern) => pattern.test(bashCmd))) {
      return {
        level: "block",
        message: `🛑 DESTRUCTIVE BASH INTERCEPTED: The command contains patterns that bypass architectural safeguards (deletion/renaming in protected layers). Use explicit file-modifying tools instead.`,
        sourceLayer: "Plumbing",
      };
    }
    return null; // Bash tools are otherwise allowed unless destructive
  }

  // Only intercept file-modifying tools
  const modTools = ["write", "edit", "apply_patch", "delete_file", "remove_file", "rename", "move"];
  if (!modTools.includes(toolName)) {
    return null;
  }

  const filePath = params.filePath;
  if (!filePath && !params.newPath) return null;

  // Normalize to relative src path
  const normalized = filePath ? normalizePath(filePath) : null;
  const normalizedNew = params.newPath ? normalizePath(params.newPath) : null;

  if (!normalized && !normalizedNew) return null;

  const start = performance.now();
  const sourceLayer = normalized ? getLayer(normalized) : null;
  const targetLayer = normalizedNew ? getLayer(normalizedNew) : null;

  // ── Destruction Prevention ──
  if (["delete_file", "remove_file"].includes(toolName) && normalized) {
    if (sourceLayer === "Domain" || sourceLayer === "Core") {
      return {
        level: "block",
        message: `🛑 DESTRUCTION PREVENTION: Deleting files in the **${sourceLayer}** layer is prohibited to prevent architectural regression. If deletion is necessary, please request a manual review.`,
        sourceLayer,
      };
    }
  }

  // ── Multilateral Path Validation (Rename/Move) ──
  if (normalized && normalizedNew && sourceLayer && targetLayer) {
    if (sourceLayer === "Domain" && targetLayer !== "Domain") {
      return {
        level: "block",
        message: `🛑 LAYER EVASION: Moving files out of the **Domain** layer into **${targetLayer}** is blocked. Domain logic must remain isolated.`,
        sourceLayer,
        targetLayer,
      };
    }
    // If it's a move, we still treat it as a potential architectural change
    if (sourceLayer !== targetLayer) {
      log.info(`Joy-Zoning: Validating cross-layer move from ${sourceLayer} to ${targetLayer}`);
    }
  }

  // From here on, use 'normalized' as the primary target if it exists, otherwise 'normalizedNew'
  const activeNormalized = normalized || normalizedNew;
  if (!activeNormalized) return null;
  const activeLayer = getLayer(activeNormalized);

  // Check for Break-Glass Override [JZ:OVERRIDE] in thoughts
  const hasOverride = params.thought?.includes("[JZ:OVERRIDE]");

  try {
    // ── 1. Content-based validation (smells + cross-layer imports) ──────────
    if (content && normalized && sourceLayer) {
      const validation = validateJoyZoning(normalized, content);
      if (!validation.success) {
        const violation = resolveContentViolation({
          errors: validation.errors,
          filePath: normalized,
          sourceLayer,
          sessionKey,
          agentId: params.agentId,
          thoughtSnippet: params.thought,
        });

        if (violation.level === "block") {
          if (hasOverride) {
            log.warn(
              `Joy-Zoning OVERRIDE [${sessionKey}]: Bypassing block on ${normalized} due to [JZ:OVERRIDE] tag.`,
            );
            violation.level = "warning";
            violation.message = `⚠️ [CRITICAL OVERRIDE] ${violation.message}`;
          } else {
            return violation;
          }
        }
        // If it was a warning, or a blocked violation was overridden, return it.
        if (violation.level === "warning") {
          return violation;
        }
      }

      // For new file creation: suggest better layer if content doesn't match location
      if (toolName === "write") {
        const suggestion = suggestLayerForContent(content);
        if (suggestion && suggestion.layer !== sourceLayer && sourceLayer !== "Core") {
          const violation: JoyZoningViolation = {
            level: "warning",
            message: `📍 This file is being created in the **${sourceLayer}** layer, but its content looks like it belongs in **${suggestion.layer}**.\n${suggestion.reason}\nConsider moving it. If the current location is intentional, proceed.`,
            sourceLayer,
            targetLayer: suggestion.layer,
          };
          return violation;
        }
      }
    }

    // ── 2. Path-based dependency validation ─────────────────────────────────
    if (importPaths && importPaths.length > 0) {
      const store = getStore();
      for (const importPath of importPaths) {
        const normalizedImport = normalizePath(importPath);
        if (!normalizedImport) continue;

        // a) Reflexive Propagation: check if target file is tainted
        if (store && sourceLayer) {
          const targetStrikes = store.getStrikeCount(normalizedImport);
          // Domain quarantine (> 5 strikes)
          if (sourceLayer === "Domain" && targetStrikes > 5) {
            const violation: JoyZoningViolation = {
              level: "block",
              message: `🛑 TAINTED IMPORT: Domain layer cannot import from '${normalizedImport}' because it has high architectural debt (${targetStrikes} strikes). Clean up the dependency first.`,
              sourceLayer,
              targetLayer: getLayer(normalizedImport),
            };
            return violation;
          }
          // Phase 11: Architectural Quarantine (> 10 strikes)
          if (sourceLayer === "Core" && targetStrikes > 10) {
            const violation: JoyZoningViolation = {
              level: "block",
              message: `🛑 ARCHITECTURAL QUARANTINE: Core layer cannot import from '${normalizedImport}' because it has extreme architectural debt (${targetStrikes} strikes). This file is quarantined until refactored.`,
              sourceLayer,
              targetLayer: getLayer(normalizedImport),
            };
            return violation;
          }
        }

        // b) Graph-based Cycle Detection (Phase 9)
        if (store && normalized) {
          const cycle = store.detectCycle(normalized, normalizedImport);
          if (cycle) {
            const violation: JoyZoningViolation = {
              level: "block",
              message: `🛑 ARCHITECTURAL CYCLE: Circular dependency detected: ${cycle.join(" -> ")}. Architectural layers must be a Directed Acyclic Graph (DAG).`,
              sourceLayer: sourceLayer || "Infrastructure",
              targetLayer: getLayer(normalizedImport),
            };
            trackViolation(getOrCreatePolicyState(sessionKey ?? "default"), violation, sessionKey, normalized, params.agentId, params.thought);
            return violation;
          }
          // Record the dependency for future cycle detection
          store.recordDependency(normalized, normalizedImport);
        }

        if (normalized) {
          const violationErr = validateDependency(normalized, normalizedImport);
          if (violationErr) {
            const violation = resolvePathViolation({
              message: violationErr,
              sourceLayer: sourceLayer || "Infrastructure",
              targetLayer: getLayer(normalizedImport),
              sessionKey,
              filePath: normalized,
              agentId: params.agentId,
              thoughtSnippet: params.thought,
            });

            if (violation.level === "block") {
              if (hasOverride) {
                log.warn(
                  `Joy-Zoning OVERRIDE [${sessionKey}]: Bypassing path block on ${normalized} due to [JZ:OVERRIDE] tag.`,
                );
                violation.level = "warning";
                violation.message = `⚠️ [CRITICAL OVERRIDE] ${violation.message}`;
              } else {
                return violation;
              }
            }
            if (violation.level === "warning") {
              return violation;
            }
          }
        }
      }
    }

    return null;
  } finally {
    const duration = performance.now() - start;
    const pathRef = normalized || normalizedNew || "unknown";
    if (duration > 50) {
      log.warn(`Joy-Zoning evaluateToolCall SLOW: ${duration.toFixed(2)}ms for ${pathRef}`);
      if (pathRef !== "unknown") {
        const store = getStore();
        if (store) store.recordPerformance(pathRef, duration);
      }
    } else {
      log.debug(`Joy-Zoning evaluation: ${duration.toFixed(2)}ms for ${pathRef}`);
    }
  }
}

// ── Internal Helpers ────────────────────────────────────────────────────────

function normalizePath(filePath: string): string | null {
  const srcIdx = filePath.indexOf("src/");
  if (srcIdx === -1) return null;
  return filePath.slice(srcIdx);
}

export function detectLayer(filePath: string): JoyZoningLayer | null {
  const normalized = normalizePath(filePath);
  if (!normalized) return null;

  if (normalized.startsWith("src/domain/")) return "Domain";
  if (normalized.startsWith("src/core/")) return "Core";
  if (normalized.startsWith("src/infra/")) return "Infrastructure";
  if (normalized.startsWith("src/plumbing/")) return "Plumbing";
  if (normalized.startsWith("src/ui/")) return "UI";
  
  return null;
}

/**
 * Strike-based enforcement for content violations.
 * - Domain Strike 1: HARD BLOCK (reject the write with correction hints)
 * - Domain Strike 2+: Degrade to WARNING (prevent infinite deadlock)
 * - Other layers: Always WARNING
 */
function resolveContentViolation(params: {
  errors: string[];
  filePath: string;
  sourceLayer: JoyZoningLayer;
  sessionKey?: string;
  agentId?: string;
  thoughtSnippet?: string;
}): JoyZoningViolation {
  const { errors, filePath, sourceLayer, sessionKey, agentId, thoughtSnippet } = params;
  const fatalErrors = errors.filter((e) => !e.includes("⚠️ DISCERNMENT WARNING"));
  const isDiscernmentOnly = fatalErrors.length === 0 && errors.length > 0;

  const hint = getCorrectionHint(errors);
  const violationSummary = errors.map((e) => `  - ${e}`).join("\n");

  if (!sessionKey || isDiscernmentOnly) {
    const level = isDiscernmentOnly
      ? "warning"
      : applyStrictness(sourceLayer === "Domain" ? "block" : "warning");

    const violation: JoyZoningViolation = {
      level,
      message: `${isDiscernmentOnly ? "⚠️ DISCERNMENT WARNING" : sourceLayer + " layer file"} has ${errors.length} violation(s):\n${violationSummary}\n\n${hint}`,
      sourceLayer,
      correctionHint: hint,
      violations: errors,
    };
    if (sessionKey) {
      trackViolation(getOrCreatePolicyState(sessionKey), violation, sessionKey, filePath, agentId, thoughtSnippet);
    }
    return violation;
  }

  const state = getOrCreatePolicyState(sessionKey);
  const strikes = (state.strikeMap.get(filePath) || 0) + 1;
  state.strikeMap.set(filePath, strikes);

  log.debug(`Evaluating content violation for ${filePath} in ${sourceLayer} (Strike ${strikes})`);

  // 1. DOMAIN: Zero tolerance — Block on first strike
  if (sourceLayer === "Domain") {
    if (strikes === 1) {
      const effectiveLevel = applyStrictness("block");
      if (effectiveLevel === "block") state.blockCount++;
      else state.warningCount++;

      const violation: JoyZoningViolation = {
        level: effectiveLevel,
        message: `🛑 DOMAIN ARCHITECTURAL REJECTION: [🏗️ ARCHITECTURAL CORRECTION REQUIRED] ${errors.length} violation(s):\n${violationSummary}\n\n${hint}\n\n💡 Architecture Rule: Domain must be pure logic. Use Infrastructure for side effects.`,
        sourceLayer,
        correctionHint: hint,
        violations: errors,
        error_retry: true,
      };
      trackViolation(state, violation, sessionKey, filePath, agentId, thoughtSnippet);
      log.warn(`Joy-Zoning BLOCK [${sessionKey}]: Domain violation on ${filePath}`);
      persistStrike(filePath, violation.message);
      return violation;
    } else {
      // Strike 2+: Degrade to warning
      state.warningCount++;
      const violation: JoyZoningViolation = {
        level: "warning",
        message: `⚠️ [Architectural Warning] (Strike ${strikes}) Domain layer file has ${errors.length} violation(s):\n${violationSummary}\n\n${hint}\n\nProceeding with warning to prevent deadlock. Please refactor this file soon.`,
        sourceLayer,
        correctionHint: hint,
        violations: errors,
      };
      trackViolation(state, violation, sessionKey, filePath, agentId, thoughtSnippet);
      log.info(`Joy-Zoning WARNING (Strike ${strikes}) [${sessionKey}]: Domain violation on ${filePath}`);
      persistStrike(filePath, violation.message);
      return violation;
    }
  }

  // 2. CORE / INFRASTRUCTURE: Progressive — Warn 3 times, then Block
  if (sourceLayer === "Core" || sourceLayer === "Infrastructure") {
    const rawLevel: "warning" | "block" = strikes > 3 ? "block" : "warning";
    const effectiveLevel = applyStrictness(rawLevel);
    
    if (effectiveLevel === "block") state.blockCount++;
    else state.warningCount++;

    const prefix = effectiveLevel === "block" ? "🛑 [Progressive Block]" : "⚠️ [Architectural Warning]";
    const suffix = effectiveLevel === "warning" && strikes < 3 
      ? `\n\n💡 You have ${3 - strikes} grace attempts remaining before this becomes a block.`
      : "";

    const violation: JoyZoningViolation = {
      level: effectiveLevel,
      message: `${prefix} ${sourceLayer} layer file has ${errors.length} violation(s):\n${violationSummary}\n\n${hint}${suffix}`,
      sourceLayer,
      correctionHint: hint,
      violations: errors,
    };
    trackViolation(state, violation, sessionKey, filePath, agentId, thoughtSnippet);
    persistStrike(filePath, violation.message);
    return violation;
  }

  // 3. PLUMBING / UI: Advisory only — Never block
  state.warningCount++;
  const violation: JoyZoningViolation = {
    level: "warning",
    message: `⚠️ [Architectural Smell] ${sourceLayer} layer file has ${errors.length} violation(s):\n${violationSummary}\n\nConsider refactoring to keep ${sourceLayer} clean.`,
    sourceLayer,
    correctionHint: hint,
    violations: errors,
  };
  trackViolation(state, violation, sessionKey, filePath);
  return violation;
}

/**
 * Progressive enforcement for path-based dependency violations.
 */
function resolvePathViolation(params: {
  message: string;
  sourceLayer: JoyZoningLayer;
  targetLayer: JoyZoningLayer;
  sessionKey?: string;
  filePath: string;
  agentId?: string;
  thoughtSnippet?: string;
}): JoyZoningViolation {
  const { message, sourceLayer, targetLayer, sessionKey, filePath, agentId, thoughtSnippet } = params;
  const isSmell = message.includes("Architectural Smell");

  if (!sessionKey) {
    return {
      level: applyStrictness(isSmell ? "warning" : "block"),
      message,
      sourceLayer,
      targetLayer,
    };
  }

  const state = getOrCreatePolicyState(sessionKey);
  log.debug(`Evaluating path violation for ${filePath}: ${sourceLayer} -> ${targetLayer}`);

  // 1. DOMAIN: Block on first strike for dependency violations
  if (sourceLayer === "Domain" && !isSmell) {
    const strikes = (state.strikeMap.get(filePath) || 0) + 1;
    state.strikeMap.set(filePath, strikes);

    if (strikes === 1) {
      const effectiveLevel = applyStrictness("block");
      if (effectiveLevel === "block") state.blockCount++;
      else state.warningCount++;
      const violation: JoyZoningViolation = {
        level: effectiveLevel,
        message: `🛑 DOMAIN DEPENDENCY VIOLATION: [🏗️ ARCHITECTURAL CORRECTION REQUIRED] ${message}`,
        sourceLayer,
        targetLayer,
        error_retry: true,
      };
      trackViolation(state, violation, sessionKey, filePath, agentId, thoughtSnippet);
      log.warn(`Joy-Zoning BLOCK [${sessionKey}]: ${message}`);
      persistStrike(filePath, message);
      return violation;
    } else {
      // Strike 2+: Degrade to warning
      state.warningCount++;
      const violation: JoyZoningViolation = {
        level: "warning",
        message: `⚠️ [Architectural Warning] (Strike ${strikes}) Domain dependency violation: ${message}\nProceeding with warning to prevent deadlock.`,
        sourceLayer,
        targetLayer,
      };
      trackViolation(state, violation, sessionKey, filePath, agentId, thoughtSnippet);
      log.info(`Joy-Zoning WARNING (Strike ${strikes}) [${sessionKey}]: ${message}`);
      persistStrike(filePath, message);
      return violation;
    }
  }

  // 2. CORE / INFRA: Progressive — escalate to block after threshold
  if (sourceLayer === "Core" || sourceLayer === "Infrastructure") {
    state.warningCount++;
    const rawLevel: "warning" | "block" =
      state.warningCount > MAX_WARNINGS_BEFORE_BLOCK ? "block" : "warning";
    const level = applyStrictness(rawLevel);

    if (level === "block") state.blockCount++;

    const violation: JoyZoningViolation = {
      level,
      message: level === "block" ? `🛑 [Progressive Block] ${message}` : `⚠️ ${message}`,
      sourceLayer,
      targetLayer,
    };
    trackViolation(state, violation, sessionKey, filePath, agentId, thoughtSnippet);
    
    if (level === "block") {
      log.warn(`Joy-Zoning BLOCK (progressive) [${sessionKey}]: ${message}`);
    } else {
      log.info(`Joy-Zoning WARNING [${sessionKey}]: ${message}`);
    }
    return violation;
  }

  // 3. Reflexive Check: Circular Layer Dependency
  // (e.g., Domain depends on Infra while Infra depends on Domain)
  const isCircular = detectReflexiveCircularity(sourceLayer, filePath);
  if (isCircular) {
    state.warningCount++;
    const violation: JoyZoningViolation = {
      level: "warning",
      message: `⚠️ [Reflexive Audit] Circular architectural dependency detected involving ${filePath}. Layers should form a Directed Acyclic Graph.`,
      sourceLayer,
    };
    trackViolation(state, violation, sessionKey, filePath, agentId, thoughtSnippet);
    return violation;
  }

  // Fallback: Advisory only for other layers/smells
  state.warningCount++;
  const violation: JoyZoningViolation = {
    level: "warning",
    message: `⚠️ [Architectural Smell] ${message}`,
    sourceLayer,
    targetLayer,
  };
  trackViolation(state, violation, sessionKey, filePath);
  return violation;
}

/**
 * Detects if the current file's layer dependency creates a reflexive cycle.
 * For simplicity in this audit pass, we check if the target layer has files
 * that depend back on the source layer.
 */
function detectReflexiveCircularity(sourceLayer: JoyZoningLayer, filePath: string): boolean {
  // In a real implementation, we would query the store for reverse dependencies.
  // For this pass, we use a heuristic or log the potential for future enforcement.
  log.debug(`Reflexive check: ${filePath} (${sourceLayer})`);
  return false; // Placeholder for future graph analysis
}

function trackViolation(
  state: JoyZoningPolicyState,
  violation: JoyZoningViolation,
  sessionKey?: string,
  filePath?: string,
  agentId?: string,
  thoughtSnippet?: string,
): void {
  state.recentViolations.push(violation);
  if (state.recentViolations.length > MAX_TRACKED_VIOLATIONS) {
    state.recentViolations.shift();
  }

  // Emit diagnostic event (native integration)
  if (filePath) {
    try {
      emitDiagnosticEvent({
        type: "jz.violation",
        sessionKey,
        filePath,
        layer: violation.sourceLayer,
        level: violation.level,
        agentId,
        action: violation.level === "warning" ? "warn" : "block",
        message: violation.message.split("\n")[0] ?? violation.message,
      });
    } catch { /* advisory */ }
  }

  // Persist to SQLite (advisory)
  if (sessionKey && filePath) {
    try {
      const store = getStore();
      if (getConfig().persist !== false) {
        store?.recordViolation({
          sessionKey,
          filePath,
          layer: violation.sourceLayer,
          level: violation.level,
          message: violation.message.split("\n")[0] ?? violation.message,
          correctionHint: violation.correctionHint,
          agentId,
          thoughtSnippet: thoughtSnippet?.slice(0, 500), // Cap thought snippet
        });
      }
    } catch {
      // Persistence is advisory — never break enforcement
    }
  }
}

/**
 * Called when a file passes validation — resets strikes for that file.
 */
export function clearStrikesForFile(sessionKey: string, filePath: string): void {
  const state = sessionStates.get(sessionKey);
  if (state) {
    const normalized = normalizePath(filePath);
    if (normalized) {
      state.strikeMap.delete(normalized);
      try {
        getStore()?.resetStrike(normalized);
      } catch { /* advisory */ }
    }
  }
}

function persistStrike(filePath: string, message?: string): void {
  try {
    getStore()?.getOrIncrementStrike(filePath, message);
  } catch { /* advisory */ }
}

// ── System Prompt Integration ───────────────────────────────────────────────

/**
 * Build the full Joy-Zoning section for injection into the agent system prompt.
 */
export function buildAuditSummary(sessionKey?: string): string {
  const lines: string[] = [];

  lines.push("## 🏗️ JOY-ZONING: Your Architectural Guide");
  lines.push("");
  lines.push(
    "Joy-Zoning organizes code into clear layers so developers can find, understand, and evolve the codebase with confidence.",
  );
  lines.push("");

  // ── Layer Guide ──
  lines.push("### 📐 Layer Guide");
  lines.push("");
  lines.push("**DOMAIN** (config/, types/, *.policy.ts)");
  lines.push("  Purpose: Pure business logic — policies, rules, type definitions.");
  lines.push("  What to avoid: I/O, external imports, side effects.");
  lines.push('  Principle: If you can\'t test it with zero mocks, it doesn\'t belong here.');
  lines.push("");
  lines.push("**CORE** (agents/, commands/, cron/, routing/, sessions/, hooks/, plugins/)");
  lines.push("  Purpose: Application orchestration — coordinates domain logic with infrastructure.");
  lines.push("  What to avoid: Direct UI rendering, raw I/O (delegate to Infrastructure).");
  lines.push("  Principle: Orchestrate, don't implement low-level concerns directly.");
  lines.push("");
  lines.push("**INFRASTRUCTURE** (infra/, browser/, gateway/, providers/, secrets/, security/, web/)");
  lines.push("  Purpose: Adapters and integrations — connects the outside world to domain contracts.");
  lines.push("  What to avoid: Business rules, UI components, domain logic.");
  lines.push("  Principle: Implement interfaces defined by domain. Keep domain-agnostic.");
  lines.push("");
  lines.push("**UI** (channels/, tui/, terminal/, cli/, slack/, telegram/, discord/, whatsapp/, signal/, line/, imessage/)");
  lines.push("  Purpose: Presentation — what the user sees and interacts with.");
  lines.push("  What to avoid: Business logic, direct I/O, infrastructure imports.");
  lines.push("  Principle: Render state, dispatch intentions. Never compute business outcomes.");
  lines.push("");
  lines.push("**PLUMBING** (utils/, logging/, shared/, markdown/, i18n/)");
  lines.push("  Purpose: Shared utilities — stateless helpers used across layers.");
  lines.push("  What to avoid: Dependencies on any other layer (domain, infra, UI).");
  lines.push("  Principle: Zero context. If it needs to know about a specific layer, it belongs in that layer.");
  lines.push("");

  // ── Dependency Flow ──
  lines.push("### 🔄 Dependency Flow");
  lines.push("  Domain → (nothing except Plumbing)");
  lines.push("  Core → Domain, Infrastructure, Plumbing");
  lines.push("  Infrastructure → Domain, Core, Plumbing (not UI)");
  lines.push("  UI → Domain, Core, Plumbing (avoid Infrastructure directly)");
  lines.push("  Plumbing → (nothing — fully independent)");
  lines.push("");

  // ── Violation Remediation ──
  lines.push("### 💡 When Violations Are Detected");
  lines.push("- Cross-layer import? → Extract an interface in Domain, implement in Infrastructure.");
  lines.push("- Business logic in UI? → Move the logic to Domain, pass results to UI.");
  lines.push("- I/O in Domain? → Wrap it in an Infrastructure adapter, inject via dependency inversion.");
  lines.push("- 'any' type in Domain? → Define a proper interface or type alias.");
  lines.push("- Plumbing importing Core? → Move the logic to Core, or make it a standalone utility.");

  // ── Session Audit (in-memory) ──
  if (sessionKey) {
    const state = sessionStates.get(sessionKey);
    if (state && (state.warningCount > 0 || state.blockCount > 0)) {
      lines.push("");
      lines.push("### 📊 Current Session Audit");
      lines.push(`- Warnings: ${state.warningCount}`);
      lines.push(`- Blocks: ${state.blockCount}`);
      lines.push(`- Files with strikes: ${state.strikeMap.size}`);
      if (state.recentViolations.length > 0) {
        lines.push("- Recent violations:");
        for (const v of state.recentViolations.slice(-5)) {
          lines.push(`  - [${v.level.toUpperCase()}] ${v.message.split("\n")[0]}`);
        }
      }
    }
  }

  // ── Persistent Health Summary ──
  try {
    const store = getStore();
    if (store) {
      const health = store.getHealthSummary();
      if (health.totalViolations > 0) {
        lines.push("");
        lines.push("### 📈 Cumulative Architecture Health");
        lines.push(`- Total violations recorded: ${health.totalViolations}`);
        lines.push(`- Total warnings: ${health.totalWarnings} | blocks: ${health.totalBlocks}`);
        lines.push(`- Files with active strikes: ${health.filesWithStrikes}`);
        if (health.topOffenders.length > 0) {
          lines.push("- Top offenders:");
          for (const f of health.topOffenders) {
            lines.push(`  - ${f.filePath} (${f.strikeCount} strikes)`);
          }
        }
      }
    }
  } catch {
    // Persistence is advisory
  }

  return lines.join("\n");
}

// ── Testing / Lifecycle ─────────────────────────────────────────────────────

/** Reset state for testing purposes. */
export function resetPolicyStateForTest(): void {
  sessionStates.clear();
}

export const __testing = {
  sessionStates,
  MAX_WARNINGS_BEFORE_BLOCK,
  normalizePath,
  resolveContentViolation,
  resolvePathViolation,
} as const;
