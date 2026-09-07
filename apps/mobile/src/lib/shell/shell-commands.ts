export type ShellCommand = { kind: "reload" } | { kind: "clear-website-data" };

type ShellCommandListener = (command: ShellCommand) => void;

const listeners = new Set<ShellCommandListener>();

export function subscribeToShellCommands(
  listener: ShellCommandListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function sendShellCommand(command: ShellCommand): boolean {
  if (listeners.size === 0) return false;
  for (const listener of listeners) listener(command);
  return true;
}
