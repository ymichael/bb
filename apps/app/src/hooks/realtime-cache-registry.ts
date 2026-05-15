import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  EnvironmentChangeKind,
  HostChangeKind,
  ProjectChangeKind,
  SystemChangeKind,
  ThreadChangeKind,
  ThreadEventType,
} from "@bb/domain";
import {
  getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys,
  getCachedProjectThreadListInvalidationQueryKeys,
  getEnvironmentBranchListInvalidationQueryKeys,
  getEnvironmentRecordInvalidationQueryKeys,
  getEnvironmentWorkspaceStateInvalidationQueryKeys,
  updateCachedThreadListPendingInteractionState,
} from "./queries/query-cache";
import {
  allProjectFilesQueryKeyPrefix,
  allProjectGithubBranchesQueryKeyPrefix,
  allProjectSourceBranchesQueryKeyPrefix,
  allHostQueryKeyPrefix,
  allSystemExecutionOptionsQueryKeyPrefix,
  allThreadComposerBootstrapQueryKeyPrefix,
  allThreadQueuedMessagesQueryKeyPrefix,
  allThreadPendingInteractionsQueryKeyPrefix,
  allThreadQueryKeyPrefix,
  allThreadTimelineQueryKeyPrefix,
  hostsQueryKey,
  localPathExistenceQueryKeyPrefix,
  projectFilesQueryKeyPrefix,
  projectGithubBranchesQueryKey,
  projectPromptHistoryQueryKey,
  projectPromptHistoryQueryKeyPrefix,
  projectSourceBranchesQueryKeyPrefix,
  projectsQueryKey,
  systemProvidersQueryKey,
  threadQueuedMessagesQueryKey,
  threadPendingInteractionsQueryKey,
  threadPromptHistoryQueryKey,
  threadPromptHistoryQueryKeyPrefix,
  threadQueryKey,
  threadsQueryKey,
  threadStorageFilePreviewQueryKeyPrefix,
  threadStorageFilesForThreadQueryKeyPrefix,
  threadTimelineQueryKeyPrefix,
} from "./queries/query-keys";

export const REALTIME_THREAD_CHANGE_REGISTRY = {
  "thread-created": {
    flush: "debounced",
    dirty: [
      dirtyThreadListQueries, // New thread can appear in project lists.
      dirtyThreadDetailQueries, // Detail may already be mounted after optimistic create/navigation.
      dirtyThreadTimelineQueries, // Creation can seed initial timeline rows.
      dirtyProjectPromptHistoryQueries, // Project thread changes can hide or reveal stored prompt history.
    ],
  },
  "thread-deleted": {
    flush: "debounced",
    dirty: [
      dirtyThreadListQueries, // Deleted thread must disappear from lists.
      dirtyThreadDetailQueries, // Active detail should reconcile to deleted/not-found.
      dirtyThreadTimelineQueries, // Active timeline should stop showing stale rows.
      dirtyProjectPromptHistoryQueries, // Deleted prompts may leave project history.
    ],
  },
  "events-appended": {
    flush: "debounced",
    dirty: [
      dirtyThreadTimelineQueries, // Timeline rows are built from appended events.
      dirtyThreadPromptHistoryQueriesForTurnRequests, // Follow-up recall is built from client turn requests.
    ],
  },
  "interactions-changed": {
    flush: "debounced",
    dirty: [
      dirtyThreadPendingInteractionQueries, // Composer reads the interaction list directly.
      patchThreadListPendingInteractionState, // Sidebar badge patches from notification metadata.
    ],
  },
  "status-changed": {
    flush: "immediate",
    dirty: [
      dirtyThreadListQueries, // List rows render status/runtime badges.
      dirtyThreadDetailQueries, // Detail controls and banners depend on status.
    ],
  },
  "title-changed": {
    flush: "debounced",
    dirty: [
      dirtyThreadListQueries, // List rows render display title.
      dirtyThreadDetailQueries, // Detail headers and breadcrumbs render display title.
    ],
  },
  "queue-changed": {
    flush: "debounced",
    dirty: [
      dirtyThreadQueuedMessageQueries, // Composer queue reads queued messages directly.
      dirtyThreadPromptHistoryQueries, // Composer recall includes queued messages.
    ],
  },
  "archived-changed": {
    flush: "debounced",
    dirty: [
      dirtyThreadListQueries, // Archive state moves threads between active/archived lists.
      dirtyThreadDetailQueries, // Detail controls and banners depend on archive state.
    ],
  },
  "read-state-changed": {
    flush: "debounced",
    dirty: [
      markThreadDetailQueryStale, // Keep active detail mounted; refresh on next read.
      markThreadListQueriesStale, // Unread badges should go stale without active refetch.
    ],
  },
  "manager-assignment-changed": {
    flush: "debounced",
    dirty: [
      dirtyThreadListQueries, // Sidebar grouping and manager-child filters depend on parentThreadId.
      dirtyThreadDetailQueries, // Detail metadata and managed-by UI render parentThreadId.
    ],
  },
} satisfies ThreadChangeRegistry;

