import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  EnvironmentChangeKind,
  HostChangeKind,
  ProjectChangeKind,
  SystemChangeKind,
  ThreadChangeKind,
  ThreadEventType,
  ThreadStatusChangeMetadata,
  ThreadWithRuntime,
} from "@bb/domain";
import {
  getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys,
  getCachedGlobalThreadListInvalidationQueryKeys,
  getCachedProjectThreadListInvalidationQueryKeys,
  getCachedRootOrderThreadListInvalidationQueryKeys,
  getCachedSidebarNavigationThreads,
  getCachedThreadListPlaceholder,
  getCachedThreadListQueryKeys,
  getEnvironmentBranchListInvalidationQueryKeys,
  getEnvironmentRecordInvalidationQueryKeys,
  getEnvironmentWorkspaceStateInvalidationQueryKeys,
  getFetchingThreadListQueryKeys,
  isArchivedThreadListQueryKey,
  removeEnvironmentDiffPatchQueries,
  updateCachedThreadListPendingInteractionState,
  updateCachedThreadListStatusState,
} from "./query-cache";
import {
  getCachedThreadLists,
  iterateThreadListCacheEntries,
} from "./thread-list-cache-data";
import {
  allHostQueryKeyPrefix,
  allPluginCatalogSearchQueryKeyPrefix,
  allPluginContributionsQueryKeyPrefix,
  allPluginListQueryKeyPrefix,
  allPluginSettingsQueryKeyPrefix,
  allPluginSettingsViewQueryKeyPrefix,
  allPluginSourceQueryKeyPrefix,
  allProjectCommandsQueryKeyPrefix,
  allThreadStorageFilePreviewQueryKeyPrefix,
  allThreadStorageFilesQueryKeyPrefix,
  allThreadStorageLocationsQueryKeyPrefix,
  allThreadStoragePathsQueryKeyPrefix,
  allSystemExecutionOptionsQueryKeyPrefix,
  allThreadQueryKeyPrefix,
  allTerminalsQueryKeyPrefix,
  environmentDiffFilesQueryKeyPrefix,
  environmentFilePreviewQueryKeyPrefix,
  environmentPullRequestQueryKey,
  environmentWorkStatusQueryKeyPrefix,
  hostsQueryKey,
  sidebarNavigationQueryKey,
  systemConfigQueryKey,
  allSystemProvidersQueryKeyPrefix,
  threadDefaultExecutionOptionsQueryKey,
  threadQueryKey,
  threadTabsQueryKey,
  threadSearchQueryKeyPrefix,
  terminalsQueryKey,
  threadsQueryKey,
  threadStorageFilePreviewQueryKeyPrefix,
  threadStorageFilesForThreadQueryKeyPrefix,
  threadStorageLocationQueryKey,
  threadStoragePathsForThreadQueryKeyPrefix,
  threadTimelineQueryKeyPrefix,
} from "../queries/query-keys";
import { schedulePluginFrontendReconcile } from "../../lib/plugin-frontend-lazy";
import {
  getProjectListInvalidationQueryKeys,
  getProjectPromptHistoryInvalidationQueryKeys,
  getProjectSourceDependentInvalidationQueryKeys,
  getThreadConversationOutlineInvalidationQueryKeys,
  getThreadDetailInvalidationQueryKeys,
  getThreadListInvalidationQueryKeys,
  getThreadPendingInteractionInvalidationQueryKeys,
  getThreadPromptHistoryInvalidationQueryKeys,
  getThreadQueueContentInvalidationQueryKeys,
  getThreadTimelineInvalidationQueryKeys,
  getThreadTimelineWindowInvalidationQueryKeys,
} from "./cache-invalidation-groups";

interface CollectCachedThreadIdsForEnvironmentArgs {
  environmentId: string;
  queryClient: QueryClient;
}

interface TimelineInvalidationQueryKeysArgs {
  queryClient: QueryClient;
  queryKeys: readonly QueryKey[];
}

interface ScheduleTrailingActiveRefetchArgs {
  exact: boolean;
  queryClient: QueryClient;
  queryKey: QueryKey;
}

interface CancelTrailingActiveRefetchArgs {
  queryClient: QueryClient;
  queryKey: QueryKey;
}

const trailingActiveRefetchUnsubscribers = new WeakMap<
  QueryClient,
  Map<string, () => void>
>();

