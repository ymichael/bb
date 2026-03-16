import { assertNever, type ThreadWorkStatus } from "@bb/core";
import type { StatusPillVariant } from "@bb/ui-core";
import {
  formatDirtyWorkspaceLabel,
  formatWorkspaceChangeSummary,
} from "@/lib/workspace-change-summary";

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

export interface ThreadGitStatusDisplay {
  label:
    | "Unknown"
    | "Up to date"
    | "Clean"
    | "Ahead"
    | "Behind"
    | "Diverged"
    | "Dirty"
    | "Untracked"
    | "Deleted";
  summary: string;
}

function formatComparisonSummary(
  status: ThreadWorkStatus,
  mergeBaseBranch?: string,
): string | null {
  const { aheadCount, behindCount } = status;
  if (aheadCount === 0 && behindCount === 0) {
    return null;
  }

  if (aheadCount > 0 && behindCount > 0) {
    return mergeBaseBranch
      ? `${aheadCount} ahead, ${behindCount} behind relative to ${mergeBaseBranch}`
      : `${aheadCount} ahead, ${behindCount} behind`;
  }

  if (aheadCount > 0) {
    return mergeBaseBranch
      ? `${aheadCount} ahead of ${mergeBaseBranch}`
      : `${aheadCount} ahead`;
  }

  return mergeBaseBranch
    ? `${behindCount} behind ${mergeBaseBranch}`
    : `${behindCount} behind`;
}

function joinStatusSummary(parts: Array<string | null>): string {
  const filteredParts = parts.filter((part) => part !== null && part.length > 0);
  return filteredParts.join(" • ");
}

export function getThreadGitStatusDisplay(
  status: ThreadWorkStatus | undefined,
  options?: {
    mergeBaseBranch?: string;
    showBranchComparison?: boolean;
  },
): ThreadGitStatusDisplay {
  if (!status) {
    return {
      label: "Unknown",
      summary: "Workspace status unavailable.",
    };
  }

  const comparisonSummary = options?.showBranchComparison
    ? formatComparisonSummary(status, options.mergeBaseBranch)
    : null;
  const hasWorkspaceChanges =
    status.workspaceChangedFiles > 0 ||
    status.workspaceInsertions > 0 ||
    status.workspaceDeletions > 0;
  const workspaceSummary = hasWorkspaceChanges
    ? formatWorkspaceChangeSummary(status)
    : null;

  switch (status.state) {
    case "clean": {
      if (status.aheadCount > 0 && status.behindCount > 0) {
        return {
          label: "Diverged",
          summary: comparisonSummary ?? "Branch has diverged.",
        };
      }
      if (status.aheadCount > 0) {
        return {
          label: "Ahead",
          summary: comparisonSummary ?? "Local commits pending merge.",
        };
      }
      if (status.behindCount > 0) {
        return {
          label: "Behind",
          summary: comparisonSummary ?? "Branch is behind its merge base.",
        };
      }
      return {
        label: options?.showBranchComparison ? "Up to date" : "Clean",
        summary: options?.mergeBaseBranch
          ? `No local changes relative to ${options.mergeBaseBranch}.`
          : "No local changes.",
      };
    }
    case "untracked":
      return {
        label: "Untracked",
        summary: "Workspace is outside a Git repository.",
      };
    case "deleted":
      return {
        label: "Deleted",
        summary: "Workspace deleted.",
      };
    case "dirty_uncommitted":
      return {
        label: "Dirty",
        summary: joinStatusSummary([
          workspaceSummary ?? "Local changes pending commit.",
          comparisonSummary,
        ]),
      };
    case "committed_unmerged":
      if (status.aheadCount > 0 && status.behindCount > 0) {
        return {
          label: "Diverged",
          summary: comparisonSummary ?? "Branch has diverged.",
        };
      }
      if (status.behindCount > 0) {
        return {
          label: "Behind",
          summary: comparisonSummary ?? "Branch is behind its merge base.",
        };
      }
      return {
        label: "Ahead",
        summary: comparisonSummary ?? "Local commits pending merge.",
      };
    case "dirty_and_committed_unmerged":
      return {
        label: "Dirty",
        summary: joinStatusSummary([
          workspaceSummary ?? "Local changes and commits pending merge.",
          comparisonSummary,
        ]),
      };
    default:
      return assertNever(status.state);
  }
}

export function threadWorkStatusDescription(
  status: ThreadWorkStatus | undefined,
): string {
  if (!status) {
    return "Workspace status is unavailable.";
  }

  switch (status.state) {
    case "clean": {
      if (status.aheadCount > 0 && status.behindCount > 0) {
        return "No local file changes, but this branch has diverged from its merge base.";
      }
      if (status.aheadCount > 0) {
        return "No local file changes, but this branch has local commits waiting to be merged.";
      }
      if (status.behindCount > 0) {
        return "No local file changes, but this branch is behind its merge base.";
      }
      return "No local changes or unmerged commits.";
    }
    case "untracked":
      return "Workspace is outside a Git repository.";
    case "deleted":
      return "This workspace no longer exists on disk.";
    case "dirty_uncommitted":
      return "You have local changes that have not been committed yet.";
    case "committed_unmerged":
      if (status.aheadCount > 0 && status.behindCount > 0) {
        return "You have local commits waiting to be merged, and this branch is also behind its merge base.";
      }
      if (status.behindCount > 0) {
        return "You have local commits waiting to be merged, and this branch is behind its merge base.";
      }
      return "You have local commits that have not been merged yet.";
    case "dirty_and_committed_unmerged":
      if (status.behindCount > 0) {
        return "You have uncommitted changes and local commits waiting to be merged, and this branch is behind its merge base.";
      }
      return "You have uncommitted changes and local commits waiting to be merged.";
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
