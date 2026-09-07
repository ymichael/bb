import { useCallback, useEffect, useMemo, useState } from "react";
import { useEnvironmentWorkStatus } from "../../../hooks/queries/environment-queries";
import type { GitDiffSelectionOption } from "../GitDiffToolbar";
import {
  ALL_GIT_DIFF_SELECTION,
  buildGitDiffSelectionOptions,
  buildGitDiffTarget,
  shouldResetSelectedGitDiffSelection,
  type GitDiffSelectionValue,
} from "./gitDiffPanelHelpers";

interface UseGitDiffPanelStateParams {
  environmentId?: string;
  isDiffPanelActive: boolean;
  requestedMergeBaseBranch?: string;
  onClearPendingGitDiffIntent?: () => void;
  pendingGitDiffCommitSha?: string | null;
  pendingGitDiffScrollPath?: string | null;
}

export function useGitDiffPanelState({
  environmentId,
  isDiffPanelActive,
  requestedMergeBaseBranch,
  onClearPendingGitDiffIntent,
  pendingGitDiffCommitSha,
  pendingGitDiffScrollPath,
}: UseGitDiffPanelStateParams) {
  const [selectedGitDiffSelection, setSelectedGitDiffSelection] =
    useState<GitDiffSelectionValue>(null);

  const gitDiffTarget = useMemo(
    () =>
      buildGitDiffTarget(selectedGitDiffSelection, requestedMergeBaseBranch),
    [requestedMergeBaseBranch, selectedGitDiffSelection],
  );
  const { data: gitDiffWorkspaceStatus } = useEnvironmentWorkStatus(
    environmentId ?? "",
    requestedMergeBaseBranch,
    {
      enabled:
        Boolean(environmentId) &&
        Boolean(requestedMergeBaseBranch) &&
        isDiffPanelActive,
    },
  );
  const workspaceStatus =
    gitDiffWorkspaceStatus?.outcome === "available"
      ? gitDiffWorkspaceStatus.workspace
      : undefined;

  useEffect(() => {
    setSelectedGitDiffSelection(null);
  }, [environmentId]);

  useEffect(() => {
    if (pendingGitDiffScrollPath) {
      setSelectedGitDiffSelection(null);
    }
  }, [pendingGitDiffScrollPath]);

  useEffect(() => {
    if (pendingGitDiffCommitSha) {
      setSelectedGitDiffSelection(pendingGitDiffCommitSha);
      onClearPendingGitDiffIntent?.();
    }
  }, [onClearPendingGitDiffIntent, pendingGitDiffCommitSha]);

  const hasUncommittedChanges =
    (workspaceStatus?.workingTree.files.length ?? 0) > 0;

  useEffect(() => {
    if (
      shouldResetSelectedGitDiffSelection(
        selectedGitDiffSelection,
        workspaceStatus?.mergeBase?.commits ?? [],
        { hasUncommittedChanges },
      )
    ) {
      setSelectedGitDiffSelection(null);
    }
  }, [
    hasUncommittedChanges,
    selectedGitDiffSelection,
    workspaceStatus?.mergeBase?.commits,
  ]);

  const diffCommits = useMemo(
    () => workspaceStatus?.mergeBase?.commits ?? [],
    [workspaceStatus?.mergeBase?.commits],
  );
  const gitDiffSelectValue = selectedGitDiffSelection ?? ALL_GIT_DIFF_SELECTION;
  const gitDiffSelectOptions: GitDiffSelectionOption[] = useMemo(
    () => buildGitDiffSelectionOptions(diffCommits, { hasUncommittedChanges }),
    [diffCommits, hasUncommittedChanges],
  );

  const onGitDiffSelectionChange = useCallback((value: string) => {
    setSelectedGitDiffSelection(
      value === ALL_GIT_DIFF_SELECTION ? null : value,
    );
  }, []);

  return {
    gitDiffTarget,
    gitDiffSelectOptions,
    gitDiffSelectValue,
    onGitDiffSelectionChange,
  };
}
