import { assertNever, type ThreadWorkStatus } from "@beanbag/agent-core";
import type { StatusPillVariant } from "@/components/shared/StatusPill";

export function threadWorkStatusLabel(status: ThreadWorkStatus | undefined): string {
  if (!status) return "Unknown";

  if (status.hasUncommittedChanges) {
    return `Dirty +${status.insertions} -${status.deletions}`;
  }
  if (status.hasCommittedUnmergedChanges) {
    return status.currentBranch
      ? `Ahead (${status.currentBranch})`
      : "Ahead";
  }
  return "Up to date";
}

export function threadWorkStatusVariant(status: ThreadWorkStatus | undefined): StatusPillVariant {
  if (!status) return "outline";

  switch (status.state) {
    case "clean":
      return "outline";
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
