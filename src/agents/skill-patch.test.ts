import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillPatchManager, SkillPatch } from "./skill-patch.js";
import { createHash } from "node:crypto";

let tmpDir: string;
let manager: SkillPatchManager;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-patch-test-"));
  manager = new SkillPatchManager(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("skill-patch", () => {
  it("applies a valid patch", async () => {
    const skillId = "test-skill";
    const skillDir = path.join(tmpDir, skillId);
    await fs.mkdir(skillDir, { recursive: true });

    const diff = "new skill content";
    const signature = createHash("sha256").update(diff).digest("hex");
    const patch: SkillPatch = {
      skillId,
      version: "1.0.1",
      diff,
      signature,
      timestamp: new Date().toISOString(),
    };

    const success = await manager.applyPatch(patch);
    expect(success).toBe(true);

    const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    expect(content).toBe(diff);

    const history = await fs.readFile(path.join(skillDir, "patch-history.jsonl"), "utf8");
    expect(history).toContain("1.0.1");
  });

  it("rejects patch with invalid signature", async () => {
    const skillId = "test-skill";
    const skillDir = path.join(tmpDir, skillId);
    await fs.mkdir(skillDir, { recursive: true });

    const patch: SkillPatch = {
      skillId,
      version: "1.0.1",
      diff: "malicious content",
      signature: "wrong-signature",
      timestamp: new Date().toISOString(),
    };

    const success = await manager.applyPatch(patch);
    expect(success).toBe(false);
  });

  it("rolls back to a previous version", async () => {
    const skillId = "test-skill";
    const skillDir = path.join(tmpDir, skillId);
    await fs.mkdir(skillDir, { recursive: true });

    // Version 1
    const diff1 = "version 1";
    const patch1: SkillPatch = {
      skillId,
      version: "1.0.0",
      diff: diff1,
      signature: createHash("sha256").update(diff1).digest("hex"),
      timestamp: new Date().toISOString(),
    };
    await manager.applyPatch(patch1);

    // Version 2
    const diff2 = "version 2";
    const patch2: SkillPatch = {
      skillId,
      version: "1.0.1",
      diff: diff2,
      signature: createHash("sha256").update(diff2).digest("hex"),
      timestamp: new Date().toISOString(),
    };
    await manager.applyPatch(patch2);

    // Rollback to v1
    const success = await manager.rollback(skillId, "1.0.0");
    expect(success).toBe(true);

    const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    expect(content).toBe(diff1);
  });
});
