import type { ThreadWorkStatus } from "@bb/core";

type ChangeCounts = {
  changedFiles: number;
  insertions: number;
  deletions: number;
};

type WorkspaceChangeCounts = Pick<
  ThreadWorkStatus,
  "workspaceChangedFiles" | "workspaceInsertions" | "workspaceDeletions"
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

export function hasWorkspaceLineChanges(counts: WorkspaceChangeCounts): boolean {
  return hasLineChanges({
    insertions: counts.workspaceInsertions,
    deletions: counts.workspaceDeletions,
  });
}

export function formatWorkspaceChangeSummary(counts: WorkspaceChangeCounts): string {
  return formatChangeSummary({
    changedFiles: counts.workspaceChangedFiles,
    insertions: counts.workspaceInsertions,
    deletions: counts.workspaceDeletions,
  });
}

export function formatDirtyWorkspaceLabel(counts: WorkspaceChangeCounts): string {
  if (!hasWorkspaceLineChanges(counts)) {
    if (counts.workspaceChangedFiles > 0) {
      return `Dirty ${formatWorkspaceChangedFilesLabel(counts.workspaceChangedFiles)}`;
    }
    return "Dirty";
  }

  return `Dirty +${counts.workspaceInsertions} -${counts.workspaceDeletions}`;
}

export function formatWorkspaceFileStatus(status: string): string {
  if (status === "??") {
    return "A?";
  }

  // Git porcelain status is open_external; preserve unknown values intentionally.
  return status;
}
