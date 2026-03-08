import { createSubsystemLogger } from "../logging/subsystem.js";
import { redactPII } from "./redaction.js";
import { detectHoneyPotLeak } from "./honey-pots.js";
import { getJoyZoningStore } from "../infra/joy-zoning-store.js";

const log = createSubsystemLogger("security/output-gate");

export interface OutputValidationResult {
  ok: boolean;
  sanitized: string;
  error?: string;
  blocked?: boolean;
}

/**
 * Validates and sanitizes outgoing agent responses.
 */
export async function validateAndSanitizeOutput(
  content: string,
  options?: { sessionKey?: string },
): Promise<OutputValidationResult> {
  let sanitized = content;
  let blocked = false;

  // 1. Honey-pot check (Critical failure)
  const leak = detectHoneyPotLeak(content);
  if (leak) {
      log.error(`CRITICAL: Agent attempted to leak honey-pot ${leak.id}! Locking session.`);
      const jzStore = getJoyZoningStore();
      await jzStore.incrementStrikes("OUTPUT_LEAK", 5); // Immediate high strike count
      return {
          ok: false,
          sanitized: "",
          blocked: true,
          error: "SECURITY LOCKDOWN: Unauthorized data access detected (Canary Triggered)."
      };
  }

  // 2. Block raw memory echoes (from trust-provenance logic)
  if (content.includes("# MEMORY.md") || content.includes("# USER.md")) {
    log.warn("Blocked output containing raw memory headers.");
    return { ok: false, blocked: true, sanitized: "", error: "Output validation failed: raw memory echo detected." };
  }

  // 3. Redact PII and Secrets
  const { content: redacted, redactedCount } = redactPII(sanitized);
  if (redactedCount > 0) {
    log.info(`Sanitized ${redactedCount} PII tokens from outgoing response.`);
    sanitized = redacted;
  }

  // 3. Prevent path exfiltration (host paths)
  if (/\/etc\/shadow|\/proc\/self\/environ/i.test(sanitized)) {
     log.warn("Blocked output containing sensitive host paths.");
     return { ok: false, blocked: true, sanitized: "", error: "Output validation failed: sensitive host data detected." };
  }

  return {
    ok: true,
    sanitized,
    blocked: false
  };
}
