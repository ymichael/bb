import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  Thread,
  ThreadListEntry,
  ThreadStatusChangeMetadata,
} from "@bb/domain";
import {
  applyToCachedThreadLists,
  getCachedThreadLists,
  iterateThreadListCacheEntries,
} from "./thread-list-cache-data";
import { bumpDiffPatchEvictionGeneration } from "./environment-diff-patch-cache-owner";
import { readCachedSidebarBootstrap } from "@/lib/sidebar-bootstrap-cache";
import type {
  SidebarBootstrapResponse,
  ThreadResponse,
  ThreadTimelineResponse,
  TimelineRow,
} from "@bb/server-contract";
import {
  ARCHIVED_THREADS_LIST_KIND,
  ENVIRONMENT_WORK_STATUS_QUERY_KEY,
  environmentDiffFilesQueryKeyPrefix,
  environmentDiffPatchQueryKeyPrefix,
  environmentFilePreviewQueryKeyPrefix,
  environmentMergeBaseBranchesQueryKeyPrefix,
  environmentPullRequestQueryKey,
  environmentQueryKey,
  environmentWorkStatusQueryKey,
  environmentWorkStatusQueryKeyPrefix,
  SIDEBAR_NAVIGATION_QUERY_KEY,
  sidebarNavigationQueryKey,
  THREADS_QUERY_KEY,
  threadQueryKey,
  threadsQueryKey,
  threadTimelineQueryKeyPrefix,
  type EnvironmentWorkStatusQueryKey,
  type ArchivedThreadsListFilters,
  type ThreadListQueryFilters,
} from "../queries/query-keys";

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

interface EnvironmentInvalidationParams {
  environmentId: string;
}

interface EnvironmentDiffPatchRemovalParams {
  environmentId: string;
  queryClient: QueryClient;
}

interface ProjectThreadListInvalidationParams {
  projectId: string;
  queryClient: QueryClient;
}

interface CachedGlobalThreadListInvalidationParams {
  queryClient: QueryClient;
}

interface RootOrderThreadListInvalidationParams {
  projectId?: string;
  queryClient: QueryClient;
}

type SidebarNavigationProject = SidebarBootstrapResponse["projects"][number];
export type CachedThreadListsAndSidebarNavigationMapper = (
  threads: ThreadListEntry[],
) => ThreadListEntry[];
type SidebarNavigationThreadMapper =
  CachedThreadListsAndSidebarNavigationMapper;

interface ApplyToCachedSidebarNavigationThreadsArgs {
  mapper: SidebarNavigationThreadMapper;
  queryClient: QueryClient;
}

export type CachedSidebarNavigationSnapshot =
  | SidebarBootstrapResponse
  | undefined;

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
    "limit" in candidate &&
    candidate.limit !== undefined &&
    typeof candidate.limit !== "number"
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

  for (const key of Object.keys(candidate)) {
    if (key !== "projectId" && key !== "kind") {
      return false;
    }
  }

  if ("projectId" in candidate && candidate.projectId !== undefined) {
    if (typeof candidate.projectId !== "string") {
      return false;
    }
  }
  if (
    "kind" in candidate &&
    candidate.kind !== undefined &&
    candidate.kind !== "all" &&
    candidate.kind !== "root" &&
    candidate.kind !== "child"
  ) {
    return false;
  }

  return true;
}

function getArchivedThreadListFiltersFromQueryKey(
  queryKey: QueryKey,
): ArchivedThreadsListFilters | undefined {
  if (
    queryKey[0] !== THREADS_QUERY_KEY ||
    queryKey[1] !== ARCHIVED_THREADS_LIST_KIND
  ) {
    return undefined;
  }

  const filters = queryKey[2];
  if (!isArchivedThreadsListFilters(filters)) {
    return undefined;
  }

  return filters;
}

export function isArchivedThreadListQueryKey(queryKey: QueryKey): boolean {
  return getArchivedThreadListFiltersFromQueryKey(queryKey) !== undefined;
}

export function getCachedThreadListQueryKeys(
  queryClient: QueryClient,
): QueryKey[] {
  const queryKeys: QueryKey[] = [];
  for (const [queryKey] of queryClient.getQueriesData({
    queryKey: threadsQueryKey(),
  })) {
    if (
      getThreadListFiltersFromQueryKey(queryKey) !== undefined ||
      getArchivedThreadListFiltersFromQueryKey(queryKey) !== undefined
    ) {
      queryKeys.push(queryKey);
    }
  }
  return queryKeys;
}

