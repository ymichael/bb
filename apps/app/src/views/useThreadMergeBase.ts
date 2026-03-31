import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Thread, WorkspaceStatus } from "@bb/domain";
import { toast } from "sonner";
import { getMergeBaseBranchCandidates } from "@/components/thread/MergeBaseBranchPicker";
import { useUpdateThread } from "../hooks/useApi";

interface UseThreadMergeBaseParams {
  mergeBaseBranchOptions?: readonly string[];
  selectedMergeBaseBranch?: string;
  setSelectedMergeBaseBranch: (branch: string | undefined) => void;
  thread?: Thread;
  updateThread: ReturnType<typeof useUpdateThread>;
  workspaceStatus?: WorkspaceStatus;
}

type MergeBaseBranchChangeHandler = (branch: string) => void;

export function useThreadMergeBase({
  mergeBaseBranchOptions,
  selectedMergeBaseBranch,
  setSelectedMergeBaseBranch,
  thread,
  updateThread,
  workspaceStatus,
}: UseThreadMergeBaseParams) {
  const mergeBaseStateThreadIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (mergeBaseStateThreadIdRef.current === thread?.id) {
      return;
    }

    mergeBaseStateThreadIdRef.current = thread?.id;
    setSelectedMergeBaseBranch(thread?.mergeBaseBranch ?? undefined);
  }, [setSelectedMergeBaseBranch, thread?.id, thread?.mergeBaseBranch]);

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
      if (!thread) {
        return;
      }

      const normalizedBranch = branch.trim();
      const defaultBranch = workspaceStatus?.branch.defaultBranch.trim();
      const nextPersistedMergeBaseBranch =
        normalizedBranch.length > 0 && normalizedBranch !== defaultBranch
          ? normalizedBranch
          : null;
      const currentPersistedMergeBaseBranch = thread.mergeBaseBranch ?? null;

      setSelectedMergeBaseBranch(normalizedBranch);
      if (nextPersistedMergeBaseBranch === currentPersistedMergeBaseBranch) {
        return;
      }

      updateThread.mutate(
        {
          id: thread.id,
          mergeBaseBranch: nextPersistedMergeBaseBranch,
        },
        {
          onError: (error) => {
            setSelectedMergeBaseBranch(thread.mergeBaseBranch ?? undefined);
            toast.error(
              error instanceof Error
                ? error.message
                : "Failed to update merge base branch.",
            );
          },
        },
      );
    },
    [setSelectedMergeBaseBranch, thread, updateThread, workspaceStatus?.branch.defaultBranch],
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
