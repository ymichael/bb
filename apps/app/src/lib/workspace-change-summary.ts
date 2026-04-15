import type {
  WorkspaceChangeStats,
  WorkspaceFileStatus,
  WorkspaceStatus,
} from "@bb/domain";

export function formatWorkspaceChangedFilesLabel(changedFiles: number): string {
  return `${changedFiles} file${changedFiles === 1 ? "" : "s"}`;
}

export function formatChangeSummary(stats: WorkspaceChangeStats): string {
  const filesLabel = formatWorkspaceChangedFilesLabel(stats.files.length);
  if (stats.insertions === 0 && stats.deletions === 0) {
    return filesLabel;
  }
  return `${filesLabel}, +${stats.insertions} -${stats.deletions}`;
}

export interface WorkspaceChangedFilesSection {
  kind: "uncommitted" | "untracked" | "committed";
  label: string;
  files: WorkspaceFileStatus[];
  /** Line-level stats for the files in this section. */
  stats: WorkspaceChangeStats;
}

/**
 * Picks the changed-files group to surface in metadata surfaces that only
 * display one list. Priority: modified/staged files, then untracked-only,
 * then committed-unmerged. Untracked is split from "uncommitted" because
 * untracked files aren't staged or modified — the label should reflect that.
 *
 * Returns the resolved stats object alongside the files so callers never have
 * to re-derive which bucket the numbers came from. Untracked-only state
 * surfaces working-tree stats (insertions/deletions are expected to be 0
 * there — git diff doesn't count untracked content).
 */
export function selectWorkspaceChangedFilesSection(
  workspaceStatus: WorkspaceStatus | undefined,
): WorkspaceChangedFilesSection | null {
  if (!workspaceStatus) return null;
  const workingTree = workspaceStatus.workingTree;
  if (workingTree.files.length > 0) {
    const isUntrackedOnly = workingTree.state === "untracked";
    return {
      kind: isUntrackedOnly ? "untracked" : "uncommitted",
      label: isUntrackedOnly ? "Untracked files" : "Uncommitted files",
      files: workingTree.files,
      stats: workingTree,
    };
  }
  const mergeBase = workspaceStatus.mergeBase;
  if (mergeBase && mergeBase.files.length > 0) {
    return {
      kind: "committed",
      label: "Committed files",
      files: mergeBase.files,
      stats: mergeBase,
    };
  }
  return null;
}

export function formatWorkspaceFileStatus(status: string): string {
  if (status === "??") {
    return "A?";
  }

  // Git porcelain status is open_external; preserve unknown values intentionally.
  return status;
}
