import {
  getEnvironmentActionInvalidationQueryKeys,
  getEnvironmentWorkspaceStateInvalidationQueryKeys,
  removeEnvironmentDiffPatchQueries,
} from "./query-cache";
import {
  environmentDiffFilesQueryKeyPrefix,
  environmentFilePreviewQueryKeyPrefix,
  environmentMergeBaseBranchesQueryKeyPrefix,
  environmentPathsQueryKeyPrefix,
  environmentWorkStatusQueryKeyPrefix,
  systemExecutionOptionsEnvironmentQueryKeyPrefix,
} from "../queries/query-keys";
import type {
  EnvironmentArg,
  OptionalEnvironmentArg,
} from "../cache-effect-types";
import { invalidateQueryKeys } from "./cache-effect-utils";

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
    queryKey: environmentDiffFilesQueryKeyPrefix(environmentId),
  });
  removeEnvironmentDiffPatchQueries({ environmentId, queryClient });
  queryClient.removeQueries({
    queryKey: environmentFilePreviewQueryKeyPrefix(environmentId),
  });
  queryClient.removeQueries({
    queryKey: environmentPathsQueryKeyPrefix(environmentId),
  });
  queryClient.removeQueries({
    queryKey: environmentMergeBaseBranchesQueryKeyPrefix(environmentId),
  });
  queryClient.removeQueries({
    queryKey: systemExecutionOptionsEnvironmentQueryKeyPrefix(environmentId),
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
  removeEnvironmentDiffPatchQueries({ environmentId, queryClient });
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
  removeEnvironmentDiffPatchQueries({ environmentId, queryClient });
}
