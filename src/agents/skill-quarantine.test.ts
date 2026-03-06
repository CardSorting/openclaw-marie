import { describe, it, expect, beforeEach } from "vitest";
import { SkillQuarantine } from "./skill-quarantine.js";

describe("skill-quarantine", () => {
  let quarantine: SkillQuarantine;

  beforeEach(() => {
    quarantine = new SkillQuarantine();
  });

  it("passes a clean skill and provides signature", async () => {
    const result = await quarantine.quarantineSkill("/path/to/clean-skill");
    expect(result.passed).toBe(true);
    expect(result.signature).toBeTruthy();
    expect(result.findings.length).toBe(0);
  });

  it("verifies a valid trust signature", async () => {
    const signature = "marie-trusted-signature-placeholder";
    const isValid = await quarantine.verifyTrust("/path/to/skill", signature);
    expect(isValid).toBe(true);
  });

  it("fails verification for empty signature", async () => {
    const isValid = await quarantine.verifyTrust("/path/to/skill", "");
    expect(isValid).toBe(false);
  });
});
