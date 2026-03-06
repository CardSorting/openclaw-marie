import type { Command } from "commander";

export function registerJoyZoningCommand(program: Command) {
  const { registerJoyZoningCli } = require("../joyzoning-cli.js");
  registerJoyZoningCli(program);
}
