import { assertNever, type ThreadWorkStatus } from "@beanbag/agent-core";
import type { StatusPillVariant } from "@/components/shared/StatusPill";
import { formatDirtyWorkspaceLabel } from "@/lib/workspace-change-summary";

export function threadWorkStatusLabel(
  status: ThreadWorkStatus | undefined,
  options?: { cleanLabel?: string },
): string {
  if (!status) return "Unknown";

  switch (status.state) {
    case "clean":
      return options?.cleanLabel ?? "Up to date";
    case "deleted":
      return "Deleted";
    case "dirty_uncommitted":
    case "dirty_and_committed_unmerged":
      return formatDirtyWorkspaceLabel(status);
    case "committed_unmerged":
      return status.currentBranch
        ? `Ahead (${status.currentBranch})`
        : "Ahead";
    default:
      return assertNever(status.state);
  }
}

export function threadWorkStatusVariant(status: ThreadWorkStatus | undefined): StatusPillVariant {
  if (!status) return "outline";

  switch (status.state) {
    case "clean":
      return "outline";
    case "deleted":
      return "destructive";
    case "dirty_uncommitted":
      return "secondary";
    case "committed_unmerged":
      return "default";
    case "dirty_and_committed_unmerged":
      return "destructive";
    default:
      return assertNever(status.state);
  }
}
