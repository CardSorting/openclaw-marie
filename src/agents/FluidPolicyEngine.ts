import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { TspPolicyPlugin, type JoyZoningLayer } from "../security/TspPolicyPlugin.js";

const log = createSubsystemLogger("agents/fluid-policy-engine");

export interface PolicyViolation {
  level: "warning" | "block";
  message: string;
  sourceLayer: JoyZoningLayer;
  error_retry?: boolean;
}

export interface EntropyState {
  prevResultHash: string | null;
  lastExecutionTs: number;
}

const REFACTOR_MODE_THRESHOLD = 5;

export class FluidPolicyEngine {
  private tspPlugin = new TspPolicyPlugin();
  private entropyMap = new Map<string, EntropyState>();

  /**
   * Orchestrates deep audit and entropy validation for a tool call.
   */
  public async audit(params: {
    filePath: string;
    content: string;
    layer: JoyZoningLayer;
    toolName: string;
    sessionKey: string;
    prevResultHash?: string;
  }): Promise<PolicyViolation[]> {
    const violations: PolicyViolation[] = [];

    // 1. Deep AST Audit
    if (params.filePath.endsWith(".ts") || params.filePath.endsWith(".js")) {
      const tspViolations = this.tspPlugin.audit(params.filePath, params.content, params.layer);
      for (const v of tspViolations) {
        violations.push({
          level: v.severity,
          message: `[TSP] ${v.message} (Line ${v.line}, Col ${v.character}): ${v.nodeText}`,
          sourceLayer: params.layer,
          error_retry: v.severity === "block",
        });
      }
    }

    // 2. Entropy Detection (Drift Validation)
    if (params.prevResultHash) {
      const currentHash = this.calculateHash(params.content);
      const stateKey = `${params.sessionKey}:${params.filePath}`;
      const existingState = this.entropyMap.get(stateKey);

      if (existingState && existingState.prevResultHash !== params.prevResultHash) {
        log.warn(
          `Entropy Drift Detected for ${params.filePath}: Expected ${params.prevResultHash}, got ${currentHash}`,
        );
        violations.push({
          level: "warning",
          message: `⚠️ ENTROPY DRIFT: The file content has diverged from the expected baseline. This may indicate uncoordinated concurrent modifications.`,
          sourceLayer: params.layer,
        });
      }

      this.entropyMap.set(stateKey, {
        prevResultHash: currentHash,
        lastExecutionTs: Date.now(),
      });
    }

    return violations;
  }

  private calculateHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
  }

  /**
   * Validates if a session has exceeded strike thresholds.
   * Moving past "nudging": Strict enforcement for Domain/Core.
   * REFACTOR MODE: Escalates warnings to blocks for high-strike files.
   */
  public resolveEnforcement(params: {
    strikes: number;
    layer: JoyZoningLayer;
    violations: PolicyViolation[];
  }): PolicyViolation[] {
    const isRefactorMode = params.strikes >= REFACTOR_MODE_THRESHOLD;

    return params.violations.map((v) => {
      let message = v.message;
      let level = v.level;

      // A. Refactor Mode Escalation (High strikes)
      if (isRefactorMode) {
        level = "block";
        message = `🛑 REFACTOR MODE (Strike ${params.strikes}): All architectural smells are now BLOCKED until debt is cleared. REFACTOR THIS FILE IMMEDIATELY. ${message}`;
      }

      // B. Hardened Enforcement (Domain/Core purity)
      else if ((params.layer === "Domain" || params.layer === "Core") && params.strikes > 1) {
        level = "block";
        message = `🛑 HARDENED ENFORCEMENT (Strike ${params.strikes}): ${message}\nAutonomy is restricted until architectural integrity is restored. Refactor immediately.`;
      }

      // C. Remediation Advisor: Add concrete suggestions to blocks
      if (level === "block") {
        const advice = this.getRemediationSuggestion(v, params.strikes);
        if (advice) {
          message += `\n\n🛠️ REMEDIATION ADVICE:\n${advice}`;
        }
      }

      return { ...v, level, message };
    });
  }

  private getRemediationSuggestion(violation: PolicyViolation, strikes: number): string | null {
    if (violation.message.includes("DOMAIN PURITY")) {
      return "Extract the concrete logic to an Infrastructure adapter and define an Interface in Domain. Use Dependency Injection to provide the implementation at runtime.";
    }
    if (violation.message.includes("Dependency Inversion")) {
      return "Define a TypeScript 'interface' for this class and export it. Update consumers to depend on the interface instead of the concrete implementation.";
    }
    if (violation.message.includes("PLATFORM LEAKAGE")) {
      return "Domain logic must not use Node.js built-ins. Wrap these calls in an Infrastructure adapter and access them via an interface defined in Domain.";
    }
    if (strikes >= REFACTOR_MODE_THRESHOLD) {
      return "This file has accumulated extreme architectural debt. Break it down into smaller, layer-compliant modules. Move cross-layer dependencies to the appropriate targets.";
    }
    return null;
  }
}

export const fluidPolicyEngine = new FluidPolicyEngine();
