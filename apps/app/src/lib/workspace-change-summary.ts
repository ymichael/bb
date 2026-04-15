import type { WorkspaceFileStatus, WorkspaceStatus } from "@bb/domain";

type ChangeCounts = {
  changedFiles: number;
  insertions: number;
  deletions: number;
};

type WorkspaceChangeCounts = Pick<
  WorkspaceStatus["workingTree"],
  "changedFiles" | "insertions" | "deletions"
>;

export function formatWorkspaceChangedFilesLabel(changedFiles: number): string {
  return `${changedFiles} file${changedFiles === 1 ? "" : "s"}`;
}

function hasLineChanges(counts: Pick<ChangeCounts, "insertions" | "deletions">): boolean {
  return counts.insertions > 0 || counts.deletions > 0;
}

export function formatChangeSummary(counts: ChangeCounts): string {
  const filesLabel = formatWorkspaceChangedFilesLabel(counts.changedFiles);
  if (!hasLineChanges(counts)) {
    return filesLabel;
  }

  return `${filesLabel}, +${counts.insertions} -${counts.deletions}`;
}

export function formatWorkspaceChangeSummary(counts: WorkspaceChangeCounts): string {
  return formatChangeSummary({
    changedFiles: counts.changedFiles,
    insertions: counts.insertions,
    deletions: counts.deletions,
  });
}

export interface WorkspaceChangedFilesSection {
  kind: "uncommitted" | "untracked" | "committed";
  label: string;
  files: WorkspaceFileStatus[];
}

/**
 * Picks the changed-files group to surface in metadata surfaces that only
 * display one list. Priority: modified/staged files, then untracked-only,
 * then committed-unmerged. Untracked is split from "uncommitted" because
 * untracked files aren't staged or modified — the label should reflect that.
 */
export function selectWorkspaceChangedFilesSection(
  workspaceStatus: WorkspaceStatus | undefined,
): WorkspaceChangedFilesSection | null {
  if (!workspaceStatus) return null;
  const workingFiles = workspaceStatus.workingTree.files;
  if (workingFiles.length > 0) {
    const isUntrackedOnly = workspaceStatus.workingTree.state === "untracked";
    return {
      kind: isUntrackedOnly ? "untracked" : "uncommitted",
      label: isUntrackedOnly ? "Untracked files" : "Uncommitted files",
      files: workingFiles,
    };
  }
  const committed = workspaceStatus.mergeBase?.files ?? [];
  if (committed.length > 0) {
    return { kind: "committed", label: "Committed files", files: committed };
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