export const REALTIME_ENVIRONMENT_CHANGE_REGISTRY = {
  "environment-created": {
    dirty: [
      dirtyEnvironmentRecordQueries, // Newly persisted environment metadata.
      dirtyEnvironmentWorkspaceStateQueries, // Initial work status/diff/preview state may exist.
      dirtyEnvironmentBranchListQueries, // New environment can expose branch options.
    ],
  },
  "environment-deleted": {
    dirty: [
      dirtyEnvironmentRecordQueries, // Record should reconcile to deleted/not-found.
      dirtyEnvironmentWorkspaceStateQueries, // Work status/diff/preview data is no longer valid.
      dirtyEnvironmentBranchListQueries, // Branch options are scoped to the environment.
    ],
  },
  "metadata-changed": {
    dirty: [
      dirtyEnvironmentRecordQueries, // Branch/display metadata is rendered directly.
      dirtyEnvironmentWorkspaceStateQueries, // Metadata can change workspace-state request resolution.
      dirtyEnvironmentBranchListQueries, // Branch metadata can change merge-base options.
    ],
  },
  "status-changed": {
    dirty: [
      dirtyEnvironmentRecordQueries, // Environment record renders current status.
      dirtyEnvironmentWorkspaceStateQueries, // Status affects availability of workspace state.
      dirtyEnvironmentBranchListQueries, // Status can affect branch option availability.
    ],
  },
  "work-status-changed": {
    dirty: [
      dirtyEnvironmentWorkspaceStateQueries, // Work status, git diff, and previews derive from workspace state.
    ],
  },
  "git-refs-changed": {
    dirty: [
      dirtyEnvironmentRefDerivedWorkspaceStateQueries, // Only cached ref-derived workspace queries need refresh.
      dirtyEnvironmentBranchListQueries, // Refs can add/remove/rename branch options.
    ],
  },
  "thread-storage-changed": {
    dirty: [
      dirtyThreadStorageQueriesForEnvironment, // Storage file lists/previews use thread-scoped keys.
    ],
  },
} satisfies EnvironmentChangeRegistry;

export const REALTIME_PROJECT_CHANGE_REGISTRY = {
  "project-created": {
    dirty: [
      dirtyProjectListQueries, // Navigation and settings are backed by the project list.
    ],
  },
  "project-updated": {
    dirty: [
      dirtyProjectListQueries, // Name/settings fields are embedded in the project list.
    ],
  },
  "project-deleted": {
    dirty: [
      dirtyProjectListQueries, // Deleted projects must disappear from navigation/pickers.
    ],
  },
  "project-sources-changed": {
    dirty: [
      dirtyProjectSourceDependentQueries, // Project sources back settings, file mentions, and branch pickers.
    ],
  },
  "threads-changed": {
    dirty: [
      dirtyProjectListQueries, // Sidebar bootstrap includes thread membership per project.
      dirtyProjectPromptHistoryQueries, // Project thread changes can hide or reveal stored prompt history.
    ],
  },
  "automations-changed": {
    dirty: [
      dirtyProjectListQueries, // Split once automations have dedicated query keys.
    ],
  },
  "nudges-changed": {
    dirty: [
      dirtyProjectListQueries, // Split once nudges have dedicated query keys.
    ],
  },
} satisfies ProjectChangeRegistry;

