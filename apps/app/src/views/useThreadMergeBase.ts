import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Environment, Thread, WorkspaceStatus } from "@bb/domain";
import { toast } from "sonner";
import { getMergeBaseBranchCandidates } from "@/components/thread/MergeBaseBranchPicker";
import { useUpdateEnvironment } from "../hooks/useApi";

interface UseThreadMergeBaseParams {
  environment?: Environment;
  mergeBaseBranchOptions?: readonly string[];
  selectedMergeBaseBranch?: string;
  setSelectedMergeBaseBranch: (branch: string | undefined) => void;
  thread?: Thread;
  updateEnvironment: ReturnType<typeof useUpdateEnvironment>;
  workspaceStatus?: WorkspaceStatus;
}

type MergeBaseBranchChangeHandler = (branch: string) => void;

export function useThreadMergeBase({
  environment,
  mergeBaseBranchOptions,
  selectedMergeBaseBranch,
  setSelectedMergeBaseBranch,
  thread,
  updateEnvironment,
  workspaceStatus,
}: UseThreadMergeBaseParams) {
  const mergeBaseStateKeyRef = useRef<string | undefined>(undefined);
  const mergeBaseStateKey = environment?.id ?? thread?.id;

  useEffect(() => {
    if (mergeBaseStateKeyRef.current === mergeBaseStateKey) {
      return;
    }

    mergeBaseStateKeyRef.current = mergeBaseStateKey;
    setSelectedMergeBaseBranch(environment?.mergeBaseBranch ?? undefined);
  }, [environment?.mergeBaseBranch, mergeBaseStateKey, setSelectedMergeBaseBranch]);

  const effectiveMergeBaseBranch =
    selectedMergeBaseBranch ??
    workspaceStatus?.mergeBase?.mergeBaseBranch ??
    workspaceStatus?.branch.defaultBranch;
  const showBranchComparisonUi = Boolean(
    effectiveMergeBaseBranch || workspaceStatus?.branch.defaultBranch,
  );
  const threadMergeBaseBranch = effectiveMergeBaseBranch;
  const threadMergeBaseCandidates = useMemo(
    () =>
      getMergeBaseBranchCandidates({
        mergeBaseBranch: threadMergeBaseBranch,
        mergeBaseBranchOptions,
      }),
    [mergeBaseBranchOptions, threadMergeBaseBranch],
  );
  const showThreadMergeBase = showBranchComparisonUi && Boolean(threadMergeBaseBranch);
  const canSelectThreadMergeBase = Boolean(
    showThreadMergeBase &&
      threadMergeBaseBranch &&
      threadMergeBaseCandidates.length > 0,
  );

  const handleThreadMergeBaseBranchChange: MergeBaseBranchChangeHandler = useCallback(
    (branch) => {
      if (!environment || !thread?.environmentId) {
        return;
      }

      const normalizedBranch = branch.trim();
      const defaultBranch = workspaceStatus?.branch.defaultBranch.trim();
      const nextPersistedMergeBaseBranch =
        normalizedBranch.length > 0 && normalizedBranch !== defaultBranch
          ? normalizedBranch
          : null;
      const currentPersistedMergeBaseBranch = environment.mergeBaseBranch;

      setSelectedMergeBaseBranch(normalizedBranch);
      if (nextPersistedMergeBaseBranch === currentPersistedMergeBaseBranch) {
        return;
      }

      updateEnvironment.mutate(
        {
          id: environment.id,
          mergeBaseBranch: nextPersistedMergeBaseBranch,
        },
        {
          onError: (error) => {
            setSelectedMergeBaseBranch(environment.mergeBaseBranch ?? undefined);
            toast.error(
              error instanceof Error
                ? error.message
                : "Failed to update merge base branch.",
            );
          },
        },
      );
    },
    [
      environment,
      setSelectedMergeBaseBranch,
      thread?.environmentId,
      updateEnvironment,
      workspaceStatus?.branch.defaultBranch,
    ],
  );

  return {
    canSelectThreadMergeBase,
    effectiveMergeBaseBranch,
    handleThreadMergeBaseBranchChange,
    showBranchComparisonUi,
    showThreadMergeBase,
    threadMergeBaseBranch,
    threadMergeBaseCandidates,
  };
}
