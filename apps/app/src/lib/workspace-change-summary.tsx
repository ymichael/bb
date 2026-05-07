import type { ReactNode } from "react";
import type {
  WorkspaceChangeStats,
  WorkspaceFileStatus,
  WorkspaceStatus,
} from "@bb/domain";
import { DiffStatsTally } from "@/components/ui";

export interface ChangeTally {
  filesCount: number;
  insertions: number;
  deletions: number;
}

export function toChangeTally(stats: WorkspaceChangeStats): ChangeTally {
  return {
    filesCount: stats.files.length,
    insertions: stats.insertions,
    deletions: stats.deletions,
  };
}

export function formatWorkspaceChangedFilesLabel(changedFiles: number): string {
  return `${changedFiles} file${changedFiles === 1 ? "" : "s"}`;
}

export function formatChangeSummary(tally: ChangeTally): string {
  if (
    tally.filesCount === 0 &&
    tally.insertions === 0 &&
    tally.deletions === 0
  ) {
    return "No changes";
  }
  const filesLabel = formatWorkspaceChangedFilesLabel(tally.filesCount);
  if (tally.insertions === 0 && tally.deletions === 0) {
    return filesLabel;
  }
  return `${filesLabel}, +${tally.insertions} -${tally.deletions}`;
}

export function renderChangeSummary(tally: ChangeTally): ReactNode {
  if (
    tally.filesCount === 0 &&
    tally.insertions === 0 &&
    tally.deletions === 0
  ) {
    return "No changes";
  }
  const filesLabel = formatWorkspaceChangedFilesLabel(tally.filesCount);
  if (tally.insertions === 0 && tally.deletions === 0) {
    return filesLabel;
  }
  return (
    <>
      {filesLabel},{" "}
      <DiffStatsTally
        insertions={tally.insertions}
        deletions={tally.deletions}
      />
    </>
  );
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
