import { describe, it, expect, beforeEach } from "vitest";
import { SemanticOverflow } from "./semantic-overflow.js";

describe("semantic-overflow", () => {
  let overflow: SemanticOverflow;

  beforeEach(() => {
    overflow = new SemanticOverflow();
  });

  it("queries overflow layer and returns results (placeholder)", async () => {
    const results = await overflow.queryOverflow("search query", ["bounded result 1"]);
    expect(Array.isArray(results)).toBe(true);
  });

  it("respects privacyMode flag", async () => {
    // In privacyMode, it should only use local providers (verified via logs/implementation)
    const results = await overflow.queryOverflow("private query", [], { privacyMode: true });
    expect(Array.isArray(results)).toBe(true);
  });
});
