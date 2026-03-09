import { createSubsystemLogger } from "../logging/subsystem.js";
import { scanInput } from "./injection-scanner.js";

const log = createSubsystemLogger("security/tool-result-validator");

export interface ValidationResult {
  ok: boolean;
  error?: string;
  quarantined: boolean;
}

/**
 * Tool output validator.
 *
 * Treats tool outputs as untrusted until validated. Runs injection pattern
 * matching on tool results. Results matching patterns are quarantined.
 */
export function validateToolResult(result: unknown, toolName: string): ValidationResult {
  const content = typeof result === "string" ? result : JSON.stringify(result);

  // Run injection scanner on tool output
  const scanResult = scanInput(content, `tool:${toolName}`);

  if (scanResult.blocked) {
    const findingDetails = scanResult.findings
      .map((f) => `[${f.patternId}] ${f.description}`)
      .join("; ");
    const error = `Tool result from '${toolName}' quarantined due to security threats: ${findingDetails}`;
    log.warn(error);
    return { ok: false, error, quarantined: true };
  }

  return { ok: true, quarantined: false };
}
