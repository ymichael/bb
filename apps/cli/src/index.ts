#!/usr/bin/env node

import { Command } from "commander";
import { registerDaemonCommands } from "./commands/daemon.js";
import { registerTaskCommands } from "./commands/task.js";
import { registerThreadCommands } from "./commands/thread.js";

const DEFAULT_URL = "http://localhost:3333";

const program = new Command();

program
  .name("bb")
  .description("Beanbag CLI — manage your AI coding agents")
  .version("0.0.1")
  .option("--url <url>", "Daemon URL", DEFAULT_URL);

// Helper to get the URL from the program's options
function getUrl(): string {
  return program.opts().url ?? DEFAULT_URL;
}

// Register all command groups
registerDaemonCommands(program, getUrl);
registerTaskCommands(program, getUrl);
registerThreadCommands(program, getUrl);

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