interface ThrottledActiveRefetchEntry {
  lastRunAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const throttledActiveRefetchEntries = new WeakMap<
  QueryClient,
  Map<string, ThrottledActiveRefetchEntry>
>();

interface ThrottledActiveRefetchArgs {
  exact: boolean;
  minIntervalMs: number;
  queryClient: QueryClient;
  queryKey: QueryKey;
}

const WORK_STATUS_REFETCH_MIN_INTERVAL_MS = 1_000;

const THREAD_LIST_STATUS_FALLBACK_REFETCH_MIN_INTERVAL_MS = 1_000;

const TRAILING_REFETCH_MIN_INTERVAL_MS = 50;
const TRAILING_REFETCH_MAX_INTERVAL_MS = 1_000;

export function resolveTrailingRefetchDelayMs(
  observedFetchDurationMs: number,
): number {
  return Math.min(
    TRAILING_REFETCH_MAX_INTERVAL_MS,
    Math.max(TRAILING_REFETCH_MIN_INTERVAL_MS, observedFetchDurationMs),
  );
}

function timelineInvalidationKey(queryKey: QueryKey): string {
  return JSON.stringify(queryKey);
}

function hasActiveFetchingQueries(
  queryClient: QueryClient,
  queryKey: QueryKey,
  exact: boolean,
): boolean {
  return queryClient
    .getQueryCache()
    .findAll({ exact, queryKey, type: "active" })
    .some((query) => query.state.fetchStatus !== "idle");
}

function hasActiveQueries(
  queryClient: QueryClient,
  queryKey: QueryKey,
): boolean {
  return (
    queryClient.getQueryCache().findAll({ queryKey, type: "active" }).length > 0
  );
}

function refetchActiveQueriesWithoutCanceling({
  exact,
  queryClient,
  queryKey,
}: ScheduleTrailingActiveRefetchArgs): void {
  const hadActiveFetch = hasActiveFetchingQueries(queryClient, queryKey, exact);
  void queryClient
    .refetchQueries(
      { exact, queryKey, type: "active" },
      { cancelRefetch: false },
    )
    .catch(() => {});
  if (hadActiveFetch) {
    scheduleTrailingActiveRefetch({ exact, queryClient, queryKey });
  }
}

function invalidateQueryKeyWithThrottledActiveRefetch({
  exact,
  minIntervalMs,
  queryClient,
  queryKey,
}: ThrottledActiveRefetchArgs): void {
  queryClient.invalidateQueries({ exact, queryKey, refetchType: "none" });

  const scheduleKey = timelineInvalidationKey(queryKey);
  let entries = throttledActiveRefetchEntries.get(queryClient);
  if (!entries) {
    entries = new Map();
    throttledActiveRefetchEntries.set(queryClient, entries);
  }
  const entry = entries.get(scheduleKey);
  if (entry?.timer) {
    return;
  }
  const run = () => {
    entries.set(scheduleKey, { lastRunAt: Date.now(), timer: null });
    refetchActiveQueriesWithoutCanceling({ exact, queryClient, queryKey });
  };
  const lastRunAt = entry?.lastRunAt ?? Number.NEGATIVE_INFINITY;
  const delayMs = Math.max(0, lastRunAt + minIntervalMs - Date.now());
  if (delayMs === 0) {
    run();
    return;
  }
  entries.set(scheduleKey, { lastRunAt, timer: setTimeout(run, delayMs) });
}

function scheduleTrailingActiveRefetch({
  exact,
  queryClient,
  queryKey,
}: ScheduleTrailingActiveRefetchArgs): void {
  const scheduleKey = timelineInvalidationKey(queryKey);
  let unsubscribers = trailingActiveRefetchUnsubscribers.get(queryClient);
  if (!unsubscribers) {
    unsubscribers = new Map();
    trailingActiveRefetchUnsubscribers.set(queryClient, unsubscribers);
  }
  if (unsubscribers.has(scheduleKey)) {
    return;
  }

  const waitingSince = Date.now();

  const unsubscribe = queryClient.getQueryCache().subscribe(() => {
    if (hasActiveFetchingQueries(queryClient, queryKey, exact)) {
      return;
    }

    unsubscribe();
    unsubscribers.delete(scheduleKey);
    const delayMs = resolveTrailingRefetchDelayMs(Date.now() - waitingSince);
    const timer = setTimeout(() => {
      unsubscribers.delete(scheduleKey);
      void queryClient
        .refetchQueries(
          { exact, queryKey, type: "active" },
          { cancelRefetch: false },
        )
        .catch(() => {});
    }, delayMs);
    unsubscribers.set(scheduleKey, () => {
      clearTimeout(timer);
    });
  });
  unsubscribers.set(scheduleKey, unsubscribe);
}

function cancelTrailingActiveRefetch({
  queryClient,
  queryKey,
}: CancelTrailingActiveRefetchArgs): void {
  const unsubscribers = trailingActiveRefetchUnsubscribers.get(queryClient);
  if (!unsubscribers) {
    return;
  }
  const scheduleKey = timelineInvalidationKey(queryKey);
  unsubscribers.get(scheduleKey)?.();
  unsubscribers.delete(scheduleKey);
  if (unsubscribers.size === 0) {
    trailingActiveRefetchUnsubscribers.delete(queryClient);
  }
}

function invalidateQueryKeysWithoutCancelingActiveFetches({
  queryClient,
  queryKeys,
}: TimelineInvalidationQueryKeysArgs): void {
  for (const queryKey of queryKeys) {
    const hadActiveFetch = hasActiveFetchingQueries(
      queryClient,
      queryKey,
      false,
    );
    queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
    if (hadActiveFetch) {
      scheduleTrailingActiveRefetch({ exact: false, queryClient, queryKey });
    }
  }
}

function invalidateTerminalTimelineQueryKeys({
  queryClient,
  queryKeys,
}: TimelineInvalidationQueryKeysArgs): void {
  for (const queryKey of queryKeys) {
    cancelTrailingActiveRefetch({ queryClient, queryKey });
    void queryClient.cancelQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey });
  }
}

