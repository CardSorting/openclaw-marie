import { createSubsystemLogger } from "../logging/subsystem.js";
import { redactPII } from "./redaction.js";
import { detectHoneyPotLeak } from "./honey-pots.js";
import { emitForensicEvent } from "./quarantine-shadow.js";
import { getJoyZoningStore } from "../infra/joy-zoning-store.js";

const log = createSubsystemLogger("security/output-gate");

export interface OutputValidationResult {
  ok: boolean;
  sanitized?: string;
  error?: string;
}

/**
 * Validates and sanitizes agent output before it is streamed back to the user.
 * Intercepts PII leaks and blocks raw memory echoes.
 * Phase 5: Checks for Honey-pot exfiltration.
 */
export async function validateAndSanitizeOutput(
  content: string,
  options?: { sessionKey?: string },
): Promise<OutputValidationResult> {
  // 1. Honey-pot check (Critical failure)
  const leak = detectHoneyPotLeak(content);
  if (leak) {
    log.warn(`HONEY-POT LEAK DETECTED in output: ${leak.id}`);
    await emitForensicEvent({ type: "HONEYPOT_LEAK", leak: leak.id, channel: "output" });
    const jzStore = getJoyZoningStore();
    await jzStore.incrementStrikes("OUTPUT_LEAK", 5);
    return {
      ok: false,
      sanitized: "[SECURITY LOCKDOWN: Unauthorized data exfiltration detected]",
      error: "SECURITY ERROR: Honey-pot leak detected. Session locked.",
    };
  }

  // 2. Redact PII
  const redaction = redactPII(content);

  // 3. Block raw host path exfiltration (simulated)
  if (content.includes("/etc/passwd") || content.includes("/root/.ssh")) {
    log.warn("Blocked host path exfiltration attempt in output.");
    return { ok: false, error: "SECURITY ERROR: Unauthorized host path access detected." };
  }

  return { ok: true, sanitized: redaction.content };
}
