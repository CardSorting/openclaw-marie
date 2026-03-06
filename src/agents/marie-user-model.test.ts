import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MarieUserModel } from "./marie-user-model.js";
import { writeUserModel } from "./marie-memory.js";

let tmpDir: string;
let userModel: MarieUserModel;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "marie-user-model-test-"));
  userModel = new MarieUserModel(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("marie-user-model", () => {
  it("builds a dialectic prompt with current model", async () => {
    await writeUserModel(tmpDir, "Existing user model content.");
    const prompt = await userModel.buildDialecticPrompt(["User prefers TypeScript.", "User uses dark mode."]);
    
    expect(prompt).toContain("User Model Refinement");
    expect(prompt).toContain("Existing user model content.");
    expect(prompt).toContain("User prefers TypeScript.");
    expect(prompt).toContain("User uses dark mode.");
  });

  it("updates USER.md with a refinement", async () => {
    await writeUserModel(tmpDir, "Initial model.");
    const success = await userModel.updateUserModel("Refined: user likes functional programming.");
    expect(success).toBe(true);

    const content = await fs.readFile(path.join(tmpDir, "USER.md"), "utf8");
    expect(content).toContain("Initial model.");
    expect(content).toContain("Refined: user likes functional programming.");
  });
});