export function disposeTrailingActiveRefetches(queryClient: QueryClient): void {
  const throttled = throttledActiveRefetchEntries.get(queryClient);
  if (throttled) {
    for (const entry of throttled.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
    }
    throttledActiveRefetchEntries.delete(queryClient);
  }
  const unsubscribers = trailingActiveRefetchUnsubscribers.get(queryClient);
  if (!unsubscribers) {
    return;
  }
  for (const unsubscribe of unsubscribers.values()) {
    unsubscribe();
  }
  trailingActiveRefetchUnsubscribers.delete(queryClient);
}

export const REALTIME_THREAD_CHANGE_REGISTRY = {
  "thread-created": {
    flush: "debounced",
    dirty: [
      dirtyThreadListQueries,
      dirtyThreadDetailQueries,
      dirtyThreadTimelineQueries,
      dirtyProjectPromptHistoryQueries,
    ],
  },
  "thread-deleted": {
    flush: "debounced",
    dirty: [
      dirtyThreadListQueries,
      dirtyThreadDetailQueries,
      dirtyThreadTimelineQueries,
      dirtyProjectPromptHistoryQueries,
    ],
  },
  "events-appended": {
    flush: "debounced",
    dirty: [
      dirtyThreadListQueriesForBackgroundActivity,
      dirtyThreadDetailQueriesForBackgroundActivity,
      dirtyThreadSearchQueriesForCompletedTurn,
      dirtyThreadTimelineQueries,
      dirtyThreadPullRequestQueryForCompletedTurn,
      dirtyThreadPromptHistoryQueriesForTurnRequests,
    ],
  },
  "history-rewritten": {
    flush: "immediate",
    dirty: [
      dirtyThreadListQueries,
      dirtyThreadDetailQueries,
      dirtyThreadSearchQueries,
      getThreadTimelineInvalidationQueryKeys,
      getThreadQueueContentInvalidationQueryKeys,
      dirtyProjectPromptHistoryQueries,
      getThreadPendingInteractionInvalidationQueryKeys,
    ],
  },
  "interactions-changed": {
    flush: "debounced",
    dirty: [
      dirtyThreadSearchQueries,
      getThreadPendingInteractionInvalidationQueryKeys,
      patchThreadListPendingInteractionState,
    ],
  },
  "status-changed": {
    flush: "immediate",
    dirty: [patchThreadListStatusState, dirtyThreadDetailQueries],
  },
  "title-changed": {
    flush: "debounced",
    dirty: [dirtyActiveThreadListQueries, dirtyThreadDetailQueries],
  },
  "queue-changed": {
    flush: "debounced",
    dirty: [
      getThreadQueueContentInvalidationQueryKeys,
      dirtyActiveThreadListQueries,
    ],
  },
  "archived-changed": {
    flush: "debounced",
    dirty: [
      dirtyThreadListQueries,
      dirtyThreadDetailQueries,
      dirtyProjectPromptHistoryQueries,
    ],
  },
  "pin-state-changed": {
    flush: "debounced",
    dirty: [dirtyThreadListQueries, dirtyThreadDetailQueries],
  },
  "parent-changed": {
    flush: "debounced",
    dirty: [dirtyThreadListQueries, dirtyThreadDetailQueries],
  },
  "environment-changed": {
    flush: "immediate",
    dirty: [
      dirtyActiveThreadListQueries,
      dirtyThreadDetailQueries,
      dirtyThreadDefaultExecutionOptionsQueries,
      dirtyThreadStorageQueriesForThread,
    ],
  },
  "read-state-changed": {
    flush: "debounced",
    dirty: [markThreadDetailQueryStale, markThreadListQueriesStale],
  },
  "order-changed": {
    flush: "debounced",
    dirty: [dirtyRootOrderThreadListQueries],
  },
  "tabs-changed": {
    flush: "immediate",
    dirty: [dirtyThreadTabsQueries],
  },
  "terminals-changed": {
    flush: "debounced",
    dirty: [dirtyThreadTerminalQueries],
  },
} satisfies ThreadChangeRegistry;

