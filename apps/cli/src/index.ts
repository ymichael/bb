#!/usr/bin/env node
import { Command } from "commander";
import { registerEnvironmentCommands } from "./commands/environment.js";
import { registerGuideCommand } from "./commands/guide.js";
import { registerManagerCommands } from "./commands/manager.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerProviderCommands } from "./commands/provider.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerThreadCommands } from "./commands/thread/index.js";
import { resolveContextSnapshot, resolveServerUrl } from "./context-env.js";

const program = new Command();

program
  .name("bb")
  .description("BB CLI - manage your AI coding agents")
  .version("0.0.1");

program.addHelpText("after", () => {
  const context = resolveContextSnapshot();
  const project = context.projectId ?? "<unset>";
  const thread = context.threadId ?? "<unset>";

  return `

Current context:
  BB_PROJECT_ID: ${project}
  BB_THREAD_ID: ${thread}
  BB_SERVER_URL: ${context.serverUrl}

Quick start:
  bb status
  bb project list
  bb thread show
  bb thread spawn --prompt "..."
`;
});

// Helper to get the URL from the program's options
function getUrl(): string {
  return resolveServerUrl();
}

// Register all command groups
registerStatusCommand(program, getUrl);
registerProjectCommands(program, getUrl);
registerProviderCommands(program, getUrl);
registerManagerCommands(program, getUrl);
registerThreadCommands(program, getUrl);
registerEnvironmentCommands(program, getUrl);
registerGuideCommand(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
