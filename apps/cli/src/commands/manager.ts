import { Command } from "commander";
import { action, CliExitError } from "../action.js";

const REMOVED_MANAGER_COMMAND_MESSAGE = [
  "Manager threads were replaced by parent threads.",
  "Use `bb thread spawn --parent-thread <id>` to delegate work,",
  "`bb thread list --parent-thread <id>` to list child threads,",
  "and `bb thread show <id>` to inspect a thread.",
].join(" ");

interface RemovedManagerCommandOptions {
  json?: boolean;
}

function throwRemovedManagerCommand(): never {
  throw new CliExitError(REMOVED_MANAGER_COMMAND_MESSAGE, 1);
}

function registerRemovedManagerSubcommand(
  manager: Command,
  nameAndArgs: string,
  description: string,
): void {
  manager
    .command(nameAndArgs)
    .description(description)
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (_opts: RemovedManagerCommandOptions) => {
        throwRemovedManagerCommand();
      }),
    );
}

export function registerManagerCommands(program: Command): void {
  const manager = program
    .command("manager")
    .description("Compatibility notice for removed manager commands")
    .action(
      action(async () => {
        throwRemovedManagerCommand();
      }),
    );

  registerRemovedManagerSubcommand(
    manager,
    "hire [projectId]",
    "Managers were replaced by parent threads",
  );
  registerRemovedManagerSubcommand(
    manager,
    "list [projectId]",
    "Managers were replaced by parent threads",
  );
  registerRemovedManagerSubcommand(
    manager,
    "status <id>",
    "Managers were replaced by parent threads",
  );
  registerRemovedManagerSubcommand(
    manager,
    "delete <id>",
    "Managers were replaced by parent threads",
  );
}
