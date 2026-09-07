import { createDebouncedCallbackScheduler } from "@bb/domain";
import type {
  ChangedMessage,
  SidebarBootstrapResponse,
  ThreadChangedMessage,
  ThreadChangeKind,
  ThreadResponse,
} from "@bb/server-contract";
import {
  hashKey,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { MobileRealtime } from "../realtime/mobile-realtime";
import {
  disposeTrailingActiveRefetches,
  invalidateTimelineQueryKeyPaced,
  invalidateTimelineQueryKeyTerminal,
} from "./timeline-refetch-pacing";
import {
  removeAllDiffPatchQueries,
  removeEnvironmentDiffPatchQueries,
} from "./diff-patch-cache";
import {
  allEnvironmentDiffFilesQueryKeyPrefix,
  allEnvironmentMergeBaseBranchesQueryKeyPrefix,
  allEnvironmentPullRequestQueryKeyPrefix,
  allEnvironmentQueryKeyPrefix,
  allEnvironmentWorkStatusQueryKeyPrefix,
  allHostCloneDefaultPathQueryKeyPrefix,
  allHostDirectoryQueryKeyPrefix,
  allHostProviderCliStatusQueryKeyPrefix,
  allHostQueryKeyPrefix,
  allSystemUsageLimitsQueryKeyPrefix,
  hostProviderCliStatusQueryKey,
  systemCliSkillsQueryKey,
  themeCatalogQueryKey,
  allProjectCommandsQueryKeyPrefix,
  allProjectDefaultExecutionOptionsQueryKeyPrefix,
  allProjectPathsQueryKeyPrefix,
  allProjectSourceBranchesQueryKeyPrefix,
  allSystemExecutionOptionsQueryKeyPrefix,
  allSystemProvidersQueryKeyPrefix,
  pluginContributionsQueryKey,
  pluginsQueryKey,
  pluginUpdatesQueryKey,
  allPluginCatalogSearchQueryKeyPrefix,
  allProjectSkillsQueryKeyPrefix,
  environmentDiffFilesQueryKeyPrefix,
  environmentMergeBaseBranchesQueryKeyPrefix,
  environmentPathsQueryKeyPrefix,
  environmentPullRequestQueryKey,
  environmentQueryKey,
  environmentsQueryKey,
  environmentWorkStatusQueryKeyPrefix,
  hostQueryKey,
  hostsQueryKey,
  projectsQueryKey,
  sidebarNavigationQueryKey,
  systemConfigQueryKey,
  threadDefaultExecutionOptionsQueryKey,
  threadDetailBootstrapQueryKey,
  threadPendingInteractionsQueryKey,
  threadQueryKey,
  threadQueuedMessagesQueryKey,
  threadSearchQueryKeyPrefix,
  allTerminalsQueryKeyPrefix,
  threadTabsQueryKey,
  allThreadStoragePathsQueryKeyPrefix,
  allThreadStorageFilesQueryKeyPrefix,
  allThreadStorageFilePreviewQueryKeyPrefix,
  allProjectFilePreviewQueryKeyPrefix,
  environmentFilePreviewQueryKeyPrefix,
  projectFilePreviewQueryKeyPrefix,
  threadTimelineQueryKey,
  threadTimelineTurnSummaryDetailsQueryKeyPrefix,
  threadsQueryKey,
} from "./query-keys";

const INVALIDATION_DEBOUNCE_MS = 50;
const INVALIDATION_MAX_WAIT_MS = 200;

const THREAD_LIST_AFFECTING_KINDS: ReadonlySet<ThreadChangeKind> =
  new Set<ThreadChangeKind>([
    "thread-created",
    "thread-deleted",
    "interactions-changed",
    "status-changed",
    "title-changed",
    "queue-changed",
    "archived-changed",
    "pin-state-changed",
    "parent-changed",
    "environment-changed",
    "read-state-changed",
    "order-changed",
  ]);

function threadListQueryKeys(): QueryKey[] {
  return [
    threadsQueryKey(),
    sidebarNavigationQueryKey(),
    threadSearchQueryKeyPrefix(),
  ];
}

export function queryKeysForChangedMessage(
  message: ChangedMessage,
): readonly QueryKey[] {
  switch (message.entity) {
    case "thread": {
      const keys: QueryKey[] = [];
      const id = message.id;
      if (id === undefined) {
        return threadListQueryKeys();
      }
      const kinds = new Set(message.changes);
      if (
        message.changes.some((kind) => kind !== "events-appended") ||
        message.metadata?.backgroundActivityChanged === true
      ) {
        keys.push(threadQueryKey(id));
      }
      if (kinds.has("events-appended") || kinds.has("history-rewritten")) {
        keys.push(threadTimelineQueryKey(id));
      }
      if (kinds.has("history-rewritten")) {
        keys.push(
          threadDetailBootstrapQueryKey(id),
          threadTimelineTurnSummaryDetailsQueryKeyPrefix(id),
        );
      }
      if (kinds.has("interactions-changed")) {
        keys.push(threadPendingInteractionsQueryKey(id));
      }
      if (kinds.has("queue-changed")) {
        keys.push(threadQueuedMessagesQueryKey(id));
      }
      if (kinds.has("terminals-changed")) {
        keys.push(allTerminalsQueryKeyPrefix());
      }
      if (kinds.has("tabs-changed")) {
        keys.push(threadTabsQueryKey(id));
      }
      if (kinds.has("environment-changed") || kinds.has("history-rewritten")) {
        keys.push(threadDefaultExecutionOptionsQueryKey(id));
      }
      if (
        message.changes.some((kind) => THREAD_LIST_AFFECTING_KINDS.has(kind))
      ) {
        keys.push(...threadListQueryKeys());
      }
      return keys;
    }
    case "project": {
      const kinds = new Set(message.changes);
      const keys: QueryKey[] = [projectsQueryKey(), ...threadListQueryKeys()];
      if (kinds.has("project-sources-changed")) {
        keys.push(
          allProjectPathsQueryKeyPrefix(),
          allProjectSourceBranchesQueryKeyPrefix(),
          allProjectDefaultExecutionOptionsQueryKeyPrefix(),
          allProjectCommandsQueryKeyPrefix(),
          message.id === undefined
            ? allProjectFilePreviewQueryKeyPrefix()
            : projectFilePreviewQueryKeyPrefix(message.id),
        );
      }
      return keys;
    }
    case "environment": {
      const kinds = new Set(message.changes);
      if (message.id === undefined) {
        return [
          environmentsQueryKey(),
          allEnvironmentQueryKeyPrefix(),
          allEnvironmentWorkStatusQueryKeyPrefix(),
          allEnvironmentPullRequestQueryKeyPrefix(),
          allEnvironmentMergeBaseBranchesQueryKeyPrefix(),
          allEnvironmentDiffFilesQueryKeyPrefix(),
        ];
      }
      const id = message.id;
      const keys: QueryKey[] = [environmentsQueryKey()];
      const workspaceOnly =
        message.changes.length > 0 &&
        message.changes.every(
          (kind) =>
            kind === "work-status-changed" || kind === "git-refs-changed",
        );
      if (!workspaceOnly) {
        keys.push(environmentQueryKey(id), environmentPullRequestQueryKey(id));
      }
      keys.push(
        environmentWorkStatusQueryKeyPrefix(id),
        environmentDiffFilesQueryKeyPrefix(id),
      );
      if (kinds.has("work-status-changed")) {
        keys.push(
          environmentPathsQueryKeyPrefix(id),
          environmentFilePreviewQueryKeyPrefix(id),
        );
      }
      if (kinds.has("thread-storage-changed")) {
        keys.push(
          allThreadStoragePathsQueryKeyPrefix(),
          allThreadStorageFilesQueryKeyPrefix(),
          allThreadStorageFilePreviewQueryKeyPrefix(),
        );
      }
      if (!kinds.has("work-status-changed") || kinds.size > 1) {
        keys.push(environmentMergeBaseBranchesQueryKeyPrefix(id));
      }
      if (kinds.has("metadata-changed")) {
        keys.push(...threadListQueryKeys());
      }
      return keys;
    }
    case "host":
      return [
        hostsQueryKey(),
        ...(message.id === undefined
          ? [allHostQueryKeyPrefix()]
          : [hostQueryKey(message.id)]),
        allSystemProvidersQueryKeyPrefix(),
        allSystemExecutionOptionsQueryKeyPrefix(),
        allProjectDefaultExecutionOptionsQueryKeyPrefix(),
        systemConfigQueryKey(),
        sidebarNavigationQueryKey(),
        allHostDirectoryQueryKeyPrefix(),
        allHostCloneDefaultPathQueryKeyPrefix(),
        message.id === undefined
          ? allHostProviderCliStatusQueryKeyPrefix()
          : hostProviderCliStatusQueryKey(message.id),
        systemCliSkillsQueryKey(),
        allSystemUsageLimitsQueryKeyPrefix(),
      ];
    case "system": {
      const kinds = new Set(message.changes);
      const keys: QueryKey[] = [systemConfigQueryKey()];
      if (
        kinds.has("config-changed") ||
        kinds.has("provider-registrations-changed") ||
        kinds.has("plugins-changed")
      ) {
        keys.push(
          allSystemProvidersQueryKeyPrefix(),
          allSystemExecutionOptionsQueryKeyPrefix(),
          allProjectDefaultExecutionOptionsQueryKeyPrefix(),
        );
      }
      if (kinds.has("plugins-changed")) {
        keys.push(
          pluginContributionsQueryKey(),
          allProjectCommandsQueryKeyPrefix(),
          pluginsQueryKey(),
          pluginUpdatesQueryKey(),
          allPluginCatalogSearchQueryKeyPrefix(),
          allProjectSkillsQueryKeyPrefix(),
        );
      }
      if (kinds.has("config-changed") || kinds.has("plugins-changed")) {
        keys.push(themeCatalogQueryKey());
      }
      return keys;
    }
    default:
      return [];
  }
}

function diffPatchEvictionForChangedMessage(
  message: ChangedMessage,
): "all" | string | null {
  if (message.entity !== "environment") return null;
  return message.id === undefined ? "all" : message.id;
}

function cachedThreadEnvironmentId(
  queryClient: QueryClient,
  threadId: string,
): string | null {
  const thread = queryClient.getQueryData<ThreadResponse>(
    threadQueryKey(threadId),
  );
  if (thread !== undefined) return thread.environmentId;
  const sidebar = queryClient.getQueryData<SidebarBootstrapResponse>(
    sidebarNavigationQueryKey(),
  );
  if (sidebar === undefined) return null;
  for (const project of [...sidebar.projects, sidebar.personalProject]) {
    const entry = project.threads.find((row) => row.id === threadId);
    if (entry !== undefined) return entry.environmentId;
  }
  return null;
}

export function threadPullRequestQueryKeysForCompletedTurn(
  queryClient: QueryClient,
  message: ChangedMessage,
): readonly QueryKey[] {
  if (
    message.entity !== "thread" ||
    message.id === undefined ||
    !message.changes.includes("events-appended") ||
    !message.metadata?.eventTypes?.includes("turn/completed")
  ) {
    return [];
  }
  const environmentId = cachedThreadEnvironmentId(queryClient, message.id);
  return environmentId === null
    ? []
    : [environmentPullRequestQueryKey(environmentId)];
}

export type TimelineInvalidationPolicy =
  | "default"
  | "timeline-paced"
  | "timeline-terminal";

const INVALIDATION_POLICY_RANK: Record<TimelineInvalidationPolicy, number> = {
  "timeline-paced": 0,
  default: 1,
  "timeline-terminal": 2,
};

function isTimelineQueryKey(queryKey: QueryKey): boolean {
  return queryKey[0] === threadTimelineQueryKey("")[0];
}

export function timelineInvalidationPolicyForMessage(
  message: ThreadChangedMessage,
): TimelineInvalidationPolicy {
  const kinds = new Set(message.changes);
  if (!kinds.has("events-appended") || kinds.has("history-rewritten")) {
    return "default";
  }
  return message.metadata?.eventTypes?.includes("turn/completed")
    ? "timeline-terminal"
    : "timeline-paced";
}

function invalidationPolicyForKey(
  message: ChangedMessage,
  queryKey: QueryKey,
): TimelineInvalidationPolicy {
  if (message.entity !== "thread" || !isTimelineQueryKey(queryKey)) {
    return "default";
  }
  return timelineInvalidationPolicyForMessage(message);
}

function strongerInvalidationPolicy(
  left: TimelineInvalidationPolicy,
  right: TimelineInvalidationPolicy,
): TimelineInvalidationPolicy {
  return INVALIDATION_POLICY_RANK[right] > INVALIDATION_POLICY_RANK[left]
    ? right
    : left;
}

interface PendingInvalidation {
  queryKey: QueryKey;
  policy: TimelineInvalidationPolicy;
}

function invalidateQueriesStaleSince(
  queryClient: QueryClient,
  disconnectedAt: number,
): void {
  void queryClient.invalidateQueries(
    { predicate: (query) => query.state.dataUpdatedAt < disconnectedAt },
    { cancelRefetch: false },
  );
}

export interface RealtimeInvalidationHandle {
  flush(): void;
  dispose(): void;
}

export function installRealtimeInvalidation(
  queryClient: QueryClient,
  realtime: MobileRealtime,
): RealtimeInvalidationHandle {
  const pending = new Map<string, PendingInvalidation>();
  let pendingPatchEvictions: Set<string> | "all" = new Set<string>();
  const scheduler = createDebouncedCallbackScheduler({
    debounceMs: INVALIDATION_DEBOUNCE_MS,
    maxWaitMs: INVALIDATION_MAX_WAIT_MS,
    onFlush: () => {
      const entries = Array.from(pending.values());
      pending.clear();
      const evictions = pendingPatchEvictions;
      pendingPatchEvictions = new Set<string>();
      if (evictions === "all") {
        removeAllDiffPatchQueries(queryClient);
      } else {
        for (const environmentId of evictions) {
          removeEnvironmentDiffPatchQueries(queryClient, environmentId);
        }
      }
      for (const { queryKey, policy } of entries) {
        switch (policy) {
          case "timeline-paced":
            invalidateTimelineQueryKeyPaced(queryClient, queryKey);
            break;
          case "timeline-terminal":
            invalidateTimelineQueryKeyTerminal(queryClient, queryKey);
            break;
          case "default":
            void queryClient.invalidateQueries({ queryKey });
            break;
        }
      }
    },
  });

  const unsubscribeChanged = realtime.onChanged((message) => {
    const eviction = diffPatchEvictionForChangedMessage(message);
    if (eviction === "all") {
      pendingPatchEvictions = "all";
    } else if (eviction !== null && pendingPatchEvictions !== "all") {
      pendingPatchEvictions.add(eviction);
    }
    const keys = [
      ...queryKeysForChangedMessage(message),
      ...threadPullRequestQueryKeysForCompletedTurn(queryClient, message),
    ];
    if (keys.length === 0 && eviction === null) return;
    for (const queryKey of keys) {
      const hash = hashKey(queryKey);
      const policy = invalidationPolicyForKey(message, queryKey);
      const current = pending.get(hash);
      pending.set(hash, {
        queryKey,
        policy: current
          ? strongerInvalidationPolicy(current.policy, policy)
          : policy,
      });
    }
    scheduler.schedule();
  });
  const unsubscribeConnected = realtime.onConnected((event) => {
    if (!event.reconnected) return;
    removeAllDiffPatchQueries(queryClient);
    invalidateQueriesStaleSince(queryClient, event.disconnectedAt);
  });

  return {
    flush: () => {
      if (
        pending.size > 0 ||
        pendingPatchEvictions === "all" ||
        pendingPatchEvictions.size > 0
      ) {
        scheduler.flush();
      }
    },
    dispose: () => {
      unsubscribeChanged();
      unsubscribeConnected();
      scheduler.dispose();
      disposeTrailingActiveRefetches(queryClient);
      pending.clear();
    },
  };
}
