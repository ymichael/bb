import type { QueryKey } from "@tanstack/react-query";
import {
  allEnvironmentGitDiffQueryKeyPrefix,
  allEnvironmentFilePreviewQueryKeyPrefix,
  allEnvironmentMergeBaseBranchesQueryKeyPrefix,
  allEnvironmentQueryKeyPrefix,
  allEnvironmentWorkStatusQueryKeyPrefix,
  allHostQueryKeyPrefix,
  allProjectFilesQueryKeyPrefix,
  allSystemExecutionOptionsQueryKeyPrefix,
  allThreadComposerBootstrapQueryKeyPrefix,
  allThreadDefaultExecutionOptionsQueryKeyPrefix,
  allThreadQueuedMessagesQueryKeyPrefix,
  allThreadPendingInteractionsQueryKeyPrefix,
  allThreadQueryKeyPrefix,
  allThreadStorageFilePreviewQueryKeyPrefix,
  allThreadStorageFilesQueryKeyPrefix,
  allThreadTimelineQueryKeyPrefix,
  cloudAuthSettingsQueryKey,
  hostsQueryKey,
  localPathExistenceQueryKeyPrefix,
  projectsQueryKey,
  replayCapturesQueryKey,
  sandboxEnvVarsQueryKey,
  systemProvidersQueryKey,
  threadsQueryKey,
} from "./queries/query-keys";
import type { QueryClientArg } from "./cache-effect-types";
import {
  invalidateQueryKeys,
  refetchFailedActiveQueryKeys,
} from "./cache-effect-utils";

export function invalidateRealtimeQueriesAfterServerReconnect({
  queryClient,
}: QueryClientArg): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: getServerReconnectInvalidationQueryKeys(),
  });
}

export function refetchErroredRealtimeQueriesOnInitialConnect({
  queryClient,
}: QueryClientArg): void {
  refetchFailedActiveQueryKeys({
    queryClient,
    queryKeys: getServerReconnectInvalidationQueryKeys(),
  });
}

export function invalidateHostAvailabilityQueries({
  queryClient,
}: QueryClientArg): void {
  queryClient.invalidateQueries({ queryKey: hostsQueryKey() });
  queryClient.invalidateQueries({ queryKey: allHostQueryKeyPrefix() });
}

export function invalidateHostChangeDependentQueries({
  queryClient,
}: QueryClientArg): void {
  invalidateHostAvailabilityQueries({ queryClient });
  queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
  queryClient.invalidateQueries({ queryKey: systemProvidersQueryKey() });
  queryClient.invalidateQueries({
    queryKey: allSystemExecutionOptionsQueryKeyPrefix(),
  });
  queryClient.invalidateQueries({
    queryKey: allThreadComposerBootstrapQueryKeyPrefix(),
  });
}

export function invalidateHostDeleteDependentQueries({
  queryClient,
}: QueryClientArg): void {
  invalidateHostAvailabilityQueries({ queryClient });
  queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
}

export function invalidateCloudAuthSettings({
  queryClient,
}: QueryClientArg): void {
  queryClient.invalidateQueries({ queryKey: cloudAuthSettingsQueryKey() });
}

export function invalidateSandboxEnvVars({
  queryClient,
}: QueryClientArg): void {
  queryClient.invalidateQueries({ queryKey: sandboxEnvVarsQueryKey() });
}

export function invalidateReplayCaptures({
  queryClient,
}: QueryClientArg): void {
  queryClient.invalidateQueries({ queryKey: replayCapturesQueryKey() });
}

function getServerReconnectInvalidationQueryKeys(): QueryKey[] {
  return [
    hostsQueryKey(),
    allHostQueryKeyPrefix(),
    projectsQueryKey(),
    allProjectFilesQueryKeyPrefix(),
    threadsQueryKey(),
    allThreadQueryKeyPrefix(),
    allThreadComposerBootstrapQueryKeyPrefix(),
    allThreadTimelineQueryKeyPrefix(),
    allThreadQueuedMessagesQueryKeyPrefix(),
    allThreadPendingInteractionsQueryKeyPrefix(),
    allThreadDefaultExecutionOptionsQueryKeyPrefix(),
    allThreadStorageFilesQueryKeyPrefix(),
    allThreadStorageFilePreviewQueryKeyPrefix(),
    allEnvironmentQueryKeyPrefix(),
    allEnvironmentWorkStatusQueryKeyPrefix(),
    allEnvironmentMergeBaseBranchesQueryKeyPrefix(),
    allEnvironmentGitDiffQueryKeyPrefix(),
    allEnvironmentFilePreviewQueryKeyPrefix(),
    localPathExistenceQueryKeyPrefix(),
    systemProvidersQueryKey(),
    allSystemExecutionOptionsQueryKeyPrefix(),
  ];
}
