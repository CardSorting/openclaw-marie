import { createSubsystemLogger } from "../logging/subsystem.js";
import { readUserModel, writeUserModel } from "./marie-memory.js";

const log = createSubsystemLogger("agents/marie-user-model");

export interface DialecticCycle {
  assumption: string;
  confirmation?: boolean;
  refinement?: string;
}

/**
 * Honcho dialectic user modeling.
 *
 * Each cycle refines understanding through user confirmation/correction,
 * creating a compounding behavioral model in USER.md.
 */
export class MarieUserModel {
  constructor(private agentDir: string) {}

  /**
   * Build a dialectic prompt to surface assumptions for user confirmation.
   */
  async buildDialecticPrompt(recentInteractions: string[]): Promise<string> {
    const currentModel = await readUserModel(this.agentDir);

    const lines = [
      "## 👤 User Model Refinement (Dialectic)",
      "",
      "Based on our recent interactions, I've formed the following assumptions",
      "about your preferences and behavioral patterns:",
      "",
      ...recentInteractions.map((i) => `- [Assumption] ${i}`),
      "",
      "Please confirm, correct, or refine these assumptions. Your feedback",
      "will be used to update my long-term behavioral model of you in USER.md.",
      "",
      "### Current Model:",
      "```",
      currentModel || "(empty)",
      "```",
    ];

    return lines.join("\n");
  }

  /**
   * Update USER.md with a validated refinement.
   */
  async updateUserModel(refinement: string): Promise<boolean> {
    const currentModel = await readUserModel(this.agentDir);

    // Compounding logic: append or merge refinement into current model
    const updatedModel = `${currentModel}\n${refinement}`.trim();

    const result = await writeUserModel(this.agentDir, updatedModel);

    if (result.ok) {
      log.info(`USER.md updated with refinement: ${refinement.slice(0, 50)}...`);
    } else {
      log.error(`Failed to update USER.md: ${result.error}`);
    }

    return result.ok;
  }
}
