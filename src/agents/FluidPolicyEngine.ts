import crypto from "node:crypto";
import path from "node:path";
import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { TspPolicyPlugin, type JoyZoningLayer } from "../security/TspPolicyPlugin.js";
import { getStrategicEvolutionStore } from "./strategic-evolution-store.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";

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
      const store = await getStrategicEvolutionStore();
      const currentHash = this.calculateHash(params.content);
      const stateKey = `entropy:${params.filePath}`;
      const existingState = store.getSessionState<EntropyState>(params.sessionKey, stateKey);

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

      await store.setSessionState(params.sessionKey, stateKey, {
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
  public async resolveEnforcement(params: {
    strikes: number;
    layer: JoyZoningLayer;
    violations: PolicyViolation[];
    filePath: string;
    content: string;
    sessionKey: string;
  }): Promise<PolicyViolation[]> {
    const successRate = await this.getRemediationSuccessRate(params.sessionKey);
    // Dynamic Steering: If success rate < 50%, lower the threshold to 3 strikes
    const dynamicThreshold = successRate < 0.5 ? 3 : REFACTOR_MODE_THRESHOLD;

    // Heuristic Choke Point Detection
    const isChokePoint = params.strikes > dynamicThreshold + 2 && successRate < 0.3;
    const isRefactorMode = params.strikes >= dynamicThreshold;

    const results = params.violations.map((v) => {
      let message = v.message;
      let level = v.level;

      if (isChokePoint) {
        level = "block";
        message = `🔥 [HEURISTIC CHOKE POINT DETECTED] This file is in an architectural deadlock. Strikes: ${params.strikes}, Remediation Success: ${(successRate * 100).toFixed(1)}%. Manual architectural intervention required immediately. ${message}`;
      }
      // A. Refactor Mode Escalation (High strikes)
      else if (isRefactorMode) {
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

    const blockViolations = params.violations.filter((v) => v.level === "block");
    if (blockViolations.length > 0) {
      void this.triggerAutonomousRemediation({
        filePath: params.filePath,
        content: params.content,
        violations: blockViolations,
        layer: params.layer,
        sessionKey: params.sessionKey,
      }).catch((err) => log.error(`Autonomous remediation failed: ${err}`));
    }

    return results;
  }

  /**
   * Calculates a dynamic success rate for remediation.
   * If remediation is failing, we become stricter (lower block thresholds).
   */
  private async getRemediationSuccessRate(sessionKey: string): Promise<number> {
    try {
      const store = await getStrategicEvolutionStore();
      // Global Wisdom: Query global metrics if session-specific is thin
      const globalStats = store.getStats({ type: "success_rate" });
      const sessionStats = store.getStats({ sessionKey, type: "success_rate" });

      const mean = sessionStats.count > 5 ? sessionStats.mean : globalStats.mean;
      return globalStats.count > 0 ? mean : 1.0;
    } catch {
      return 1.0;
    }
  }

  /**
   * Spawns a subagent to fix the violation.
   * Hardened: Uses persistent locks and verifiable task descriptions.
   */
  private async triggerAutonomousRemediation(params: {
    filePath: string;
    content: string;
    violations: PolicyViolation[];
    layer: JoyZoningLayer;
    sessionKey: string;
  }) {
    const store = await getStrategicEvolutionStore();
    const lockAcquired = await store.acquireLock(
      params.sessionKey,
      `remediate:${params.filePath}`,
      3600_000,
    ); // 1 hour TTL

    if (!lockAcquired) {
      log.info(`Remediation already in progress or locked for ${params.filePath}`);
      return;
    }

    // Critique-Driven Remediation: Inject Lessons Learned from prior failures
    const lessonsLearned = store.getSessionState<string>(
      params.sessionKey,
      `lessons:${params.filePath}`,
    );

    try {
      const violationSummary = params.violations.map((v) => `- ${v.message}`).join("\n");
      const task = `
I am an autonomous remediation subagent fixing an architectural violation in ${params.layer} layer.
File: ${params.filePath}

VIOLATIONS DETECTED:
${violationSummary}
${lessonsLearned ? `\nLESSONS LEARNED FROM PRIOR ATTEMPTS (DO NOT REPEAT THESE MISTAKES):\n${lessonsLearned}\n` : ""}

TASK:
Refactor the file to resolve these violations. Ensure strict adherence to ${params.layer} layer purity.
If you cannot fix it, do not make changes. If you fix it, the system will verify the fix.
`;

      log.info(
        `Spawning autonomous remediation subagent for ${params.filePath}${lessonsLearned ? " (with Lessons Learned)" : ""}`,
      );
      const result = await spawnSubagentDirect(
        {
          task,
          label: `Remediation: ${path.basename(params.filePath)}`,
          attachments: [
            {
              name: path.basename(params.filePath),
              content: params.content,
            },
          ],
        },
        {
          agentSessionKey: params.sessionKey,
        },
      );

      if (result.childSessionKey) {
        await store.setSessionState(result.childSessionKey, "is_remediation", true);
        await store.setSessionState(result.childSessionKey, "remediation_file", params.filePath);
        await store.setSessionState(
          result.childSessionKey,
          "remediation_source_session",
          params.sessionKey,
        );
        await store.setSessionState(result.childSessionKey, "remediation_layer", params.layer);
      }

      emitDiagnosticEvent({
        type: "agent.remediation",
        sessionKey: params.sessionKey,
        filePath: params.filePath,
        success: true,
      });
    } catch (err) {
      emitDiagnosticEvent({
        type: "agent.remediation",
        sessionKey: params.sessionKey,
        filePath: params.filePath,
        success: false,
      });
      throw err;
    }
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
