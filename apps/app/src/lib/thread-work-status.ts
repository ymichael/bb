import { assertNever, type ThreadWorkStatus } from "@beanbag/agent-core";
import type { StatusPillVariant } from "@beanbag/ui-core";
import { formatDirtyWorkspaceLabel } from "@/lib/workspace-change-summary";

export function threadWorktreeCleanLabel(
  status: ThreadWorkStatus | undefined,
): string {
  if (!status) {
    return "Clean";
  }
  if (status.state === "untracked") {
    return "Untracked";
  }
  if (status.state !== "clean") {
    return "Clean";
  }

  const isUpToDate = status.aheadCount === 0 && status.behindCount === 0;
  return isUpToDate ? "Clean, Up to date" : "Clean";
}

export function threadWorkStatusLabel(
  status: ThreadWorkStatus | undefined,
  options?: { cleanLabel?: string },
): string {
  if (!status) return "Unknown";

  switch (status.state) {
    case "clean":
      return options?.cleanLabel ?? "Up to date";
    case "untracked":
      return "Untracked";
    case "deleted":
      return "Deleted";
    case "dirty_uncommitted":
    case "dirty_and_committed_unmerged":
      return formatDirtyWorkspaceLabel(status);
    case "committed_unmerged":
      return "Ahead";
    default:
      return assertNever(status.state);
  }
}

export function threadWorkStatusVariant(
  status: ThreadWorkStatus | undefined,
  options?: { isArchivedThread?: boolean },
): StatusPillVariant {
  if (!status) return "outline";

  switch (status.state) {
    case "clean":
      return "outline";
    case "untracked":
      return "outline";
    case "deleted":
      return options?.isArchivedThread ? "outline" : "destructive";
    case "dirty_uncommitted":
      return "secondary";
    case "committed_unmerged":
      return "outline";
    case "dirty_and_committed_unmerged":
      return "secondary";
    default:
      return assertNever(status.state);
  }
}
