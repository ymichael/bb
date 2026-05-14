import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { Thread, ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import {
  applyToCachedThreadLists,
  getCachedThreadLists,
  iterateThreadListCacheEntries,
} from "./thread-list-cache-data";
import type {
  ThreadTimelineResponse,
  TimelineRow,
  TimelineUserConversationRow,
} from "@bb/server-contract";
import {
  ARCHIVED_THREADS_LIST_KIND,
  ENVIRONMENT_GIT_DIFF_QUERY_KEY,
  ENVIRONMENT_WORK_STATUS_QUERY_KEY,
  environmentFilePreviewQueryKeyPrefix,
  environmentGitDiffQueryKey,
  environmentGitDiffQueryKeyPrefix,
  environmentMergeBaseBranchesQueryKeyPrefix,
  environmentQueryKey,
  environmentWorkStatusQueryKey,
  environmentWorkStatusQueryKeyPrefix,
  isStandardManagerThreadTimelineQueryKey,
  THREADS_QUERY_KEY,
  threadQueryKey,
  threadsQueryKey,
  threadTimelineQueryKeyPrefix,
  type EnvironmentGitDiffQueryKey,
  type EnvironmentWorkStatusQueryKey,
  type ArchivedThreadsListFilters,
  type ThreadListQueryFilters,
} from "./query-keys";

type TimelineRowsUpdater = (
  rows: readonly TimelineRow[],
) => readonly TimelineRow[] | null;

type TimelineRowsUpdatePredicate = (queryKey: QueryKey) => boolean;

interface UpdateCachedTimelineRowsArgs {
  queryClient: QueryClient;
  shouldUpdate: TimelineRowsUpdatePredicate;
  threadId: string;
  updater: TimelineRowsUpdater;
}

export interface EnvironmentInvalidationParams {
  environmentId: string;
}

export interface ProjectThreadListInvalidationParams {
  projectId: string;
  queryClient: QueryClient;
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

  if (!isThreadListQueryFilters(candidate)) {
    return undefined;
  }

  return candidate;
}

function isThreadListQueryFilters(
  candidate: unknown,
): candidate is ThreadListQueryFilters {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return false;
  }

  if (!("archived" in candidate) || typeof candidate.archived !== "boolean") {
    return false;
  }
  if (
    "projectId" in candidate &&
    candidate.projectId !== undefined &&
    typeof candidate.projectId !== "string"
  ) {
    return false;
  }
  if (
    "parentThreadId" in candidate &&
    candidate.parentThreadId !== undefined &&
    typeof candidate.parentThreadId !== "string"
  ) {
    return false;
  }
  if (
    "type" in candidate &&
    candidate.type !== undefined &&
    candidate.type !== "manager" &&
    candidate.type !== "standard"
  ) {
    return false;
  }

  return true;
}

function isArchivedThreadsListFilters(
  candidate: unknown,
): candidate is ArchivedThreadsListFilters {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return false;
  }

  if (!("projectId" in candidate) || typeof candidate.projectId !== "string") {
    return false;
  }
  if (
    !("managed" in candidate) ||
    (candidate.managed !== "all" &&
      candidate.managed !== "managed" &&
      candidate.managed !== "unmanaged")
  ) {
    return false;
  }

  return true;
}

function getThreadListProjectIdFromQueryKey(
  queryKey: QueryKey,
): string | undefined {
  if (queryKey[0] !== THREADS_QUERY_KEY) {
    return undefined;
  }

  if (queryKey[1] === ARCHIVED_THREADS_LIST_KIND) {
    const filters = queryKey[2];
    return isArchivedThreadsListFilters(filters)
      ? filters.projectId
      : undefined;
  }

  return getThreadListFiltersFromQueryKey(queryKey)?.projectId;
}

