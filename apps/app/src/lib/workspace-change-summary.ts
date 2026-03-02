import type { ThreadWorkStatus } from "@beanbag/agent-core";

type WorkspaceChangeCounts = Pick<
  ThreadWorkStatus,
  "workspaceChangedFiles" | "workspaceInsertions" | "workspaceDeletions"
>;

export function formatWorkspaceChangedFilesLabel(changedFiles: number): string {
  return `${changedFiles} file${changedFiles === 1 ? "" : "s"}`;
}

export function hasWorkspaceLineChanges(counts: WorkspaceChangeCounts): boolean {
  return counts.workspaceInsertions > 0 || counts.workspaceDeletions > 0;
}

export function formatWorkspaceChangeSummary(counts: WorkspaceChangeCounts): string {
  const filesLabel = formatWorkspaceChangedFilesLabel(counts.workspaceChangedFiles);
  if (!hasWorkspaceLineChanges(counts)) {
    return filesLabel;
  }

  return `${filesLabel}, +${counts.workspaceInsertions} -${counts.workspaceDeletions}`;
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