const HOST_CONNECTION_DIRTY_HANDLERS = [
  dirtyHostAvailabilityQueries, // Host list/detail render connected/disconnected state.
  dirtyProjectListQueries, // Project source availability depends on host connectivity.
  dirtySystemProviderQueries, // Host-backed provider runtimes can appear/disappear.
  dirtySystemExecutionOptionQueries, // Execution options include host/provider availability.
  dirtyThreadComposerBootstrapQueries, // Composer bootstrap seeds execution options.
] satisfies readonly RealtimeDirtyHandler<HostRealtimeDirtyContext>[];

export const REALTIME_HOST_CHANGE_REGISTRY = {
  "host-connected": {
    dirty: HOST_CONNECTION_DIRTY_HANDLERS,
  },
  "host-disconnected": {
    dirty: HOST_CONNECTION_DIRTY_HANDLERS,
  },
} satisfies HostChangeRegistry;

export const REALTIME_SYSTEM_CHANGE_REGISTRY =
  {} satisfies SystemChangeRegistry;

export type ThreadChangeFlushPriority = "debounced" | "immediate";

export interface RealtimeDirtyContext {
  queryClient: QueryClient;
}

export interface ThreadRealtimeDirtyContext extends RealtimeDirtyContext {
  eventTypes: readonly ThreadEventType[] | undefined;
  hasPendingInteraction: boolean | undefined;
  projectId: string | undefined;
  threadId: string | undefined;
}

export interface EnvironmentRealtimeDirtyContext extends RealtimeDirtyContext {
  environmentId: string;
  getCachedThreadIdsForEnvironment: () => string[];
}

export interface ProjectRealtimeDirtyContext extends RealtimeDirtyContext {
  projectId: string | undefined;
}

export type HostRealtimeDirtyContext = RealtimeDirtyContext;

export type RealtimeDirtyHandler<Context extends RealtimeDirtyContext> = (
  context: Context,
) => readonly QueryKey[] | void;

export interface ExecuteRealtimeDirtyHandlersArgs<
  Context extends RealtimeDirtyContext,
> {
  context: Context;
  handlers: readonly RealtimeDirtyHandler<Context>[];
}

export interface ThreadChangeRule {
  dirty: readonly RealtimeDirtyHandler<ThreadRealtimeDirtyContext>[];
  flush: ThreadChangeFlushPriority;
}

export type ThreadChangeRegistry = Record<ThreadChangeKind, ThreadChangeRule>;

export interface EnvironmentChangeRule {
  dirty: readonly RealtimeDirtyHandler<EnvironmentRealtimeDirtyContext>[];
}

export type EnvironmentChangeRegistry = Record<
  EnvironmentChangeKind,
  EnvironmentChangeRule
>;

export interface ProjectChangeRule {
  dirty: readonly RealtimeDirtyHandler<ProjectRealtimeDirtyContext>[];
}

export type ProjectChangeRegistry = Record<
  ProjectChangeKind,
  ProjectChangeRule
>;

export interface HostChangeRule {
  dirty: readonly RealtimeDirtyHandler<HostRealtimeDirtyContext>[];
}

export type HostChangeRegistry = Record<HostChangeKind, HostChangeRule>;

export type SystemChangeRegistry = Record<SystemChangeKind, never>;

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

export function shouldFlushThreadChangesImmediately(
  changes: readonly ThreadChangeKind[],
): boolean {
  return changes.some(
    (change) => REALTIME_THREAD_CHANGE_REGISTRY[change].flush === "immediate",
  );
}

function dirtyThreadListQueries({
  projectId,
  queryClient,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return projectId
    ? getCachedProjectThreadListInvalidationQueryKeys({
        projectId,
        queryClient,
      })
    : [threadsQueryKey()];
}

function dirtyThreadDetailQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return threadId ? [threadQueryKey(threadId)] : [allThreadQueryKeyPrefix()];
}

function dirtyThreadTimelineQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return threadId
    ? [threadTimelineQueryKeyPrefix(threadId)]
    : [allThreadTimelineQueryKeyPrefix()];
}

function dirtyThreadQueuedMessageQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return threadId
    ? [threadQueuedMessagesQueryKey(threadId)]
    : [allThreadQueuedMessagesQueryKeyPrefix()];
}

function dirtyThreadPromptHistoryQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return threadId
    ? [threadPromptHistoryQueryKey(threadId)]
    : [threadPromptHistoryQueryKeyPrefix()];
}

function dirtyThreadPromptHistoryQueriesForTurnRequests({
  eventTypes,
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  if (!eventTypes?.includes("client/turn/requested")) {
    return [];
  }
  return threadId
    ? [threadPromptHistoryQueryKey(threadId)]
    : [threadPromptHistoryQueryKeyPrefix()];
}

function dirtyThreadPendingInteractionQueries({
  threadId,
}: ThreadRealtimeDirtyContext): QueryKey[] {
  return threadId
    ? [threadPendingInteractionsQueryKey(threadId)]
    : [allThreadPendingInteractionsQueryKeyPrefix()];
}

function dirtyProjectPromptHistoryQueries({
  projectId,
}: ProjectRealtimeDirtyContext | ThreadRealtimeDirtyContext): QueryKey[] {
  return projectId
    ? [projectPromptHistoryQueryKey(projectId)]
    : [projectPromptHistoryQueryKeyPrefix()];
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

function dirtyEnvironmentRecordQueries(
  context: EnvironmentRealtimeDirtyContext,
): QueryKey[] {
  return getEnvironmentRecordInvalidationQueryKeys(context);
}

function dirtyEnvironmentWorkspaceStateQueries(
  context: EnvironmentRealtimeDirtyContext,
): QueryKey[] {
  return getEnvironmentWorkspaceStateInvalidationQueryKeys(context);
}

function dirtyEnvironmentRefDerivedWorkspaceStateQueries({
  environmentId,
  queryClient,
}: EnvironmentRealtimeDirtyContext): QueryKey[] {
  return getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys(
    queryClient,
    { environmentId },
  );
}

function dirtyEnvironmentBranchListQueries(
  context: EnvironmentRealtimeDirtyContext,
): QueryKey[] {
  return getEnvironmentBranchListInvalidationQueryKeys(context);
}

function dirtyThreadStorageQueriesForEnvironment({
  getCachedThreadIdsForEnvironment,
}: EnvironmentRealtimeDirtyContext): QueryKey[] {
  const queryKeys: QueryKey[] = [];
  for (const threadId of getCachedThreadIdsForEnvironment()) {
    queryKeys.push(threadStorageFilesForThreadQueryKeyPrefix(threadId));
    queryKeys.push(threadStorageFilePreviewQueryKeyPrefix(threadId));
  }
  return queryKeys;
}

function dirtyProjectListQueries(): QueryKey[] {
  return [projectsQueryKey()];
}

function dirtyProjectSourceDependentQueries({
  projectId,
}: ProjectRealtimeDirtyContext): QueryKey[] {
  const sharedKeys: QueryKey[] = [
    projectsQueryKey(),
    localPathExistenceQueryKeyPrefix(),
  ];
  if (!projectId) {
    return [
      ...sharedKeys,
      allProjectFilesQueryKeyPrefix(),
      allProjectSourceBranchesQueryKeyPrefix(),
      allProjectGithubBranchesQueryKeyPrefix(),
    ];
  }
  return [
    ...sharedKeys,
    projectFilesQueryKeyPrefix(projectId),
    projectSourceBranchesQueryKeyPrefix(projectId),
    projectGithubBranchesQueryKey(projectId),
  ];
}

function dirtyHostAvailabilityQueries(): QueryKey[] {
  return [hostsQueryKey(), allHostQueryKeyPrefix()];
}

function dirtySystemProviderQueries(): QueryKey[] {
  return [systemProvidersQueryKey()];
}

function dirtySystemExecutionOptionQueries(): QueryKey[] {
  return [allSystemExecutionOptionsQueryKeyPrefix()];
}

function dirtyThreadComposerBootstrapQueries(): QueryKey[] {
  return [allThreadComposerBootstrapQueryKeyPrefix()];
}
