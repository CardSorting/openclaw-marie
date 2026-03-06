import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/skill-patch");

export interface SkillPatch {
  skillId: string;
  version: string;
  diff: string;
  signature: string;
  timestamp: string;
}

export interface PatchHistoryEntry extends SkillPatch {
  appliedBy: string;
}

/**
 * Live patching system for skills.
 *
 * Supports diff application, validation, cryptographic signing, and rollback.
 */
export class SkillPatchManager {
  constructor(private skillDir: string) {}

  /**
   * Apply a patch to a skill.
   */
  async applyPatch(patch: SkillPatch): Promise<boolean> {
    const patchPath = path.join(this.skillDir, patch.skillId, "SKILL.md");
    const historyPath = path.join(this.skillDir, patch.skillId, "patch-history.jsonl");

    // 1. Validate signature (simplified for now, ideally Ed25519)
    if (!this.verifySignature(patch)) {
      log.error(`Invalid patch signature for skill ${patch.skillId}`);
      return false;
    }

    // 2. Apply diff (simplified: assuming full file overwrite for now or use a diff lib)
    await fs.writeFile(patchPath, patch.diff, "utf8");

    // 3. Record history
    const entry: PatchHistoryEntry = {
      ...patch,
      appliedBy: "marie-skill-engine",
    };
    await fs.appendFile(historyPath, JSON.stringify(entry) + "\n", "utf8");

    log.info(`Applied patch v${patch.version} to skill ${patch.skillId}`);
    return true;
  }

  /**
   * Rollback a skill to a specific version.
   */
  async rollback(skillId: string, version: string): Promise<boolean> {
    const historyPath = path.join(this.skillDir, skillId, "patch-history.jsonl");
    const skillPath = path.join(this.skillDir, skillId, "SKILL.md");

    try {
      const content = await fs.readFile(historyPath, "utf8");
      const entries = content.trim().split("\n").map(line => JSON.parse(line) as PatchHistoryEntry);
      const target = entries.find(e => e.version === version);

      if (!target) {
        log.error(`Version ${version} not found in history for skill ${skillId}`);
        return false;
      }

      await fs.writeFile(skillPath, target.diff, "utf8");
      log.info(`Rolled back skill ${skillId} to version ${version}`);
      return true;
    } catch (err) {
      log.error(`Rollback failed for skill ${skillId}: ${String(err)}`);
      return false;
    }
  }

  private verifySignature(patch: SkillPatch): boolean {
    return patch.signature === this.calculateHash(patch.diff);
  }

  private calculateHash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }
}