export const REALTIME_ENVIRONMENT_CHANGE_REGISTRY = {
  "environment-created": {
    dirty: [
      dirtyEnvironmentRecordQueries,
      dirtyEnvironmentWorkspaceStateQueries,
      dirtyEnvironmentBranchListQueries,
    ],
  },
  "environment-deleted": {
    dirty: [
      dirtyEnvironmentRecordQueries,
      dirtyEnvironmentWorkspaceStateQueries,
      dirtyEnvironmentBranchListQueries,
    ],
  },
  "metadata-changed": {
    dirty: [
      dirtyEnvironmentRecordQueries,
      dirtyEnvironmentWorkspaceStateQueries,
      dirtyEnvironmentBranchListQueries,
      dirtyEnvironmentThreadListQueries,
      dirtyThreadSearchQueries,
    ],
  },
  "status-changed": {
    dirty: [
      dirtyEnvironmentRecordQueries,
      dirtyEnvironmentWorkspaceStateQueries,
      dirtyEnvironmentBranchListQueries,
    ],
  },
  "work-status-changed": {
    dirty: [dirtyEnvironmentLiveWorkspaceStateQueries],
  },
  "git-refs-changed": {
    dirty: [
      dirtyEnvironmentRefDerivedWorkspaceStateQueries,
      dirtyEnvironmentBranchListQueries,
    ],
  },
  "thread-storage-changed": {
    dirty: [dirtyThreadStorageQueriesForEnvironment],
  },
} satisfies EnvironmentChangeRegistry;

export const REALTIME_PROJECT_CHANGE_REGISTRY = {
  "project-created": {
    dirty: [getProjectListInvalidationQueryKeys],
  },
  "project-updated": {
    dirty: [getProjectListInvalidationQueryKeys],
  },
  "project-deleted": {
    dirty: [getProjectListInvalidationQueryKeys],
  },
  "project-sources-changed": {
    dirty: [getProjectSourceDependentInvalidationQueryKeys],
  },
  "threads-changed": {
    dirty: [
      getProjectListInvalidationQueryKeys,
      dirtyProjectPromptHistoryQueries,
    ],
  },
  "project-order-changed": {
    dirty: [getProjectListInvalidationQueryKeys],
  },
} satisfies ProjectChangeRegistry;

const HOST_CONNECTION_DIRTY_HANDLERS = [
  dirtyHostAvailabilityQueries,
  getProjectListInvalidationQueryKeys,
  dirtySystemProviderQueries,
  dirtySystemExecutionOptionQueries,
] satisfies readonly RealtimeDirtyHandler<HostRealtimeDirtyContext>[];

export const REALTIME_HOST_CHANGE_REGISTRY = {
  "host-connected": {
    dirty: HOST_CONNECTION_DIRTY_HANDLERS,
  },
  "host-disconnected": {
    dirty: HOST_CONNECTION_DIRTY_HANDLERS,
  },
} satisfies HostChangeRegistry;

export const REALTIME_SYSTEM_CHANGE_REGISTRY = {
  "config-changed": {
    dirty: [
      dirtySystemConfigQueries,
      dirtyAllThreadTimelineQueries,
      dirtySystemProviderQueries,
      dirtySystemExecutionOptionQueries,
    ],
  },
  "plugins-changed": {
    dirty: [
      dirtyPluginContributionQueries,
      dirtyProjectCommandCatalogQueries,
      dirtyPluginManagementQueries,
      reconcilePluginFrontendBundles,
    ],
  },
  "provider-registrations-changed": {
    dirty: [dirtySystemProviderQueries, dirtySystemExecutionOptionQueries],
  },
} satisfies SystemChangeRegistry;

type ThreadChangeFlushPriority = "debounced" | "immediate";

interface RealtimeDirtyContext {
  queryClient: QueryClient;
}

interface ThreadRealtimeDirtyContext extends RealtimeDirtyContext {
  backgroundActivityChanged: boolean | undefined;
  eventTypes: readonly ThreadEventType[] | undefined;
  flushOnce: (key: string) => boolean;
  hasPendingInteraction: boolean | undefined;
  projectId: string | undefined;
  statusChange: ThreadStatusChangeMetadata | undefined;
  threadId: string | undefined;
}

export function createFlushOncePredicate(): (key: string) => boolean {
  const seen = new Set<string>();
  return (key) => {
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  };
}

