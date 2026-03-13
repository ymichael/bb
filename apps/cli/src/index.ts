#!/usr/bin/env node

import { Command } from "commander";
import { registerDaemonCommands } from "./commands/daemon.js";
import { registerEnvironmentAgentCommand } from "./commands/environment-agent.js";
import { registerManagerCommands } from "./commands/manager.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerThreadCommands } from "./commands/thread.js";
import { normalizeCliArgv } from "./argv-normalization.js";
import { resolveContextSnapshot, resolveDaemonUrl } from "./context-env.js";

const program = new Command();

program
  .name("bb")
  .description("Beanbag CLI - manage your AI coding agents")
  .version("0.0.1");

program.addHelpText("after", () => {
  const context = resolveContextSnapshot();
  const project = context.projectId ?? "<unset>";
  const thread = context.threadId ?? "<unset>";
  const daemonEnv = context.daemonUrlFromEnv ?? "<unset>";
  const daemonResolved = context.daemonUrl;

  return `

Current context:
  BB_PROJECT_ID: ${project}
  BB_THREAD_ID: ${thread}
  BB_DAEMON_URL: ${daemonEnv}
  Daemon URL: ${daemonResolved}

Quick start:
  bb status
  bb project list
  bb thread status
  bb thread spawn --prompt "..."
`;
});

// Helper to get the URL from the program's options
function getUrl(): string {
  return resolveDaemonUrl();
}

// Register all command groups
registerStatusCommand(program, getUrl);
registerProjectCommands(program, getUrl);
registerManagerCommands(program, getUrl);
registerThreadCommands(program, getUrl);
registerDaemonCommands(program, getUrl);
registerEnvironmentAgentCommand(program);

program.parseAsync(normalizeCliArgv(process.argv)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
