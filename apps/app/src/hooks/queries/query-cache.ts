import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  Thread,
  ThreadListEntry,
  ThreadWithRuntime,
  TimelineRow,
} from "@bb/domain";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import {
  ENVIRONMENT_GIT_DIFF_QUERY_KEY,
  ENVIRONMENT_WORK_STATUS_QUERY_KEY,
  environmentPromotionQueryKeyPrefix,
  environmentGitDiffQueryKey,
  environmentGitDiffQueryKeyPrefix,
  environmentMergeBaseBranchesQueryKeyPrefix,
  environmentQueryKey,
  environmentWorkStatusQueryKey,
  environmentWorkStatusQueryKeyPrefix,
  projectSourceWorkspaceStatusQueryKeyPrefix,
  THREADS_QUERY_KEY,
  threadQueryKey,
  threadsQueryKey,
  threadTimelineQueryKeyPrefix,
  type EnvironmentGitDiffQueryKey,
  type EnvironmentWorkStatusQueryKey,
  type ThreadListQueryFilters,
} from "./query-keys";

export interface EnvironmentInvalidationParams {
  environmentId: string;
}

function getThreadListFiltersFromQueryKey(
  queryKey: QueryKey,
): ThreadListQueryFilters | undefined {
  if (queryKey[0] !== THREADS_QUERY_KEY) {
    return undefined;
  }

  const candidate = queryKey[1];
  if (candidate === undefined) {
    return undefined;
  }

  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return undefined;
  }

  return candidate;
}

export function getEnvironmentRecordInvalidationQueryKeys({
  environmentId,
}: EnvironmentInvalidationParams): QueryKey[] {
  return [environmentQueryKey(environmentId)];
}

export function getEnvironmentWorkspaceStateInvalidationQueryKeys({
  environmentId,
}: EnvironmentInvalidationParams): QueryKey[] {
  return [
    environmentWorkStatusQueryKeyPrefix(environmentId),
    environmentGitDiffQueryKeyPrefix(environmentId),
    environmentPromotionQueryKeyPrefix(environmentId),
  ];
}

export function getEnvironmentBranchListInvalidationQueryKeys({
  environmentId,
}: EnvironmentInvalidationParams): QueryKey[] {
  return [environmentMergeBaseBranchesQueryKeyPrefix(environmentId)];
}

function isEnvironmentWorkStatusQueryKeyForEnvironment(
  queryKey: QueryKey,
  environmentId: string,
): queryKey is EnvironmentWorkStatusQueryKey {
  return (
    queryKey[0] === ENVIRONMENT_WORK_STATUS_QUERY_KEY &&
    queryKey[1] === environmentId &&
    (typeof queryKey[2] === "string" || queryKey[2] === null)
  );
}

function isMergeBaseEnvironmentWorkStatusQueryKey(
  queryKey: QueryKey,
  environmentId: string,
): queryKey is EnvironmentWorkStatusQueryKey {
  return (
    isEnvironmentWorkStatusQueryKeyForEnvironment(queryKey, environmentId) &&
    typeof queryKey[2] === "string"
  );
}

function isEnvironmentGitDiffQueryKeyForEnvironment(
  queryKey: QueryKey,
  environmentId: string,
): queryKey is EnvironmentGitDiffQueryKey {
  return (
    queryKey[0] === ENVIRONMENT_GIT_DIFF_QUERY_KEY &&
    queryKey[1] === environmentId &&
    (typeof queryKey[2] === "string" || queryKey[2] === null) &&
    (typeof queryKey[3] === "string" || queryKey[3] === null)
  );
}

function isRefDerivedEnvironmentGitDiffQueryKey(
  queryKey: QueryKey,
  environmentId: string,
): queryKey is EnvironmentGitDiffQueryKey {
  return (
    isEnvironmentGitDiffQueryKeyForEnvironment(queryKey, environmentId) &&
    (queryKey[2] === "all" || queryKey[2] === "branch_committed")
  );
}

export function getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys(
  queryClient: QueryClient,
  { environmentId }: EnvironmentInvalidationParams,
): QueryKey[] {
  const queryKeys: QueryKey[] = [];

  for (const [queryKey] of queryClient.getQueriesData({
    queryKey: environmentWorkStatusQueryKeyPrefix(environmentId),
  })) {
    if (isMergeBaseEnvironmentWorkStatusQueryKey(queryKey, environmentId)) {
      queryKeys.push(environmentWorkStatusQueryKey(environmentId, queryKey[2]));
    }
  }

  for (const [queryKey] of queryClient.getQueriesData({
    queryKey: environmentGitDiffQueryKeyPrefix(environmentId),
  })) {
    if (isRefDerivedEnvironmentGitDiffQueryKey(queryKey, environmentId)) {
      queryKeys.push(
        environmentGitDiffQueryKey(environmentId, queryKey[2], queryKey[3]),
      );
    }
  }

  return queryKeys;
}

