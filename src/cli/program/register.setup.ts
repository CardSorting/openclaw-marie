import type { Command } from "commander";
import { onboardCommand } from "../../commands/onboard.js";
import { runNativeSetupFlow } from "../../commands/setup-native.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerSetupCommand(program: Command) {
  program
    .command("setup")
    .description("Initialize ~/.marie/marie.json and the agent workspace")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/setup", "docs.marieai.com/cli/setup")}\n`,
    )
    .option(
      "--workspace <dir>",
      "Agent workspace directory (default: ~/.marie/workspace; stored as agents.defaults.workspace)",
    )
    .option("--wizard", "Run the interactive onboarding wizard", false)
    .option("--non-interactive", "Run the wizard without prompts", false)
    .option("--mode <mode>", "Wizard mode: local|remote")
    .option("--remote-url <url>", "Remote Gateway WebSocket URL")
    .option("--remote-token <token>", "Remote Gateway token (optional)")
    .option("--native", "Run native (non-Docker) setup flow", false)
    .option("--full", "Run full native installation (implies --native)", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        if (opts.native || opts.full) {
          await runNativeSetupFlow(defaultRuntime, {
            nonInteractive: Boolean(opts.nonInteractive),
            full: Boolean(opts.full),
            workspace: opts.workspace as string | undefined,
          });
          return;
        }

        // Run the onboarding wizard by default.
        await onboardCommand(
          {
            workspace: opts.workspace as string | undefined,
            nonInteractive: Boolean(opts.nonInteractive),
            mode: opts.mode as "local" | "remote" | undefined,
            remoteUrl: opts.remoteUrl as string | undefined,
            remoteToken: opts.remoteToken as string | undefined,
          },
          defaultRuntime,
        );
      });
    });
}