function getThreadListProjectIdFromQueryKey(
  queryKey: QueryKey,
): string | undefined {
  const archivedFilters = getArchivedThreadListFiltersFromQueryKey(queryKey);
  if (archivedFilters) {
    return archivedFilters.projectId;
  }

  if (queryKey[0] !== THREADS_QUERY_KEY) {
    return undefined;
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

export function getCachedGlobalThreadListInvalidationQueryKeys({
  queryClient,
}: CachedGlobalThreadListInvalidationParams): QueryKey[] {
  const queryKeys: QueryKey[] = [];
  for (const [queryKey] of queryClient.getQueriesData({
    queryKey: threadsQueryKey(),
  })) {
    const archivedFilters = getArchivedThreadListFiltersFromQueryKey(queryKey);
    if (
      archivedFilters !== undefined &&
      archivedFilters.projectId === undefined
    ) {
      queryKeys.push(queryKey);
      continue;
    }

    const filters = getThreadListFiltersFromQueryKey(queryKey);
    if (filters !== undefined && filters.projectId === undefined) {
      queryKeys.push(queryKey);
    }
  }
  return queryKeys;
}

export function getCachedRootOrderThreadListInvalidationQueryKeys({
  projectId,
  queryClient,
}: RootOrderThreadListInvalidationParams): QueryKey[] {
  const queryKeys: QueryKey[] = [];
  for (const [queryKey] of queryClient.getQueriesData({
    queryKey: threadsQueryKey(),
  })) {
    const filters = getThreadListFiltersFromQueryKey(queryKey);
    if (filters === undefined) continue;
    if (filters.projectId !== projectId) continue;
    if (filters.archived) continue;
    if (filters.parentThreadId !== undefined) continue;
    if (filters.hasParent === true) continue;
    queryKeys.push(queryKey);
  }
  return queryKeys;
}

function mapSidebarNavigationProjectThreads(
  project: SidebarNavigationProject,
  mapper: SidebarNavigationThreadMapper,
): SidebarNavigationProject {
  return {
    ...project,
    threads: mapper(project.threads),
  };
}

export function applyToCachedSidebarNavigationThreads({
  mapper,
  queryClient,
}: ApplyToCachedSidebarNavigationThreadsArgs): void {
  queryClient.setQueryData<SidebarBootstrapResponse>(
    sidebarNavigationQueryKey(),
    (currentNavigation) => {
      if (!currentNavigation) {
        return currentNavigation;
      }
      return {
        sections: currentNavigation.sections,
        projects: currentNavigation.projects.map((project) =>
          mapSidebarNavigationProjectThreads(project, mapper),
        ),
        personalProject: mapSidebarNavigationProjectThreads(
          currentNavigation.personalProject,
          mapper,
        ),
      };
    },
  );
}

export function applyToCachedThreadListsAndSidebarNavigation(
  queryClient: QueryClient,
  mapper: CachedThreadListsAndSidebarNavigationMapper,
): void {
  applyToCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
    mapper,
  });
  applyToCachedSidebarNavigationThreads({
    queryClient,
    mapper,
  });
}

export function listSidebarNavigationThreads(
  navigation: SidebarBootstrapResponse,
): ThreadListEntry[] {
  return [
    ...navigation.projects.flatMap((project) => project.threads),
    ...navigation.personalProject.threads,
  ];
}

export function getCachedSidebarNavigationThreads(
  queryClient: QueryClient,
): ThreadListEntry[] {
  const navigation = queryClient.getQueryData<SidebarBootstrapResponse>(
    sidebarNavigationQueryKey(),
  );
  if (!navigation) {
    return [];
  }
  return listSidebarNavigationThreads(navigation);
}

export function findSidebarNavigationThreadPlaceholder(
  queryClient: QueryClient,
  threadId: string,
): ThreadListEntry | undefined {
  if (!threadId) {
    return undefined;
  }
  const cached = getCachedSidebarNavigationThreads(queryClient).find(
    (thread) => thread.id === threadId,
  );
  if (cached !== undefined) {
    return cached;
  }
  const persisted = readCachedSidebarBootstrap();
  return persisted === null
    ? undefined
    : listSidebarNavigationThreads(persisted).find(
        (thread) => thread.id === threadId,
      );
}

export function snapshotCachedSidebarNavigation(
  queryClient: QueryClient,
): CachedSidebarNavigationSnapshot {
  return queryClient.getQueryData<SidebarBootstrapResponse>(
    sidebarNavigationQueryKey(),
  );
}

export function restoreCachedSidebarNavigation(
  queryClient: QueryClient,
  snapshot: CachedSidebarNavigationSnapshot,
): void {
  queryClient.setQueryData(sidebarNavigationQueryKey(), snapshot);
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
    environmentPullRequestQueryKey(environmentId),
    environmentDiffFilesQueryKeyPrefix(environmentId),
    environmentFilePreviewQueryKeyPrefix(environmentId),
  ];
}