export function getEnvironmentActionInvalidationQueryKeys({
  environmentId,
}: EnvironmentInvalidationParams): QueryKey[] {
  return [
    ...getEnvironmentWorkspaceStateInvalidationQueryKeys({ environmentId }),
    ...getEnvironmentBranchListInvalidationQueryKeys({ environmentId }),
    threadsQueryKey(),
  ];
}

export function getPrimaryCheckoutWorkspaceStateInvalidationQueryKeys(): QueryKey[] {
  return [projectSourceWorkspaceStatusQueryKeyPrefix()];
}

export function getCachedThreadListPlaceholder(
  queryClient: QueryClient,
  threadId: string,
): ThreadWithRuntime | undefined {
  if (!threadId) {
    return undefined;
  }

  const threadLists = queryClient.getQueriesData<ThreadListEntry[]>({
    queryKey: threadsQueryKey(),
  });
  for (const [, threads] of threadLists) {
    const match = threads?.find((thread) => thread.id === threadId);
    if (match) {
      return match;
    }
  }

  return undefined;
}

export function updateCachedThread(
  queryClient: QueryClient,
  threadId: string,
  updater: (thread: ThreadWithRuntime) => ThreadWithRuntime,
): void {
  queryClient.setQueryData<ThreadWithRuntime>(
    threadQueryKey(threadId),
    (thread) => {
      if (!thread) {
        return thread;
      }

      return updater(thread);
    },
  );
}

function threadMatchesListFilters(
  thread: Thread,
  filters: ThreadListQueryFilters | undefined,
): boolean {
  if (filters?.archived === true && thread.archivedAt == null) {
    return false;
  }
  if (filters?.archived !== true && thread.archivedAt != null) {
    return false;
  }
  if (filters?.projectId && thread.projectId !== filters.projectId) {
    return false;
  }
  if (filters?.type && thread.type !== filters.type) {
    return false;
  }
  if (
    filters?.parentThreadId !== undefined &&
    thread.parentThreadId !== filters.parentThreadId
  ) {
    return false;
  }

  return true;
}

export function optimisticallyInsertThread(
  queryClient: QueryClient,
  thread: ThreadWithRuntime,
): void {
  const threadLists = queryClient.getQueriesData<ThreadListEntry[]>({
    queryKey: threadsQueryKey(),
  });

  for (const [queryKey, list] of threadLists) {
    if (!list) {
      continue;
    }

    const filters = getThreadListFiltersFromQueryKey(queryKey);
    if (!threadMatchesListFilters(thread, filters)) {
      continue;
    }
    if (list.some((candidate) => candidate.id === thread.id)) {
      continue;
    }

    queryClient.setQueryData<ThreadListEntry[]>(queryKey, [
      {
        ...thread,
        environmentBranchName: null,
        environmentHostId: null,
        runtime: thread.runtime,
        hasPendingInteraction: false,
        environmentWorkspaceDisplayKind: "other",
      },
      ...list,
    ]);
  }
}

function updateCachedTimelineRows(
  queryClient: QueryClient,
  threadId: string,
  updater: (rows: readonly TimelineRow[]) => readonly TimelineRow[] | null,
): void {
  const timelineQueries = queryClient.getQueriesData<ThreadTimelineResponse>({
    queryKey: threadTimelineQueryKeyPrefix(threadId),
  });

  for (const [queryKey, response] of timelineQueries) {
    if (!response) {
      continue;
    }

    const nextRows = updater(response.rows);
    if (nextRows === null) {
      continue;
    }

    queryClient.setQueryData<ThreadTimelineResponse>(queryKey, {
      ...response,
      rows: [...nextRows],
    });
  }
}

export function insertOptimisticTimelineRow(
  queryClient: QueryClient,
  threadId: string,
  row: TimelineRow,
): void {
  updateCachedTimelineRows(queryClient, threadId, (rows) => [...rows, row]);
}

export function removeOptimisticTimelineRow(
  queryClient: QueryClient,
  threadId: string,
  rowId: string,
): void {
  updateCachedTimelineRows(queryClient, threadId, (rows) => {
    const nextRows = rows.filter((row) => row.id !== rowId);
    return nextRows.length === rows.length ? null : nextRows;
  });
}

export function updateCachedThreadListPendingInteractionState(
  queryClient: QueryClient,
  threadId: string,
  hasPendingInteraction: boolean,
): void {
  const threadLists = queryClient.getQueriesData<ThreadListEntry[]>({
    queryKey: threadsQueryKey(),
  });

  for (const [queryKey, list] of threadLists) {
    if (!list?.some((thread) => thread.id === threadId)) {
      continue;
    }

    queryClient.setQueryData<ThreadListEntry[]>(
      queryKey,
      list.map((thread) =>
        thread.id === threadId ? { ...thread, hasPendingInteraction } : thread,
      ),
    );
  }
}
