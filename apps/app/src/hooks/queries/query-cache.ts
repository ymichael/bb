import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  Thread,
  ThreadListEntry,
} from "@bb/domain";
import {
  ENVIRONMENT_GIT_DIFF_QUERY_KEY,
  ENVIRONMENT_WORK_STATUS_QUERY_KEY,
  environmentGitDiffQueryKey,
  environmentGitDiffQueryKeyPrefix,
  environmentMergeBaseBranchesQueryKeyPrefix,
  environmentQueryKey,
  environmentWorkStatusQueryKey,
  environmentWorkStatusQueryKeyPrefix,
  THREADS_QUERY_KEY,
  threadQueryKey,
  threadsQueryKey,
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

  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
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
  ];
}

export function getEnvironmentBranchListInvalidationQueryKeys({
  environmentId,
}: EnvironmentInvalidationParams): QueryKey[] {
  return [
    environmentMergeBaseBranchesQueryKeyPrefix(environmentId),
  ];
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
      queryKeys.push(environmentGitDiffQueryKey(environmentId, queryKey[2], queryKey[3]));
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
): Thread | undefined {
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
  updater: (thread: Thread) => Thread,
): void {
  queryClient.setQueryData<Thread>(threadQueryKey(threadId), (thread) => {
    if (!thread) {
      return thread;
    }

    return updater(thread);
  });
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
  thread: Thread,
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

    queryClient.setQueryData<ThreadListEntry[]>(
      queryKey,
      [{
        ...thread,
        hasPendingInteraction: false,
      }, ...list],
    );
  }
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
        thread.id === threadId
          ? { ...thread, hasPendingInteraction }
          : thread
      ),
    );
  }
}