export function removeEnvironmentDiffPatchQueries({
  environmentId,
  queryClient,
}: EnvironmentDiffPatchRemovalParams): void {
  bumpDiffPatchEvictionGeneration(environmentId);
  queryClient.removeQueries({
    queryKey: environmentDiffPatchQueryKeyPrefix(environmentId),
  });
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

  queryKeys.push(environmentDiffFilesQueryKeyPrefix(environmentId));

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
): ThreadListEntry | undefined {
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
  updater: (thread: ThreadResponse) => ThreadResponse,
): void {
  queryClient.setQueryData<ThreadResponse>(
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
  if (
    filters?.hasParent !== undefined &&
    (thread.parentThreadId !== null) !== filters.hasParent
  ) {
    return false;
  }
  if (
    filters?.parentThreadId !== undefined &&
    thread.parentThreadId !== filters.parentThreadId
  ) {
    return false;
  }
  if (
    filters?.sourceThreadId !== undefined &&
    thread.sourceThreadId !== filters.sourceThreadId
  ) {
    return false;
  }
  if (
    filters?.originKind !== undefined &&
    thread.originKind !== filters.originKind
  ) {
    return false;
  }
  if (thread.visibility === "hidden") {
    return false;
  }

  return true;
}

export function optimisticallyInsertThread(
  queryClient: QueryClient,
  thread: ThreadResponse,
): void {
  const queuedWork = thread.queuedMessageCount > 0 ? "waiting" : "none";
  const insertedThread: ThreadListEntry = {
    ...thread,
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    },
    environmentBranchName: null,
    environmentHostId: null,
    environmentName: null,
    runtime: thread.runtime,
    hasPendingInteraction: false,
    pinSortKey: null,
    queuedWork,
    environmentWorkspaceDisplayKind: "other",
  };
  const upsertThread = (threads: ThreadListEntry[]): ThreadListEntry[] => {
    const existingIndex = threads.findIndex(
      (candidate) => candidate.id === thread.id,
    );
    if (existingIndex === -1) {
      return [insertedThread, ...threads];
    }
    return threads.map((candidate, index) =>
      index === existingIndex
        ? {
            ...candidate,
            queuedWork:
              candidate.queuedWork === "none"
                ? queuedWork
                : candidate.queuedWork,
          }
        : candidate,
    );
  };

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

    queryClient.setQueryData<ThreadListEntry[]>(queryKey, upsertThread(data));
  }

  if (thread.visibility === "hidden" || thread.archivedAt !== null) {
    return;
  }

  queryClient.setQueryData<SidebarBootstrapResponse>(
    sidebarNavigationQueryKey(),
    (navigation) => {
      if (!navigation) {
        return navigation;
      }
      const updateProject = (
        project: SidebarNavigationProject,
      ): SidebarNavigationProject =>
        project.id === thread.projectId
          ? mapSidebarNavigationProjectThreads(project, upsertThread)
          : project;
      return {
        sections: navigation.sections,
        projects: navigation.projects.map(updateProject),
        personalProject: updateProject(navigation.personalProject),
      };
    },
  );
}

const updateEveryTimelineQuery: TimelineRowsUpdatePredicate = () => true;

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

export function insertOptimisticTimelineRow(
  queryClient: QueryClient,
  threadId: string,
  row: TimelineRow,
): void {
  updateCachedTimelineRows({
    queryClient,
    shouldUpdate: updateEveryTimelineQuery,
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
  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) => {
    if (!list.some((thread) => thread.id === threadId)) {
      return list;
    }
    return list.map((thread) =>
      thread.id === threadId ? { ...thread, hasPendingInteraction } : thread,
    );
  });
}

export function updateCachedThreadListStatusState(
  queryClient: QueryClient,
  threadId: string,
  statusChange: ThreadStatusChangeMetadata,
): void {
  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) => {
    if (!list.some((thread) => thread.id === threadId)) {
      return list;
    }
    return list.map((thread) =>
      thread.id === threadId ? { ...thread, ...statusChange } : thread,
    );
  });
}

export function getFetchingThreadListQueryKeys(
  queryClient: QueryClient,
): QueryKey[] {
  return queryClient
    .getQueryCache()
    .findAll({ fetchStatus: "fetching" })
    .map((query) => query.queryKey)
    .filter(
      (queryKey) =>
        queryKey[0] === SIDEBAR_NAVIGATION_QUERY_KEY ||
        getThreadListFiltersFromQueryKey(queryKey) !== undefined ||
        getArchivedThreadListFiltersFromQueryKey(queryKey) !== undefined,
    );
}
