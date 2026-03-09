import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { intro, outro, spinner, confirm, note } from "@clack/prompts";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import type { RuntimeEnv } from "../runtime.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";

export type NativeSetupOptions = {
  nonInteractive?: boolean;
  full?: boolean;
  workspace?: string;
  verbose?: boolean;
};

export async function runNativeSetupFlow(runtime: RuntimeEnv, opts: NativeSetupOptions = {}) {
  // Early Node version guard
  assertSupportedRuntime(runtime);

  if (!opts.nonInteractive) {
    intro(stylePromptTitle("Native Setup") ?? "Native Setup");
  } else {
    runtime.log("Running Native Setup (non-interactive)...");
  }

  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });

  if (!root) {
    if (!opts.nonInteractive) {
      note(
        "Could not detect OpenClaw source root. This command is intended for local checkouts.",
        "Native Setup",
      );
      outro("Setup aborted.");
    } else {
      runtime.error("Setup aborted: Could not detect OpenClaw source root.");
    }
    return;
  }

  const isSource = await fs
    .access(path.join(root, "src"))
    .then(() => true)
    .catch(() => false);
  if (!isSource) {
    if (!opts.nonInteractive) {
      note("No src/ directory found. This appears to be a production install.", "Native Setup");
      outro("Setup aborted.");
    } else {
      runtime.error("Setup aborted: No src/ directory found.");
    }
    return;
  }

  if (!opts.nonInteractive) {
    note(`Found OpenClaw source at: ${root}`, "Native Setup");
  }

  // Check for pnpm
  let hasPnpm = await checkCommand("pnpm");
  if (!hasPnpm) {
    const shouldInstallPnpm =
      opts.full ||
      (opts.nonInteractive
        ? true
        : await confirm({
            message: "pnpm is not installed. Install pnpm globally via npm?",
            initialValue: true,
          }));

    if (shouldInstallPnpm) {
      const s = opts.nonInteractive ? null : spinner();
      s?.start("Installing pnpm...");
      try {
        const sudoPrefix = (await needsSudoForGlobal()) ? "sudo " : "";
        runQuietCommand(`${sudoPrefix}npm install -g pnpm`, {
          runtime,
          label: "pnpm installation",
        });
        s?.stop("pnpm installed.");
        hasPnpm = true;
      } catch {
        s?.stop("pnpm installation failed.");
        runtime.error("Could not install pnpm. Please install it manually.");
        return;
      }
    } else {
      runtime.error("pnpm is required for native setup.");
      return;
    }
  }

  // Robust BuildTools check
  const tools = ["make", "gcc", "g++", "cmake", "python3"];
  const missingTools = [];
  for (const tool of tools) {
    if (!(await checkCommand(tool))) {
      missingTools.push(tool);
    }
  }

  if (missingTools.length > 0 && !opts.nonInteractive) {
    note(
      `Missing build tools: ${missingTools.join(", ")}\nSome native dependencies (like sharp or node-llama-cpp) might fail to build.`,
      "Build Tools",
    );
  }

  // Install deps?
  const shouldInstall =
    opts.full ||
    (opts.nonInteractive
      ? true
      : await confirm({
          message: "Install dependencies (pnpm install)?",
          initialValue: true,
        }));

  if (shouldInstall) {
    const s = opts.nonInteractive ? null : spinner();
    s?.start("pnpm install...");
    try {
      runQuietCommand("pnpm install", { cwd: root, runtime, label: "pnpm install" });
      s?.stop("Dependencies installed.");
    } catch {
      s?.stop("pnpm install failed.");
      return; // Stop on failure
    }
  }

  // Build?
  const shouldBuild =
    opts.full ||
    (opts.nonInteractive
      ? true
      : await confirm({
          message: "Build the project (pnpm build)?",
          initialValue: true,
        }));

  if (shouldBuild) {
    const s = opts.nonInteractive ? null : spinner();
    s?.start("pnpm build...");
    try {
      runQuietCommand("pnpm build", { cwd: root, runtime, label: "pnpm build" });
      s?.stop("Build complete.");
    } catch {
      s?.stop("pnpm build failed.");
      return;
    }
  }

  if (!opts.nonInteractive) {
    note(
      ["Native setup complete!", `Next step: ${formatCliCommand("openclaw onboarding")}`].join(
        "\n",
      ),
      "Native Setup",
    );
    outro("Setup complete.");
  } else {
    runtime.log("Native setup complete.");
  }
}

async function checkCommand(cmd: string): Promise<boolean> {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function needsSudoForGlobal(): Promise<boolean> {
  if (process.platform === "win32") {
    return false;
  }
  try {
    execSync("npm install -g --dry-run openclaw-permission-test", { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

function runQuietCommand(cmd: string, opts: { cwd?: string; runtime: RuntimeEnv; label: string }) {
  try {
    execSync(cmd, { cwd: opts.cwd, stdio: "pipe" });
  } catch (err: unknown) {
    opts.runtime.error(`${opts.label} failed.`);
    const error = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    if (error.stdout) {
      opts.runtime.log(String(error.stdout));
    }
    if (error.stderr) {
      opts.runtime.error(String(error.stderr));
    }
    throw err;
  }
}
