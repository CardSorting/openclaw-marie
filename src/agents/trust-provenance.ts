import { validateAndSanitizeOutput } from "../security/output-gate.js";

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
   * Validate AND SANITIZE output for security violations.
   *
   * Rejects responses that contain raw memory markers or sensitive host data.
   * Sanitizes PII before it reaches the user.
   */
  async validateOutput(
    response: string,
  ): Promise<{ ok: boolean; sanitized: string; error?: string }> {
    const res = await validateAndSanitizeOutput(response);
    if (!res.ok) {
      return { ok: false, sanitized: "", error: res.error };
    }
    return { ok: true, sanitized: res.sanitized ?? response };
  }
}
