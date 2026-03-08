import type { Command } from "commander";
import { danger, success, warn } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";

export function registerJoyZoningCli(program: Command) {
  const jz = program
    .command("joy-zoning")
    .alias("jz")
    .description("Manage and inspect Joy-Zoning architectural audits")
    .addHelpText(
      "after",
      () => `\n${theme.muted("Docs:")} https://docs.openclaw.ai/features/joy-zoning\n`,
    );

  jz.command("health")
    .description("Show the global Joy-Zoning health summary")
    .action(async () => {
      try {
        const { getJoyZoningStore } = await import("../infra/joy-zoning-store.js");
        const store = getJoyZoningStore();
        const health = store.getHealthSummary();

        defaultRuntime.log(theme.heading("\nJoy-Zoning Global Health Report\n"));
        defaultRuntime.log(`Total Violations: ${theme.accent(health.totalViolations.toString())}`);
        defaultRuntime.log(`Active Warnings:  ${theme.warn(health.totalWarnings.toString())}`);
        defaultRuntime.log(
          `Hard Blocks:      ${health.totalBlocks > 0 ? danger(health.totalBlocks) : success("0")}`,
        );
        defaultRuntime.log(
          `Files w/ Strikes: ${theme.accent(health.filesWithStrikes.toString())}\n`,
        );

        if (health.topOffenders.length > 0) {
          defaultRuntime.log(theme.heading("Top Offenders:"));
          for (const off of health.topOffenders) {
            defaultRuntime.log(
              `  - ${off.filePath}: ${theme.warn(off.strikeCount.toString())} strikes`,
            );
          }
          defaultRuntime.log("");
        } else {
          defaultRuntime.log(success("No active strike offenders.\n"));
        }
      } catch (err) {
        defaultRuntime.error(danger(`Failed to load Joy-Zoning health: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });

  jz.command("prune")
    .description("Manually prune old Joy-Zoning audit records")
    .option("--violations <count>", "Number of recent violations to keep", "5000")
    .action(async (opts: { violations: string }) => {
      try {
        const keepCount = parseInt(opts.violations, 10);
        if (isNaN(keepCount) || keepCount < 0) {
          throw new Error("--violations must be a positive integer");
        }

        const { getJoyZoningStore } = await import("../infra/joy-zoning-store.js");
        const store = getJoyZoningStore();

        defaultRuntime.log(theme.muted(`Pruning violations (keeping last ${keepCount})...`));
        const prunedViolations = await store.pruneViolations(keepCount);

        if (prunedViolations > 0) {
          defaultRuntime.log(success(`Pruned ${prunedViolations} violations.`));
        } else {
          defaultRuntime.log(warn(`No violations needed pruning.`));
        }
      } catch (err) {
        defaultRuntime.error(danger(`Prune failed: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });
}