interface EnvironmentRealtimeDirtyContext extends RealtimeDirtyContext {
  environmentId: string;
  getCachedThreadIdsForEnvironment: () => string[];
}

interface ProjectRealtimeDirtyContext extends RealtimeDirtyContext {
  projectId: string | undefined;
}

type HostRealtimeDirtyContext = RealtimeDirtyContext;

type RealtimeDirtyHandler<Context extends RealtimeDirtyContext> = (
  context: Context,
) => readonly QueryKey[] | void;

interface ExecuteRealtimeDirtyHandlersArgs<
  Context extends RealtimeDirtyContext,
> {
  context: Context;
  handlers: readonly RealtimeDirtyHandler<Context>[];
}

interface ThreadChangeRule {
  dirty: readonly RealtimeDirtyHandler<ThreadRealtimeDirtyContext>[];
  flush: ThreadChangeFlushPriority;
}

type ThreadChangeRegistry = Record<ThreadChangeKind, ThreadChangeRule>;

interface EnvironmentChangeRule {
  dirty: readonly RealtimeDirtyHandler<EnvironmentRealtimeDirtyContext>[];
}

type EnvironmentChangeRegistry = Record<
  EnvironmentChangeKind,
  EnvironmentChangeRule
>;

interface ProjectChangeRule {
  dirty: readonly RealtimeDirtyHandler<ProjectRealtimeDirtyContext>[];
}

type ProjectChangeRegistry = Record<ProjectChangeKind, ProjectChangeRule>;

interface HostChangeRule {
  dirty: readonly RealtimeDirtyHandler<HostRealtimeDirtyContext>[];
}

type HostChangeRegistry = Record<HostChangeKind, HostChangeRule>;

interface SystemChangeRule {
  dirty: readonly RealtimeDirtyHandler<RealtimeDirtyContext>[];
}

type SystemChangeRegistry = Partial<Record<SystemChangeKind, SystemChangeRule>>;

export function executeRealtimeDirtyHandlers<
  Context extends RealtimeDirtyContext,
>({ context, handlers }: ExecuteRealtimeDirtyHandlersArgs<Context>): void {
  for (const handler of handlers) {
    const queryKeys = handler(context);
    if (!queryKeys) {
      continue;
    }
    for (const queryKey of queryKeys) {
      context.queryClient.invalidateQueries({ queryKey });
    }
  }
}

export interface ThreadChangesByFlushPriority {
  debounced: ThreadChangeKind[] | null;
  immediate: ThreadChangeKind[] | null;
}

export function partitionThreadChangesByFlushPriority(
  changes: readonly ThreadChangeKind[],
): ThreadChangesByFlushPriority {
  let debounced: ThreadChangeKind[] | null = null;
  let immediate: ThreadChangeKind[] | null = null;
  for (const change of changes) {
    if (REALTIME_THREAD_CHANGE_REGISTRY[change].flush === "immediate") {
      (immediate ??= []).push(change);
    } else {
      (debounced ??= []).push(change);
    }
  }
  return { debounced, immediate };
}

export function collectCachedThreadIdsForEnvironment({
  environmentId,
  queryClient,
}: CollectCachedThreadIdsForEnvironmentArgs): string[] {
  const threadIds = new Set<string>();
  for (const [, thread] of queryClient.getQueriesData<ThreadWithRuntime>({
    queryKey: allThreadQueryKeyPrefix(),
  })) {
    if (thread?.environmentId === environmentId) {
      threadIds.add(thread.id);
    }
  }
  for (const { data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of iterateThreadListCacheEntries(data)) {
      if (thread.environmentId === environmentId) {
        threadIds.add(thread.id);
      }
    }
  }
  return Array.from(threadIds);
}

