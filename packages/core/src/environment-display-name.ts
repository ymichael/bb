interface EnvironmentDisplayNameArgs {
  id?: string | null;
  displayName?: string | null;
}

export function isWorktreeEnvironmentReference(args: {
  id?: string | null;
  displayName?: string | null;
}): boolean {
  const id = args.id?.trim();
  if (id === "worktree") {
    return true;
  }

  switch (args.displayName?.trim()) {
    case "Git Worktree Workspace":
    case "Worktree":
      return true;
    default:
      return false;
  }
}

export function formatRuntimeKind(value?: string | null): string | undefined {
  const normalized = value?.trim();
  switch (normalized) {
    case "local":
      return "Direct";
    case "worktree":
      return "New Worktree";
    case "docker":
      return "Docker Sandbox";
    default:
      return normalized || undefined;
  }
}

export function formatEnvironmentDisplayName(
  args: EnvironmentDisplayNameArgs,
): string | undefined {
  const idLabel = formatRuntimeKind(args.id);
  if (idLabel && idLabel !== args.id?.trim()) {
    return idLabel;
  }

  const displayName = args.displayName?.trim();
  switch (displayName) {
    case "Local Workspace":
    case "Direct Workspace":
      return "Direct";
    case "Git Worktree Workspace":
      return "New Worktree";
    default:
      // Environment ids/display names are open_external runtime values, so
      // unknown values intentionally preserve the server-provided label.
      return displayName || idLabel || undefined;
  }
}
