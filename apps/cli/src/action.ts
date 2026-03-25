import { getErrorMessage } from "./commands/helpers.js";

type CommandActionArgs = readonly unknown[];
type CommandAction<TArgs extends CommandActionArgs> = (
  ...args: TArgs
) => Promise<void>;

export function action<TArgs extends CommandActionArgs>(
  fn: CommandAction<TArgs>,
): CommandAction<TArgs> {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err: unknown) {
      if (isProcessExitError(err)) {
        throw err;
      }
      console.error(`Error: ${getErrorMessage(err)}`);
      process.exit(1);
    }
  };
}

function isProcessExitError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("process.exit:");
}