function dirtyThreadListQueries({
  projectId,
  queryClient,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  if (projectId) {
    for (const queryKey of getCachedGlobalThreadListInvalidationQueryKeys({
      queryClient,
    })) {
      queryClient.invalidateQueries({ exact: true, queryKey });
    }
  }
  return getThreadListInvalidationQueryKeys({ projectId, queryClient });
}

function dirtyActiveThreadListQueries({
  projectId,
  queryClient,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  const listQueryKeys = projectId
    ? [
        ...getCachedProjectThreadListInvalidationQueryKeys({
          projectId,
          queryClient,
        }),
        ...getCachedGlobalThreadListInvalidationQueryKeys({ queryClient }),
      ]
    : getCachedThreadListQueryKeys(queryClient);
  for (const queryKey of listQueryKeys) {
    queryClient.invalidateQueries({
      exact: true,
      queryKey,
      ...(isArchivedThreadListQueryKey(queryKey)
        ? { refetchType: "none" }
        : {}),
    });
  }
  return [sidebarNavigationQueryKey(), threadSearchQueryKeyPrefix()];
}

function dirtyActiveThreadListQueriesWithThrottledRefetch({
  projectId,
  queryClient,
}: ThreadRealtimeDirtyContext): void {
  const listQueryKeys = projectId
    ? [
        ...getCachedProjectThreadListInvalidationQueryKeys({
          projectId,
          queryClient,
        }),
        ...getCachedGlobalThreadListInvalidationQueryKeys({ queryClient }),
      ]
    : getCachedThreadListQueryKeys(queryClient);
  for (const queryKey of listQueryKeys) {
    if (isArchivedThreadListQueryKey(queryKey)) {
      queryClient.invalidateQueries({
        exact: true,
        queryKey,
        refetchType: "none",
      });
      continue;
    }
    invalidateQueryKeyWithThrottledActiveRefetch({
      exact: true,
      minIntervalMs: THREAD_LIST_STATUS_FALLBACK_REFETCH_MIN_INTERVAL_MS,
      queryClient,
      queryKey,
    });
  }
  for (const queryKey of [
    sidebarNavigationQueryKey(),
    threadSearchQueryKeyPrefix(),
  ]) {
    invalidateQueryKeyWithThrottledActiveRefetch({
      exact: false,
      minIntervalMs: THREAD_LIST_STATUS_FALLBACK_REFETCH_MIN_INTERVAL_MS,
      queryClient,
      queryKey,
    });
  }
}

function dirtyThreadListQueriesForBackgroundActivity(
  context: ThreadRealtimeDirtyContext,
): QueryKey[] {
  if (context.backgroundActivityChanged !== true) {
    return [];
  }
  return dirtyActiveThreadListQueries(context);
}

function dirtyThreadDetailQueriesForBackgroundActivity(
  context: ThreadRealtimeDirtyContext,
): QueryKey[] {
  if (context.backgroundActivityChanged !== true) {
    return [];
  }
  return dirtyThreadDetailQueries(context);
}

function dirtyRootOrderThreadListQueries({
  projectId,
  queryClient,
}: ThreadRealtimeDirtyContext): void {
  queryClient.invalidateQueries({ queryKey: sidebarNavigationQueryKey() });
  for (const queryKey of getCachedRootOrderThreadListInvalidationQueryKeys({
    projectId,
    queryClient,
  })) {
    queryClient.invalidateQueries({ exact: true, queryKey });
  }
  if (!projectId) return;
  for (const queryKey of getCachedRootOrderThreadListInvalidationQueryKeys({
    queryClient,
  })) {
    queryClient.invalidateQueries({ exact: true, queryKey });
  }
}

function dirtyThreadDetailQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return getThreadDetailInvalidationQueryKeys({ threadId });
}

function dirtyThreadDefaultExecutionOptionsQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return threadId ? [threadDefaultExecutionOptionsQueryKey(threadId)] : [];
}

function dirtyThreadTabsQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return threadId ? [threadTabsQueryKey(threadId)] : [];
}

function dirtyThreadSearchQueries(): QueryKey[] {
  return [threadSearchQueryKeyPrefix()];
}

function dirtyThreadSearchQueriesForCompletedTurn({
  eventTypes,
  flushOnce,
  queryClient,
}: ThreadRealtimeDirtyContext): void {
  if (!eventTypes?.includes("turn/completed")) {
    return;
  }
  if (!flushOnce("thread-search:turn-completed")) {
    return;
  }
  invalidateQueryKeysWithoutCancelingActiveFetches({
    queryClient,
    queryKeys: [threadSearchQueryKeyPrefix()],
  });
}

function dirtyThreadTimelineQueries({
  eventTypes,
  queryClient,
  threadId,
}: ThreadRealtimeDirtyContext): void {
  const timelineQueryKeys = getThreadTimelineWindowInvalidationQueryKeys({
    threadId,
  });
  const outlineQueryKeys = getThreadConversationOutlineInvalidationQueryKeys({
    threadId,
  });
  const outlineMayHaveChanged =
    eventTypes === undefined || eventTypes.includes("turn/completed");
  if (
    threadId !== undefined &&
    !hasActiveQueries(queryClient, threadTimelineQueryKeyPrefix(threadId))
  ) {
    for (const queryKey of [...timelineQueryKeys, ...outlineQueryKeys]) {
      queryClient.invalidateQueries({ queryKey, refetchType: "none" });
    }
    return;
  }
  if (eventTypes?.includes("turn/completed")) {
    invalidateTerminalTimelineQueryKeys({
      queryClient,
      queryKeys: [...timelineQueryKeys, ...outlineQueryKeys],
    });
    return;
  }
  invalidateQueryKeysWithoutCancelingActiveFetches({
    queryClient,
    queryKeys: timelineQueryKeys,
  });
  if (outlineMayHaveChanged) {
    invalidateQueryKeysWithoutCancelingActiveFetches({
      queryClient,
      queryKeys: outlineQueryKeys,
    });
  }
}

