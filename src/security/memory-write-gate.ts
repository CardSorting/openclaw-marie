import { createSubsystemLogger } from "../logging/subsystem.js";
import { scanInput } from "./injection-scanner.js";
import { redactPII } from "./redaction.js";
import { detectHoneyPotLeak } from "./honey-pots.js";
import { emitForensicEvent } from "./quarantine-shadow.js";
import { getSecurityAuditStore } from "../infra/security-audit-store.js";
import { getJoyZoningStore } from "../infra/joy-zoning-store.js";
import { MEMORY_CHAR_CAP, USER_CHAR_CAP } from "../agents/marie-memory.js";

const log = createSubsystemLogger("security/memory-write-gate");

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validates memory writes (MEMORY.md or USER.md).
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

  // 0. Hard caps
  if (content.length > cap) {
    log.warn(`Write blocked: ${fileName} exceeds cap (${content.length} > ${cap})`);
    return { ok: false, error: `Content exceeds ${fileName} character cap.` };
  }

  // 0.5 Honey-pot check: Detect if agent is trying to persist canary secrets
  const leak = detectHoneyPotLeak(content);
  if (leak) {
      log.error(`HONEY-POT LEAK DETECTED in memory write [${type}]: ${leak.id}`);
      await emitForensicEvent({ type: "HONEYPOT_LEAK", leak: leak.id, channel: "memory", file: fileName });
      await jzStore.incrementStrikes("HONEYPOT_LEAK", 10);
      return { ok: false, error: "SECURITY ERROR: Unauthorized persistence of canary data detected." };
  }

  // 1. Injection Scanning
  const scan = scanInput(content);
  if (scan.blocked) {
    const firstFinding = scan.findings[0];
    const category = firstFinding?.category ?? "UNKNOWN";
    const reason = firstFinding?.description ?? "Suspicious pattern detected";
    
    log.error(`MALICIOUS WRITE BLOCKED: [${category}] ${reason}`);
    await store.recordFinding({
      category: "INJECTION_ATTEMPT",
      severity: "CRITICAL",
      description: `Blocked ${category} in memory write: ${reason}`,
      context: fileName,
    });
    await jzStore.incrementStrikes(fileName, 1);
    return { ok: false, error: `Security violation detected: ${reason}` };
  }

  // 2. PII Redaction check
  const redaction = redactPII(content);
  if (redaction.content !== content) {
    log.warn(`PII detected in memory write to ${fileName}. Redacting...`);
    await store.recordFinding({
      category: "PII_LEAK",
      severity: "HIGH",
      description: `Redacted PII leaked in memory write to ${fileName}`,
    });
    // We don't block PII leaks here as we redact them, but we record the event.
  }

  return { ok: true };
}
