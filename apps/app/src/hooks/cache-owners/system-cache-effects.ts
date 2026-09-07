import type { QueryKey } from "@tanstack/react-query";
import {
  allEnvironmentDiffFilesQueryKeyPrefix,
  allEnvironmentDiffPatchQueryKeyPrefix,
  allEnvironmentFilePreviewQueryKeyPrefix,
  allEnvironmentMergeBaseBranchesQueryKeyPrefix,
  allEnvironmentQueryKeyPrefix,
  allEnvironmentWorkStatusQueryKeyPrefix,
  allHostQueryKeyPrefix,
  allProjectPathsQueryKeyPrefix,
  allSystemExecutionOptionsQueryKeyPrefix,
  allSystemProvidersQueryKeyPrefix,
  allTerminalsQueryKeyPrefix,
  allThreadConversationOutlineQueryKeyPrefix,
  allThreadDetailBootstrapQueryKeyPrefix,
  allThreadHostFilePreviewQueryKeyPrefix,
  allThreadPendingInteractionsQueryKeyPrefix,
  allThreadQueuedMessagesQueryKeyPrefix,
  allThreadQueryKeyPrefix,
  allThreadStorageFilePreviewQueryKeyPrefix,
  allThreadStorageFilesQueryKeyPrefix,
  allThreadStorageLocationsQueryKeyPrefix,
  allThreadStoragePathsQueryKeyPrefix,
  allThreadTimelineQueryKeyPrefix,
  allThreadTimelineTurnSummaryDetailsQueryKeyPrefix,
  hostPathExistenceQueryKeyPrefix,
  hostsQueryKey,
  projectsQueryKey,
  sidebarNavigationQueryKey,
  systemConfigQueryKey,
  threadPromptHistoryQueryKeyPrefix,
  threadSearchQueryKeyPrefix,
  threadsQueryKey,
} from "../queries/query-keys";
import { allThreadDefaultExecutionOptionsQueryKeyPrefix } from "../queries/thread-default-execution-options-query";
import type { QueryClientArg } from "../cache-effect-types";
import { clearCachedModelCatalogs } from "@/lib/model-catalog-cache";
import { bumpAllDiffPatchEvictionGenerations } from "./environment-diff-patch-cache-owner";
import { invalidateSystemVersion } from "./system-version-cache-owner";
import {
  invalidateQueryKeys,
  refetchFailedActiveQueryKeys,
} from "./cache-effect-utils";

interface SystemExecutionOptionsInvalidationArgs extends QueryClientArg {
  hostId: string;
}

interface ServerReconnectInvalidationArgs extends QueryClientArg {
  disconnectedAt: number;
}

export function invalidateRealtimeQueriesAfterServerReconnect({
  disconnectedAt,
  queryClient,
}: ServerReconnectInvalidationArgs): void {
  for (const queryKey of getServerReconnectInvalidationQueryKeys()) {
    void queryClient.invalidateQueries(
      {
        queryKey,
        predicate: (query) => query.state.dataUpdatedAt < disconnectedAt,
      },
      { cancelRefetch: false },
    );
  }
  invalidateSystemVersion({ queryClient });
  bumpAllDiffPatchEvictionGenerations();
  queryClient.removeQueries({
    queryKey: allEnvironmentDiffPatchQueryKeyPrefix(),
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

interface InitialConnectInvalidationArgs extends QueryClientArg {
  connectedAt: number;
}

export function invalidateRealtimeQueriesFetchedBeforeInitialConnect({
  connectedAt,
  queryClient,
}: InitialConnectInvalidationArgs): void {
  for (const queryKey of getServerReconnectInvalidationQueryKeys()) {
    queryClient.invalidateQueries({
      queryKey,
      predicate: (query) =>
        query.state.dataUpdatedAt !== 0 &&
        query.state.dataUpdatedAt < connectedAt,
    });
  }
}

export function invalidateSystemConfig({ queryClient }: QueryClientArg): void {
  queryClient.invalidateQueries({ queryKey: systemConfigQueryKey() });
}

export function invalidateSystemProviders({
  queryClient,
}: QueryClientArg): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: allSystemProvidersQueryKeyPrefix(),
  });
}

export function invalidateSystemExecutionOptions({
  hostId,
  queryClient,
}: SystemExecutionOptionsInvalidationArgs): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: allSystemExecutionOptionsQueryKeyPrefix(),
    predicate: (query) =>
      query.queryKey[2] === hostId || query.queryKey[2] === null,
  });
}

export function invalidateGeneralSettingsDependencies({
  queryClient,
}: QueryClientArg): void {
  invalidateQueryKeys({
    queryClient,
    queryKeys: [
      systemConfigQueryKey(),
      allThreadTimelineQueryKeyPrefix(),
      allThreadTimelineTurnSummaryDetailsQueryKeyPrefix(),
    ],
  });
}

export function resetModelCatalogsAfterStreamerModeChange({
  queryClient,
}: QueryClientArg): Promise<void> {
  clearCachedModelCatalogs();
  return queryClient.resetQueries({
    queryKey: allSystemExecutionOptionsQueryKeyPrefix(),
  });
}

function getServerReconnectInvalidationQueryKeys(): QueryKey[] {
  return [
    hostsQueryKey(),
    allHostQueryKeyPrefix(),
    projectsQueryKey(),
    sidebarNavigationQueryKey(),
    allProjectPathsQueryKeyPrefix(),
    threadsQueryKey(),
    threadSearchQueryKeyPrefix(),
    allThreadQueryKeyPrefix(),
    allThreadDetailBootstrapQueryKeyPrefix(),
    allThreadTimelineQueryKeyPrefix(),
    allThreadConversationOutlineQueryKeyPrefix(),
    allThreadTimelineTurnSummaryDetailsQueryKeyPrefix(),
    allThreadQueuedMessagesQueryKeyPrefix(),
    threadPromptHistoryQueryKeyPrefix(),
    allThreadPendingInteractionsQueryKeyPrefix(),
    allThreadDefaultExecutionOptionsQueryKeyPrefix(),
    allThreadStorageFilesQueryKeyPrefix(),
    allThreadStorageLocationsQueryKeyPrefix(),
    allThreadStoragePathsQueryKeyPrefix(),
    allThreadStorageFilePreviewQueryKeyPrefix(),
    allThreadHostFilePreviewQueryKeyPrefix(),
    allTerminalsQueryKeyPrefix(),
    allEnvironmentQueryKeyPrefix(),
    allEnvironmentWorkStatusQueryKeyPrefix(),
    allEnvironmentMergeBaseBranchesQueryKeyPrefix(),
    allEnvironmentDiffFilesQueryKeyPrefix(),
    allEnvironmentFilePreviewQueryKeyPrefix(),
    hostPathExistenceQueryKeyPrefix(),
    allSystemProvidersQueryKeyPrefix(),
    allSystemExecutionOptionsQueryKeyPrefix(),
  ];
}