function dirtyThreadPromptHistoryQueriesForTurnRequests({
  eventTypes,
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  if (!eventTypes?.includes("client/turn/requested")) {
    return [];
  }
  return getThreadPromptHistoryInvalidationQueryKeys({ threadId });
}

function dirtyThreadPullRequestQueryForCompletedTurn({
  eventTypes,
  queryClient,
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  if (!threadId || !eventTypes?.includes("turn/completed")) {
    return [];
  }
  const cachedThread =
    queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey(threadId)) ??
    getCachedThreadListPlaceholder(queryClient, threadId) ??
    getCachedSidebarNavigationThreads(queryClient).find(
      (thread) => thread.id === threadId,
    );
  const environmentId = cachedThread?.environmentId;
  return environmentId ? [environmentPullRequestQueryKey(environmentId)] : [];
}

function dirtyThreadTerminalQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return threadId
    ? [terminalsQueryKey({ kind: "thread", threadId })]
    : [allTerminalsQueryKeyPrefix()];
}

function dirtyThreadStorageQueriesForThread({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  if (!threadId) {
    return [
      allThreadStorageFilesQueryKeyPrefix(),
      allThreadStorageLocationsQueryKeyPrefix(),
      allThreadStoragePathsQueryKeyPrefix(),
      allThreadStorageFilePreviewQueryKeyPrefix(),
    ];
  }
  return [
    threadStorageFilesForThreadQueryKeyPrefix(threadId),
    threadStorageLocationQueryKey(threadId),
    threadStoragePathsForThreadQueryKeyPrefix(threadId),
    threadStorageFilePreviewQueryKeyPrefix(threadId),
  ];
}

function dirtyProjectPromptHistoryQueries({
  projectId,
}: ProjectRealtimeDirtyContext | ThreadRealtimeDirtyContext): QueryKey[] {
  return getProjectPromptHistoryInvalidationQueryKeys({ projectId });
}

function markThreadDetailQueryStale({
  queryClient,
  threadId,
}: ThreadRealtimeDirtyContext): void {
  if (!threadId) {
    return;
  }
  queryClient.invalidateQueries({
    queryKey: threadQueryKey(threadId),
    refetchType: "none",
  });
}

function markThreadListQueriesStale({
  projectId,
  queryClient,
}: ThreadRealtimeDirtyContext): void {
  queryClient.invalidateQueries({
    queryKey: sidebarNavigationQueryKey(),
    refetchType: "none",
  });
  if (!projectId) {
    queryClient.invalidateQueries({
      queryKey: threadsQueryKey(),
      refetchType: "none",
    });
    return;
  }
  for (const queryKey of getCachedProjectThreadListInvalidationQueryKeys({
    projectId,
    queryClient,
  })) {
    queryClient.invalidateQueries({
      queryKey,
      refetchType: "none",
    });
  }
  for (const queryKey of getCachedGlobalThreadListInvalidationQueryKeys({
    queryClient,
  })) {
    queryClient.invalidateQueries({
      exact: true,
      queryKey,
      refetchType: "none",
    });
  }
}

function patchThreadListPendingInteractionState({
  hasPendingInteraction,
  queryClient,
  threadId,
}: ThreadRealtimeDirtyContext): void {
  if (!threadId || hasPendingInteraction === undefined) {
    return;
  }
  updateCachedThreadListPendingInteractionState(
    queryClient,
    threadId,
    hasPendingInteraction,
  );
}

function patchThreadListStatusState(context: ThreadRealtimeDirtyContext): void {
  const { flushOnce, queryClient, statusChange, threadId } = context;
  if (!threadId || !statusChange) {
    dirtyActiveThreadListQueriesWithThrottledRefetch(context);
    return;
  }
  updateCachedThreadListStatusState(queryClient, threadId, statusChange);
  for (const queryKey of getFetchingThreadListQueryKeys(queryClient)) {
    queryClient.invalidateQueries({ exact: true, queryKey });
  }
  if (flushOnce("thread-search:status-changed")) {
    invalidateQueryKeysWithoutCancelingActiveFetches({
      queryClient,
      queryKeys: [threadSearchQueryKeyPrefix()],
    });
  }
}

function dirtyEnvironmentRecordQueries(
  context: EnvironmentRealtimeDirtyContext,
): QueryKey[] {
  return getEnvironmentRecordInvalidationQueryKeys(context);
}

function dirtyEnvironmentWorkspaceStateQueries(
  context: EnvironmentRealtimeDirtyContext,
): void {
  for (const queryKey of getEnvironmentWorkspaceStateInvalidationQueryKeys(
    context,
  )) {
    context.queryClient.invalidateQueries({ queryKey });
  }
  removeEnvironmentDiffPatchQueries(context);
}

function dirtyEnvironmentLiveWorkspaceStateQueries({
  environmentId,
  queryClient,
}: EnvironmentRealtimeDirtyContext): void {
  invalidateQueryKeyWithThrottledActiveRefetch({
    exact: false,
    minIntervalMs: WORK_STATUS_REFETCH_MIN_INTERVAL_MS,
    queryClient,
    queryKey: environmentWorkStatusQueryKeyPrefix(environmentId),
  });
  queryClient.invalidateQueries({
    queryKey: environmentFilePreviewQueryKeyPrefix(environmentId),
  });
  queryClient.invalidateQueries({
    queryKey: environmentDiffFilesQueryKeyPrefix(environmentId),
  });
  removeEnvironmentDiffPatchQueries({ environmentId, queryClient });
}

function dirtyEnvironmentRefDerivedWorkspaceStateQueries({
  environmentId,
  queryClient,
}: EnvironmentRealtimeDirtyContext): void {
  for (const queryKey of getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys(
    queryClient,
    { environmentId },
  )) {
    queryClient.invalidateQueries({ queryKey });
  }
  removeEnvironmentDiffPatchQueries({ environmentId, queryClient });
}

function dirtyEnvironmentBranchListQueries(
  context: EnvironmentRealtimeDirtyContext,
): QueryKey[] {
  return getEnvironmentBranchListInvalidationQueryKeys(context);
}

function dirtyEnvironmentThreadListQueries({
  environmentId,
  queryClient,
}: EnvironmentRealtimeDirtyContext): QueryKey[] {
  const queryKeys: QueryKey[] = [];
  for (const { data, queryKey } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of iterateThreadListCacheEntries(data)) {
      if (thread.environmentId !== environmentId) {
        continue;
      }
      queryKeys.push(queryKey);
      break;
    }
  }

  const sidebarContainsEnvironment = getCachedSidebarNavigationThreads(
    queryClient,
  ).some((thread) => thread.environmentId === environmentId);
  if (sidebarContainsEnvironment) {
    queryKeys.push(sidebarNavigationQueryKey());
  }

  return queryKeys;
}

