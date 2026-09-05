import { useCallback, useMemo } from "react";
import { useProjectSourceBranches } from "@/hooks/queries/project-queries";
import type {
  BranchesState,
  CheckoutState,
  UseBranchesArgs,
  UseCheckoutStateArgs,
} from "@get-bb/plugin-sdk";

export function usePluginBranches({
  hostId,
  projectId,
  query = "",
}: UseBranchesArgs): BranchesState {
  const enabled = hostId !== null && projectId !== null;
  const branchesQuery = useProjectSourceBranches(
    projectId ?? undefined,
    hostId,
    {
      enabled,
      query,
      selectedBranch: "",
    },
  );
  const refreshFromRemote = branchesQuery.refreshFromRemote;
  const refresh = useCallback(async () => {
    if (!enabled) return;
    await refreshFromRemote();
  }, [enabled, refreshFromRemote]);

  return useMemo(
    () => ({
      branches: enabled ? (branchesQuery.data?.branches ?? []) : [],
      remoteBranches: enabled ? (branchesQuery.data?.remoteBranches ?? []) : [],
      isLoading: enabled && branchesQuery.isFetching,
      refresh,
    }),
    [
      branchesQuery.data?.branches,
      branchesQuery.data?.remoteBranches,
      branchesQuery.isFetching,
      enabled,
      refresh,
    ],
  );
}

export function usePluginDefaultWorktreeBaseBranch({
  hostId,
  projectId,
}: UseCheckoutStateArgs): string | null {
  const enabled = hostId !== null && projectId !== null;
  const query = useProjectSourceBranches(projectId ?? undefined, hostId, {
    enabled,
    query: "",
    selectedBranch: "",
  });
  return (
    query.data?.defaultWorktreeBaseBranch ?? query.data?.defaultBranch ?? null
  );
}

export function usePluginCheckoutState({
  hostId,
  projectId,
}: UseCheckoutStateArgs): CheckoutState {
  const enabled = hostId !== null && projectId !== null;
  const query = useProjectSourceBranches(projectId ?? undefined, hostId, {
    enabled,
    query: "",
    selectedBranch: "",
  });
  const checkout = query.data?.checkout;

  return useMemo(
    () => ({
      isGit:
        query.data === undefined
          ? null
          : query.data.checkout.kind !== "unknown",
      unborn: checkout?.kind === "unborn",
      detached: checkout?.kind === "detached",
      dirty: query.data?.hasUncommittedChanges ?? false,
      currentBranch: checkout?.kind === "branch" ? checkout.branchName : null,
      operation: query.data?.operation ?? { kind: "none" },
    }),
    [checkout, query.data],
  );
}
