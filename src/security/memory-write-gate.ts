import { createSubsystemLogger } from "../logging/subsystem.js";
import { scanInput } from "./injection-scanner.js";
import { redactPII } from "./redaction.js";
import { detectHoneyPotLeak } from "./honey-pots.js";
import { getSecurityAuditStore } from "../infra/security-audit-store.js";
import { getJoyZoningStore } from "../infra/joy-zoning-store.js";
import { MEMORY_CHAR_CAP, USER_CHAR_CAP } from "../agents/marie-memory.js";

const log = createSubsystemLogger("security/memory-write-gate");

export interface ValidationResult {
  ok: boolean;
  error?: string;
  redactedContent?: string;
}

const SECURITY_STRIKE_THRESHOLD = 3;

/**
 * Pre-write validation gate for MEMORY.md and USER.md.
 *
 * Runs PII redaction, injection scanner, and enforces hard caps.
 * Integrated with persistent security audit and Joy-Zoning strike system.
 */
export async function validateMemoryWrite(
  content: string,
  type: "memory" | "userModel",
  options?: { sessionKey?: string },
): Promise<ValidationResult> {
  const cap = type === "memory" ? MEMORY_CHAR_CAP : USER_CHAR_CAP;
  const fileName = type === "memory" ? "MEMORY.md" : "USER.md";
  const store = getSecurityAuditStore();
  const jzStore = getJoyZoningStore();

  // 0. Lockdown Check: Block if strikes exceed threshold
  const strikes = jzStore.getStrikeCount(fileName) || 0;
  if (strikes >= SECURITY_STRIKE_THRESHOLD) {
    const error = `SECURITY LOCKDOWN: ${fileName} write blocked due to excessive security strikes (${strikes}). Manual intervention required.`;
    log.error(error);
    return { ok: false, error };
  }

  // 0.5 Honey-pot check: Detect if agent is trying to persist canary secrets
  const leak = detectHoneyPotLeak(content);
  if (leak) {
      log.error(`CRITICAL: Agent attempted to persist honey-pot ${leak.id} to ${fileName}!`);
      await jzStore.incrementStrikes(fileName, 5); // Immediate high strike count
      return { ok: false, error: "SECURITY ERROR: Unauthorized persistence of canary data detected." };
  }

  // 1. Redact PII
  const { content: redacted, redactedCount } = redactPII(content);
  if (redactedCount > 0) {
    log.info(`Scrubbed ${redactedCount} PII tokens from ${fileName}.`);
    void store.recordFinding({
      category: "pii-redaction",
      severity: "info",
      description: `Redacted ${redactedCount} tokens from ${fileName}`,
      context: fileName,
    });
  }

  // 2. Enforce Hard Caps
  if (redacted.length > cap) {
    const error = `${fileName} write rejected: ${redacted.length} chars exceeds hard cap of ${cap} chars.`;
    log.warn(error);
    return { ok: false, error };
  }

  // 3. Run Injection Scanner
  const scanResult = scanInput(redacted, fileName);
  if (scanResult.blocked) {
    const findingDetails = scanResult.findings
      .map((f) => `[${f.patternId}] ${f.description}`)
      .join("; ");
    
    // Log findings to persistent audit store
    for (const finding of scanResult.findings) {
      void store.recordFinding({
        category: finding.category,
        severity: finding.severity,
        description: finding.description,
        matchSnippet: finding.match,
        context: fileName,
      });

      // Increment security strikes for severe violations
      if (finding.severity === "critical" && options?.sessionKey) {
          void jzStore.recordViolation({
              sessionKey: options.sessionKey,
              filePath: fileName,
              layer: "security",
              level: "block",
              message: `Security threat detected: ${finding.description}`,
              severity: "critical",
          });
          void jzStore.getOrIncrementStrike(fileName, finding.description);
      }
    }

    const error = `${fileName} write blocked due to security threats: ${findingDetails}`;
    log.warn(error);
    return { ok: false, error };
  }

  return { ok: true, redactedContent: redacted };
}