function dirtyThreadStorageQueriesForEnvironment({
  getCachedThreadIdsForEnvironment,
}: EnvironmentRealtimeDirtyContext): QueryKey[] {
  const queryKeys: QueryKey[] = [];
  for (const threadId of getCachedThreadIdsForEnvironment()) {
    queryKeys.push(threadStorageFilesForThreadQueryKeyPrefix(threadId));
    queryKeys.push(threadStoragePathsForThreadQueryKeyPrefix(threadId));
    queryKeys.push(threadStorageFilePreviewQueryKeyPrefix(threadId));
  }
  return queryKeys;
}

function dirtyHostAvailabilityQueries(): QueryKey[] {
  return [hostsQueryKey(), allHostQueryKeyPrefix()];
}

function dirtySystemConfigQueries({ queryClient }: RealtimeDirtyContext): void {
  invalidateQueryKeysWithoutCancelingActiveFetches({
    queryClient,
    queryKeys: [systemConfigQueryKey()],
  });
}

function dirtyAllThreadTimelineQueries(): QueryKey[] {
  return getThreadTimelineInvalidationQueryKeys({ threadId: undefined });
}

function dirtySystemProviderQueries(): QueryKey[] {
  return [allSystemProvidersQueryKeyPrefix()];
}

function dirtySystemExecutionOptionQueries(): QueryKey[] {
  return [allSystemExecutionOptionsQueryKeyPrefix()];
}

function dirtyPluginContributionQueries(): QueryKey[] {
  return [allPluginContributionsQueryKeyPrefix()];
}

function dirtyProjectCommandCatalogQueries(): QueryKey[] {
  return [allProjectCommandsQueryKeyPrefix()];
}

function dirtyPluginManagementQueries(): QueryKey[] {
  return [
    allPluginListQueryKeyPrefix(),
    allPluginSettingsViewQueryKeyPrefix(),
    allPluginSettingsQueryKeyPrefix(),
    allPluginSourceQueryKeyPrefix(),
    allPluginCatalogSearchQueryKeyPrefix(),
  ];
}

function reconcilePluginFrontendBundles(): void {
  schedulePluginFrontendReconcile();
}
