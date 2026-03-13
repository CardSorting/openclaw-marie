import { describe, it, expect, beforeEach } from "vitest";
import { TrustProvenance, ProvenanceRecord } from "./trust-provenance.js";

describe("trust-provenance", () => {
  let trust: TrustProvenance;

  beforeEach(() => {
    trust = new TrustProvenance();
  });

  it("annotates response with provenance metadata", () => {
    const response = "Hello world";
    const provenance: ProvenanceRecord = {
      memoryLayer: "bounded",
      timestamp: new Date().toISOString(),
    };
    const annotated = trust.annotateResponse(response, provenance);
    expect(annotated).toContain("Hello world");
    expect(annotated).toContain("<!-- Provenance:");
    expect(annotated).toContain('"memoryLayer":"bounded"');
  });

  it("validates output against raw memory echo", async () => {
    const maliciousResponse = "Here is my memory: # MEMORY.md content";
    const result = await trust.validateOutput(maliciousResponse);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("detected raw memory echo");
  });

  it("passes clean output validation", async () => {
    const cleanResponse = "This is a normal message.";
    const result = await trust.validateOutput(cleanResponse);
    expect(result.ok).toBe(true);
  });
});
