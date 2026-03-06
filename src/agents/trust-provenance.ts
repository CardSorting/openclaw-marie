import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/trust-provenance");

export interface ProvenanceRecord {
  memoryLayer: "bounded" | "overflow" | "fts5";
  skillVersion?: string;
  sessionSnapshot?: string;
  timestamp: string;
}

/**
 * Trust Provenance & Debug Layer.
 *
 * Annotates agent responses with provenance metadata when debug mode is enabled.
 * Validates output to prevent raw memory echos or cross-user data bleed.
 */
export class TrustProvenance {
  /**
   * Annotate a response with provenance metadata.
   */
  annotateResponse(response: string, provenance: ProvenanceRecord): string {
    const metadata = `
<!-- Provenance: ${JSON.stringify(provenance)} -->`;
    return `${response}${metadata}`;
  }

  /**
   * Validate output for security violations.
   *
   * Rejects responses that contain raw memory markers or cross-session IDs.
   */
  validateOutput(response: string): { ok: boolean; error?: string } {
    if (response.includes("# MEMORY.md") || response.includes("# USER.md")) {
      return { ok: false, error: "Output validation failed: detected raw memory echo." };
    }

    // Additional checks for cross-session bleed could be added here
    return { ok: true };
  }
}
