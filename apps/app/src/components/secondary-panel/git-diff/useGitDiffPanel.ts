import { useCallback, useEffect, useMemo, useState } from "react";
import { useEnvironmentMergeBaseBranches } from "../../../hooks/queries/environment-queries";
import type { SecondaryFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import type { ThreadSecondaryPanel as ThreadSecondaryPanelTab } from "@/lib/thread-secondary-panel";

type ThreadSecondaryPanelSetter = (
  panel: ThreadSecondaryPanelTab | null,
) => void;

interface UseGitDiffPanelParams {
  activeSecondaryTab: SecondaryFixedPanelTab | null;
  clearActiveFileTabs: () => void;
  defaultMergeBaseBranch?: string;
  environmentId?: string;
  mergeBaseBranchOptionsEnabled?: boolean;
  setThreadSecondaryPanel: ThreadSecondaryPanelSetter;
  threadId: string;
}

interface SelectedMergeBaseBranchState {
  branch?: string;
  environmentId?: string;
}

type PendingGitDiffIntent =
  | {
      environmentId?: string;
      kind: "commit";
      sha: string;
      threadId: string;
    }
  | {
      environmentId?: string;
      kind: "file";
      path: string;
      threadId: string;
    };

export function useGitDiffPanel({
  activeSecondaryTab,
  clearActiveFileTabs,
  defaultMergeBaseBranch,
  environmentId,
  mergeBaseBranchOptionsEnabled = false,
  setThreadSecondaryPanel,
  threadId,
}: UseGitDiffPanelParams) {
  const [selectedMergeBaseBranchState, setSelectedMergeBaseBranchState] =
    useState<SelectedMergeBaseBranchState>({ environmentId });
  const selectedMergeBaseBranch =
    selectedMergeBaseBranchState.environmentId === environmentId
      ? selectedMergeBaseBranchState.branch
      : undefined;
  const setSelectedMergeBaseBranch = useCallback(
    (branch: string | undefined) => {
      setSelectedMergeBaseBranchState({ branch, environmentId });
    },
    [environmentId],
  );
  const [pendingGitDiffIntent, setPendingGitDiffIntent] =
    useState<PendingGitDiffIntent | null>(null);
  const currentPendingGitDiffIntent =
    pendingGitDiffIntent !== null &&
    pendingGitDiffIntent.environmentId === environmentId &&
    pendingGitDiffIntent.threadId === threadId
      ? pendingGitDiffIntent
      : null;
  const pendingGitDiffCommitSha =
    currentPendingGitDiffIntent?.kind === "commit"
      ? currentPendingGitDiffIntent.sha
      : null;
  const pendingGitDiffScrollPath =
    currentPendingGitDiffIntent?.kind === "file"
      ? currentPendingGitDiffIntent.path
      : null;
  const clearPendingGitDiffIntent = useCallback(() => {
    setPendingGitDiffIntent((current) =>
      current !== null &&
      current.environmentId === environmentId &&
      current.threadId === threadId
        ? null
        : current,
    );
  }, [environmentId, threadId]);
  const [mergeBaseBranchSearchQuery, setMergeBaseBranchSearchQuery] =
    useState("");
  const requestedMergeBaseBranch =
    selectedMergeBaseBranch ?? defaultMergeBaseBranch;

  const {
    data: mergeBaseBranches,
    isFetching: isLoadingMergeBaseBranchOptions,
  } = useEnvironmentMergeBaseBranches(environmentId ?? "", {
    enabled:
      Boolean(environmentId) &&
      (mergeBaseBranchOptionsEnabled ||
        activeSecondaryTab?.kind === "git-diff"),
    query: mergeBaseBranchSearchQuery,
    selectedBranch: requestedMergeBaseBranch,
  });
  const selectedMergeBaseBranchRef = mergeBaseBranches?.selectedBranch;
  const mergeBaseBranchList = mergeBaseBranches?.branches;
  const mergeBaseRemoteBranchList = mergeBaseBranches?.remoteBranches;
  const mergeBaseBranchOptions = useMemo(() => {
    if (!mergeBaseBranchList) {
      return undefined;
    }

    return selectedMergeBaseBranchRef?.kind === "local" &&
      !mergeBaseBranchList.includes(selectedMergeBaseBranchRef.name)
      ? [selectedMergeBaseBranchRef.name, ...mergeBaseBranchList]
      : mergeBaseBranchList;
  }, [mergeBaseBranchList, selectedMergeBaseBranchRef]);
  const mergeBaseRemoteBranchOptions = useMemo(() => {
    if (!mergeBaseRemoteBranchList) {
      return undefined;
    }

    return selectedMergeBaseBranchRef?.kind === "remote" &&
      !mergeBaseRemoteBranchList.includes(selectedMergeBaseBranchRef.name)
      ? [selectedMergeBaseBranchRef.name, ...mergeBaseRemoteBranchList]
      : mergeBaseRemoteBranchList;
  }, [mergeBaseRemoteBranchList, selectedMergeBaseBranchRef]);
  useEffect(() => {
    setMergeBaseBranchSearchQuery("");
    setPendingGitDiffIntent(null);
  }, [environmentId, threadId]);

  const openThreadDiffPanel = useCallback(() => {
    setThreadSecondaryPanel("git-diff");
  }, [setThreadSecondaryPanel]);

  const closeThreadSecondaryPanel = useCallback(() => {
    setThreadSecondaryPanel(null);
  }, [setThreadSecondaryPanel]);

  const openDiffFile = useCallback(
    (path: string) => {
      clearActiveFileTabs();
      setPendingGitDiffIntent({ environmentId, kind: "file", path, threadId });
      openThreadDiffPanel();
    },
    [clearActiveFileTabs, environmentId, openThreadDiffPanel, threadId],
  );

  const openCommitDiff = useCallback(
    (sha: string) => {
      clearActiveFileTabs();
      setPendingGitDiffIntent({ environmentId, kind: "commit", sha, threadId });
      openThreadDiffPanel();
    },
    [clearActiveFileTabs, environmentId, openThreadDiffPanel, threadId],
  );

  return {
    closeThreadSecondaryPanel,
    clearPendingGitDiffIntent,
    isLoadingMergeBaseBranchOptions,
    mergeBaseBranchOptions,
    mergeBaseRemoteBranchOptions,
    openCommitDiff,
    openDiffFile,
    openThreadDiffPanel,
    pendingGitDiffCommitSha,
    pendingGitDiffScrollPath,
    requestedMergeBaseBranch,
    selectedMergeBaseBranch,
    selectedMergeBaseBranchRef,
    setMergeBaseBranchSearchQuery,
    setSelectedMergeBaseBranch,
  };
}
