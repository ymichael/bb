#!/usr/bin/env node

import { Command } from "commander";
import { registerProjectCommands } from "./commands/project.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerTaskCommands } from "./commands/task.js";
import { registerThreadCommands } from "./commands/thread.js";
import { resolveContextSnapshot, resolveDaemonUrl } from "./context-env.js";

const program = new Command();

program
  .name("bb")
  .description("Beanbag CLI - manage your AI coding agents")
  .version("0.0.1");

program.addHelpText("after", () => {
  const context = resolveContextSnapshot();
  const project = context.projectId ?? "<unset>";
  const task = context.taskId ?? "<unset>";
  const thread = context.threadId ?? "<unset>";
  const daemonEnv = context.daemonUrlFromEnv ?? "<unset>";
  const daemonResolved = context.daemonUrl;

  return `

Current context:
  BB_PROJECT_ID: ${project}
  BB_TASK_ID: ${task}
  BB_THREAD_ID: ${thread}
  BB_DAEMON_URL: ${daemonEnv}
  Daemon URL: ${daemonResolved}

Quick start:
  bb status
  bb project list
  bb task status
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
registerTaskCommands(program, getUrl);
registerThreadCommands(program, getUrl);

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
