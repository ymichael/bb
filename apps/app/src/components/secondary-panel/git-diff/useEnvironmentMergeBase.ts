import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Environment, Thread, WorkspaceStatus } from "@bb/domain";
import { toast } from "sonner";
import { getMergeBaseBranchCandidates } from "@/components/pickers/BranchPicker";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { useUpdateEnvironment } from "../../../hooks/mutations/environment-mutations";

interface UseEnvironmentMergeBaseParams {
  environment?: Environment;
  mergeBaseBranchOptions?: readonly string[];
  selectedMergeBaseBranch?: string;
  setSelectedMergeBaseBranch: (branch: string | undefined) => void;
  thread?: Thread;
  updateEnvironment: ReturnType<typeof useUpdateEnvironment>;
  workspaceStatus?: WorkspaceStatus;
}

type MergeBaseBranchChangeHandler = (branch: string) => void;

interface ShouldSyncSelectedMergeBaseBranchParams {
  previousStateKey?: string;
  nextStateKey?: string;
  persistedMergeBaseBranch?: string | null;
  selectedMergeBaseBranch?: string;
  updatePending: boolean;
}

function normalizeSelectedMergeBaseBranch(
  branch?: string | null,
): string | undefined {
  return branch ?? undefined;
}

export function shouldSyncSelectedMergeBaseBranch({
  previousStateKey,
  nextStateKey,
  persistedMergeBaseBranch,
  selectedMergeBaseBranch,
  updatePending,
}: ShouldSyncSelectedMergeBaseBranchParams): boolean {
  if (previousStateKey !== nextStateKey) {
    return true;
  }

  if (updatePending) {
    return false;
  }

  return (
    selectedMergeBaseBranch !==
    normalizeSelectedMergeBaseBranch(persistedMergeBaseBranch)
  );
}

export function useEnvironmentMergeBase({
  environment,
  mergeBaseBranchOptions,
  selectedMergeBaseBranch,
  setSelectedMergeBaseBranch,
  thread,
  updateEnvironment,
  workspaceStatus,
}: UseEnvironmentMergeBaseParams) {
  const mergeBaseStateKeyRef = useRef<string | undefined>(undefined);
  const mergeBaseStateKey = environment?.id ?? thread?.id;
  const isCurrentEnvironmentUpdatePending =
    updateEnvironment.isPending &&
    updateEnvironment.variables?.id === environment?.id;

  useEffect(() => {
    if (
      !shouldSyncSelectedMergeBaseBranch({
        previousStateKey: mergeBaseStateKeyRef.current,
        nextStateKey: mergeBaseStateKey,
        persistedMergeBaseBranch: environment?.mergeBaseBranch,
        selectedMergeBaseBranch,
        updatePending: isCurrentEnvironmentUpdatePending,
      })
    ) {
      return;
    }

    mergeBaseStateKeyRef.current = mergeBaseStateKey;
    setSelectedMergeBaseBranch(
      normalizeSelectedMergeBaseBranch(environment?.mergeBaseBranch),
    );
  }, [
    environment?.mergeBaseBranch,
    isCurrentEnvironmentUpdatePending,
    mergeBaseStateKey,
    selectedMergeBaseBranch,
    setSelectedMergeBaseBranch,
  ]);

  const effectiveMergeBaseBranch =
    selectedMergeBaseBranch ??
    workspaceStatus?.mergeBase?.mergeBaseBranch ??
    workspaceStatus?.branch.defaultBranch;
  const showBranchComparisonUi = Boolean(
    effectiveMergeBaseBranch || workspaceStatus?.branch.defaultBranch,
  );
  const mergeBaseBranch = effectiveMergeBaseBranch;
  const mergeBaseCandidates = useMemo(
    () =>
      getMergeBaseBranchCandidates({
        mergeBaseBranch,
        mergeBaseBranchOptions,
      }),
    [mergeBaseBranch, mergeBaseBranchOptions],
  );
  const isOnDefaultBranch =
    workspaceStatus?.branch.currentBranch != null &&
    workspaceStatus.branch.currentBranch ===
      workspaceStatus.branch.defaultBranch;
  const showMergeBase =
    showBranchComparisonUi && Boolean(mergeBaseBranch) && !isOnDefaultBranch;
  const canSelectMergeBase = Boolean(
    showMergeBase && mergeBaseBranch && mergeBaseCandidates.length > 0,
  );

  const handleMergeBaseBranchChange: MergeBaseBranchChangeHandler = useCallback(
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
            setSelectedMergeBaseBranch(
              environment.mergeBaseBranch ?? undefined,
            );
            toast.error(
              getMutationErrorMessage({
                error,
                fallbackMessage: "Failed to update merge base branch.",
              }),
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
    canSelectMergeBase,
    effectiveMergeBaseBranch,
    handleMergeBaseBranchChange,
    showBranchComparisonUi,
    showMergeBase,
    mergeBaseBranch,
    mergeBaseCandidates,
  };
}
