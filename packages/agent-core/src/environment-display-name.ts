interface EnvironmentDisplayNameArgs {
  id?: string | null;
  displayName?: string | null;
}

export function formatEnvironmentDisplayName(
  args: EnvironmentDisplayNameArgs,
): string | undefined {
  const id = args.id?.trim();
  switch (id) {
    case "local":
      return "Direct";
    case "worktree":
      return "Worktree";
    default:
      break;
  }

  const displayName = args.displayName?.trim();
  switch (displayName) {
    case "Local Workspace":
    case "Direct Workspace":
      return "Direct";
    case "Git Worktree Workspace":
      return "Worktree";
    default:
      // Environment ids/display names are open_external runtime values, so
      // unknown values intentionally preserve the server-provided label.
      return displayName || id || undefined;
  }
}
