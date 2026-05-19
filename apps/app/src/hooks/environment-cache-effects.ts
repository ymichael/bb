import {
  getEnvironmentActionInvalidationQueryKeys,
  getEnvironmentWorkspaceStateInvalidationQueryKeys,
} from "./queries/query-cache";
import {
  environmentFilePreviewQueryKeyPrefix,
  environmentGitDiffQueryKeyPrefix,
  environmentMergeBaseBranchesQueryKeyPrefix,
  environmentWorkStatusQueryKeyPrefix,
  systemExecutionOptionsEnvironmentQueryKeyPrefix,
  threadComposerBootstrapEnvironmentQueryKeyPrefix,
  threadStorageFilePreviewQueryKeyPrefix,
  threadStorageFilesForThreadQueryKeyPrefix,
  threadStoragePathsForThreadQueryKeyPrefix,
} from "./queries/query-keys";
import type {
  EnvironmentArg,
  EnvironmentChangedArg,
  OptionalEnvironmentArg,
  ThreadArg,
} from "./cache-effect-types";
import { invalidateQueryKeys } from "./cache-effect-utils";
import {
  executeRealtimeDirtyHandlers,
  REALTIME_ENVIRONMENT_CHANGE_REGISTRY,
} from "./realtime-cache-registry";

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
  queryClient.removeQueries({
    queryKey: systemExecutionOptionsEnvironmentQueryKeyPrefix(environmentId),
  });
  queryClient.removeQueries({
    queryKey: threadComposerBootstrapEnvironmentQueryKeyPrefix(environmentId),
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
  for (const changeKind of changeKinds) {
    executeRealtimeDirtyHandlers({
      context: {
        environmentId,
        getCachedThreadIdsForEnvironment: () => [],
        queryClient,
      },
      handlers: REALTIME_ENVIRONMENT_CHANGE_REGISTRY[changeKind].dirty,
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
    queryKey: threadStoragePathsForThreadQueryKeyPrefix(threadId),
  });
  queryClient.invalidateQueries({
    queryKey: threadStorageFilePreviewQueryKeyPrefix(threadId),
  });
}
