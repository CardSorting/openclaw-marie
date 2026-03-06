import { createSubsystemLogger } from "../logging/subsystem.js";
import { scanInput } from "./injection-scanner.js";
import { MEMORY_CHAR_CAP, USER_CHAR_CAP } from "../agents/marie-memory.js";

const log = createSubsystemLogger("security/memory-write-gate");

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Pre-write validation gate for MEMORY.md and USER.md.
 *
 * Runs injection scanner and enforces hard caps.
 */
export function validateMemoryWrite(
  content: string,
  type: "memory" | "userModel",
): ValidationResult {
  const cap = type === "memory" ? MEMORY_CHAR_CAP : USER_CHAR_CAP;
  const fileName = type === "memory" ? "MEMORY.md" : "USER.md";

  // 1. Enforce Hard Caps
  if (content.length > cap) {
    const error = `${fileName} write rejected: ${content.length} chars exceeds hard cap of ${cap} chars.`;
    log.warn(error);
    return { ok: false, error };
  }

  // 2. Run Injection Scanner
  const scanResult = scanInput(content, fileName);
  if (scanResult.blocked) {
    const findingDetails = scanResult.findings
      .map((f) => `[${f.patternId}] ${f.description}`)
      .join("; ");
    const error = `${fileName} write blocked due to security threats: ${findingDetails}`;
    log.warn(error);
    return { ok: false, error };
  }

  return { ok: true };
}
