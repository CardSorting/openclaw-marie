import { describe, it, expect, beforeEach, vi } from "vitest";
import * as scanner from "../security/skill-scanner.js";
import { SkillQuarantine } from "./skill-quarantine.js";

vi.mock("../security/skill-scanner.js", () => ({
  scanDirectoryWithSummary: vi.fn(),
}));

describe("skill-quarantine", () => {
  let quarantine: SkillQuarantine;
  const secretKey = "test-secret-key";

  beforeEach(() => {
    vi.resetAllMocks();
    quarantine = new SkillQuarantine({ secretKey });
  });

  it("passes a clean skill and provides valid HMAC signature", async () => {
    vi.mocked(scanner.scanDirectoryWithSummary).mockResolvedValue({
      scannedFiles: 1,
      critical: 0,
      warn: 0,
      info: 0,
      findings: [],
    });

    const skillPath = "/path/to/clean-skill";
    const result = await quarantine.quarantineSkill(skillPath);

    expect(result.passed).toBe(true);
    expect(result.signature).toBeTruthy();
    expect(result.signature).not.toBe("marie-trusted-signature-placeholder");
    expect(result.findings.length).toBe(0);

    const isValid = await quarantine.verifyTrust(skillPath, result.signature!);
    expect(isValid).toBe(true);
  });

  it("fails a skill with critical findings", async () => {
    vi.mocked(scanner.scanDirectoryWithSummary).mockResolvedValue({
      scannedFiles: 1,
      critical: 1,
      warn: 0,
      info: 0,
      findings: [
        {
          ruleId: "dangerous-exec",
          severity: "critical",
          file: "/path/to/skill/bad.ts",
          line: 10,
          message: "Shell command execution detected",
          evidence: "exec('rm -rf /')",
        },
      ],
    });

    const result = await quarantine.quarantineSkill("/path/to/bad-skill");
    expect(result.passed).toBe(false);
    expect(result.signature).toBeUndefined();
    expect(result.findings[0]).toContain("dangerous-exec: Shell command execution detected");
  });

  it("fails verification for incorrect signature", async () => {
    const isValid = await quarantine.verifyTrust("/path/to/skill", "wrong-signature");
    expect(isValid).toBe(false);
  });

  it("fails verification for empty signature", async () => {
    const isValid = await quarantine.verifyTrust("/path/to/skill", "");
    expect(isValid).toBe(false);
  });
});