export function getCachedProjectThreadListInvalidationQueryKeys({
  projectId,
  queryClient,
}: ProjectThreadListInvalidationParams): QueryKey[] {
  const queryKeys: QueryKey[] = [];
  for (const [queryKey] of queryClient.getQueriesData({
    queryKey: threadsQueryKey(),
  })) {
    if (getThreadListProjectIdFromQueryKey(queryKey) === projectId) {
      queryKeys.push(queryKey);
    }
  }
  return queryKeys;
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
    environmentFilePreviewQueryKeyPrefix(environmentId),
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

export function getCachedThreadListPlaceholder(
  queryClient: QueryClient,
  threadId: string,
): ThreadWithRuntime | undefined {
  if (!threadId) {
    return undefined;
  }

  for (const { data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of iterateThreadListCacheEntries(data)) {
      if (thread.id === threadId) {
        return thread;
      }
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
  if (!filters) {
    return false;
  }
  if (filters.archived && thread.archivedAt == null) {
    return false;
  }
  if (!filters.archived && thread.archivedAt != null) {
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
  // Only inserts into flat-array list caches (`useThreads`). The paginated
  // archived view uses `InfiniteData` and only displays threads with an
  // archivedAt — newly created threads can't belong to it.
  for (const { queryKey, data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    if (!Array.isArray(data)) {
      continue;
    }

    const filters = getThreadListFiltersFromQueryKey(queryKey);
    if (!threadMatchesListFilters(thread, filters)) {
      continue;
    }
    if (data.some((candidate) => candidate.id === thread.id)) {
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
      ...data,
    ]);
  }
}

const updateEveryTimelineQuery: TimelineRowsUpdatePredicate = () => true;
const updateNoTimelineQueries: TimelineRowsUpdatePredicate = () => false;

function updateCachedTimelineRows({
  queryClient,
  shouldUpdate,
  threadId,
  updater,
}: UpdateCachedTimelineRowsArgs): void {
  const timelineQueries = queryClient.getQueriesData<ThreadTimelineResponse>({
    queryKey: threadTimelineQueryKeyPrefix(threadId),
  });

  for (const [queryKey, response] of timelineQueries) {
    if (!response) {
      continue;
    }
    if (!shouldUpdate(queryKey)) {
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

function isPendingSteerRow(
  row: TimelineRow,
): row is TimelineUserConversationRow {
  return (
    row.kind === "conversation" &&
    row.role === "user" &&
    row.userRequest.kind === "steer" &&
    row.userRequest.status === "pending"
  );
}

function buildPendingSteerTimelineQueryPredicate(
  thread: ThreadWithRuntime | undefined,
): TimelineRowsUpdatePredicate {
  if (!thread) {
    return updateNoTimelineQueries;
  }
  if (thread.type !== "manager") {
    return updateEveryTimelineQuery;
  }
  return isStandardManagerThreadTimelineQueryKey;
}

export function insertOptimisticTimelineRow(
  queryClient: QueryClient,
  threadId: string,
  row: TimelineRow,
): void {
  const shouldUpdate = isPendingSteerRow(row)
    ? buildPendingSteerTimelineQueryPredicate(
        queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey(threadId)),
      )
    : updateEveryTimelineQuery;
  updateCachedTimelineRows({
    queryClient,
    shouldUpdate,
    threadId,
    updater: (rows) => [...rows, row],
  });
}

export function removeOptimisticTimelineRow(
  queryClient: QueryClient,
  threadId: string,
  rowId: string,
): void {
  updateCachedTimelineRows({
    queryClient,
    shouldUpdate: updateEveryTimelineQuery,
    threadId,
    updater: (rows) => {
      const nextRows = rows.filter((row) => row.id !== rowId);
      return nextRows.length === rows.length ? null : nextRows;
    },
  });
}

export function updateCachedThreadListPendingInteractionState(
  queryClient: QueryClient,
  threadId: string,
  hasPendingInteraction: boolean,
): void {
  applyToCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
    mapper: (list) => {
      if (!list.some((thread) => thread.id === threadId)) {
        return list;
      }
      return list.map((thread) =>
        thread.id === threadId ? { ...thread, hasPendingInteraction } : thread,
      );
    },
  });
}
