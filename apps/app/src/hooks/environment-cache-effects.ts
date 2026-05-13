import type { EnvironmentChangeKind } from "@bb/domain";
import {
  getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys,
  getEnvironmentActionInvalidationQueryKeys,
  getEnvironmentBranchListInvalidationQueryKeys,
  getEnvironmentRecordInvalidationQueryKeys,
  getEnvironmentWorkspaceStateInvalidationQueryKeys,
} from "./queries/query-cache";
import {
  environmentFilePreviewQueryKeyPrefix,
  environmentGitDiffQueryKeyPrefix,
  environmentMergeBaseBranchesQueryKeyPrefix,
  environmentWorkStatusQueryKeyPrefix,
  threadStorageFilePreviewQueryKeyPrefix,
  threadStorageFilesForThreadQueryKeyPrefix,
} from "./queries/query-keys";
import type {
  EnvironmentArg,
  EnvironmentChangedArg,
  OptionalEnvironmentArg,
  ThreadArg,
} from "./cache-effect-types";
import { invalidateQueryKeys } from "./cache-effect-utils";

const PERSISTED_ENVIRONMENT_CHANGE_KINDS: readonly EnvironmentChangeKind[] = [
  "environment-created",
  "environment-deleted",
  "metadata-changed",
  "status-changed",
];
const WORKSPACE_STATE_CHANGE_KINDS: readonly EnvironmentChangeKind[] = [
  "environment-created",
  "environment-deleted",
  "metadata-changed",
  "status-changed",
  "work-status-changed",
];
const REF_DERIVED_WORKSPACE_STATE_CHANGE_KINDS: readonly EnvironmentChangeKind[] =
  ["git-refs-changed"];
const BRANCH_LIST_CHANGE_KINDS: readonly EnvironmentChangeKind[] = [
  "environment-created",
  "environment-deleted",
  "metadata-changed",
  "status-changed",
  "git-refs-changed",
];

export function removeEnvironmentScopedQueries({
  environmentId,
  queryClient,
}: OptionalEnvironmentArg): void {
  if (!environmentId) {
    return;
  }

  queryClient.removeQueries({
    queryKey: environmentWorkStatusQueryKeyPrefix(environmentId),
  });
  queryClient.removeQueries({
    queryKey: environmentGitDiffQueryKeyPrefix(environmentId),
  });
  queryClient.removeQueries({
    queryKey: environmentFilePreviewQueryKeyPrefix(environmentId),
  });
  queryClient.removeQueries({
    queryKey: environmentMergeBaseBranchesQueryKeyPrefix(environmentId),
  });
}

export function invalidateEnvironmentActionQueries({
  environmentId,
  queryClient,
}: EnvironmentArg): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: getEnvironmentActionInvalidationQueryKeys({ environmentId }),
  });
}

export function invalidateEnvironmentWorkspaceStateQueries({
  environmentId,
  queryClient,
}: EnvironmentArg): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: getEnvironmentWorkspaceStateInvalidationQueryKeys({
      environmentId,
    }),
  });
}

export function invalidateRealtimeEnvironmentChangeQueries({
  changeKinds,
  environmentId,
  queryClient,
}: EnvironmentChangedArg): void {
  const includeWorkspaceState =
    environmentChangeKindsIncludeWorkspaceState(changeKinds);

  if (environmentChangeKindsIncludePersistedEnvironment(changeKinds)) {
    invalidateQueryKeys({
      queryClient,
      queryKeys: getEnvironmentRecordInvalidationQueryKeys({ environmentId }),
    });
  }
  if (includeWorkspaceState) {
    invalidateEnvironmentWorkspaceStateQueries({ environmentId, queryClient });
  }
  if (
    !includeWorkspaceState &&
    environmentChangeKindsIncludeRefDerivedWorkspaceState(changeKinds)
  ) {
    for (const queryKey of getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys(
      queryClient,
      { environmentId },
    )) {
      queryClient.invalidateQueries({ exact: true, queryKey });
    }
  }
  if (environmentChangeKindsIncludeBranchList(changeKinds)) {
    invalidateQueryKeys({
      queryClient,
      queryKeys: getEnvironmentBranchListInvalidationQueryKeys({
        environmentId,
      }),
    });
  }
}

export function invalidateThreadStorageQueries({
  queryClient,
  threadId,
}: ThreadArg): void {
  queryClient.invalidateQueries({
    queryKey: threadStorageFilesForThreadQueryKeyPrefix(threadId),
  });
  queryClient.invalidateQueries({
    queryKey: threadStorageFilePreviewQueryKeyPrefix(threadId),
  });
}

function environmentChangeKindsIncludePersistedEnvironment(
  changeKinds: readonly EnvironmentChangeKind[],
): boolean {
  return changeKinds.some((changeKind) =>
    PERSISTED_ENVIRONMENT_CHANGE_KINDS.includes(changeKind),
  );
}

function environmentChangeKindsIncludeWorkspaceState(
  changeKinds: readonly EnvironmentChangeKind[],
): boolean {
  return changeKinds.some((changeKind) =>
    WORKSPACE_STATE_CHANGE_KINDS.includes(changeKind),
  );
}

function environmentChangeKindsIncludeRefDerivedWorkspaceState(
  changeKinds: readonly EnvironmentChangeKind[],
): boolean {
  return changeKinds.some((changeKind) =>
    REF_DERIVED_WORKSPACE_STATE_CHANGE_KINDS.includes(changeKind),
  );
}

function environmentChangeKindsIncludeBranchList(
  changeKinds: readonly EnvironmentChangeKind[],
): boolean {
  return changeKinds.some((changeKind) =>
    BRANCH_LIST_CHANGE_KINDS.includes(changeKind),
  );
}
