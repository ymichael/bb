import { assertNever } from "@bb/core-ui";
import type { WorkspaceStatus } from "@bb/domain";
import { HttpError } from "@/lib/api";
import {
  formatWorkspaceChangeSummary,
} from "@/lib/workspace-change-summary";

interface ThreadGitStatusDisplay {
  label:
    | "Unknown"
    | "Deleted"
    | "Up to date"
    | "Clean"
    | "Ahead"
    | "Behind"
    | "Diverged"
    | "Dirty"
    | "Untracked";
  summary: string;
}

function formatComparisonSummary(
  status: WorkspaceStatus,
  mergeBaseBranch?: string,
): string | null {
  const aheadCount = status.mergeBase?.aheadCount ?? 0;
  const behindCount = status.mergeBase?.behindCount ?? 0;
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

export function getGitStatusDisplay(
  status: WorkspaceStatus | undefined,
  options?: {
    mergeBaseBranch?: string;
    showBranchComparison?: boolean;
    error?: unknown;
    workspaceDeleted?: boolean;
  },
): ThreadGitStatusDisplay {
  if (!status) {
    const isPathNotFound =
      options?.error instanceof HttpError && options.error.code === "path_not_found";
    if (options?.workspaceDeleted || isPathNotFound) {
      return {
        label: "Deleted",
        summary: "Workspace deleted.",
      };
    }
    return {
      label: "Unknown",
      summary: "Workspace status unavailable.",
    };
  }

  const resolvedMergeBaseBranch = options?.mergeBaseBranch ?? status.mergeBase?.mergeBaseBranch;
  const comparisonSummary = options?.showBranchComparison
    ? formatComparisonSummary(status, resolvedMergeBaseBranch)
    : null;
  const hasWorkspaceChanges =
    status.workingTree.changedFiles > 0 ||
    status.workingTree.insertions > 0 ||
    status.workingTree.deletions > 0;
  const workspaceSummary = hasWorkspaceChanges
    ? formatWorkspaceChangeSummary(status.workingTree)
    : null;

  switch (status.workingTree.state) {
    case "clean": {
      if ((status.mergeBase?.aheadCount ?? 0) > 0 && (status.mergeBase?.behindCount ?? 0) > 0) {
        return {
          label: "Diverged",
          summary: comparisonSummary ?? "Branch has diverged.",
        };
      }
      if ((status.mergeBase?.aheadCount ?? 0) > 0) {
        return {
          label: "Ahead",
          summary: comparisonSummary ?? "Local commits pending merge.",
        };
      }
      if ((status.mergeBase?.behindCount ?? 0) > 0) {
        return {
          label: "Behind",
          summary: comparisonSummary ?? "Branch is behind its merge base.",
        };
      }
      return {
        label: options?.showBranchComparison ? "Up to date" : "Clean",
        summary: resolvedMergeBaseBranch
          ? `No local changes relative to ${resolvedMergeBaseBranch}.`
          : "No local changes.",
      };
    }
    case "untracked":
      return {
        label: "Untracked",
        summary: joinStatusSummary([
          workspaceSummary ?? "Untracked files",
          comparisonSummary,
        ]),
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
      if ((status.mergeBase?.aheadCount ?? 0) > 0 && (status.mergeBase?.behindCount ?? 0) > 0) {
        return {
          label: "Diverged",
          summary: comparisonSummary ?? "Branch has diverged.",
        };
      }
      if ((status.mergeBase?.behindCount ?? 0) > 0) {
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
      return assertNever(status.workingTree.state);
  }
}

export function workspaceStatusDescription(
  status: WorkspaceStatus | undefined,
): string {
  if (!status) {
    return "Workspace status is unavailable.";
  }

  switch (status.workingTree.state) {
    case "clean": {
      if ((status.mergeBase?.aheadCount ?? 0) > 0 && (status.mergeBase?.behindCount ?? 0) > 0) {
        return "No local file changes, but this branch has diverged from its merge base.";
      }
      if ((status.mergeBase?.aheadCount ?? 0) > 0) {
        return "No local file changes, but this branch has local commits waiting to be merged.";
      }
      if ((status.mergeBase?.behindCount ?? 0) > 0) {
        return "No local file changes, but this branch is behind its merge base.";
      }
      return "No local changes or unmerged commits.";
    }
    case "untracked":
      if ((status.mergeBase?.behindCount ?? 0) > 0) {
        return "Workspace has untracked files, and this branch is behind its merge base.";
      }
      return "Workspace has untracked files that have not been committed yet.";
    case "dirty_uncommitted":
      return "You have local changes that have not been committed yet.";
    case "committed_unmerged":
      if ((status.mergeBase?.aheadCount ?? 0) > 0 && (status.mergeBase?.behindCount ?? 0) > 0) {
        return "You have local commits waiting to be merged, and this branch is also behind its merge base.";
      }
      if ((status.mergeBase?.behindCount ?? 0) > 0) {
        return "You have local commits waiting to be merged, and this branch is behind its merge base.";
      }
      return "You have local commits that have not been merged yet.";
    case "dirty_and_committed_unmerged":
      if ((status.mergeBase?.behindCount ?? 0) > 0) {
        return "You have uncommitted changes and local commits waiting to be merged, and this branch is behind its merge base.";
      }
      return "You have uncommitted changes and local commits waiting to be merged.";
    default:
      return assertNever(status.workingTree.state);
  }
}
