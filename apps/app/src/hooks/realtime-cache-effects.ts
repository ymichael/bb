import type { QueryClient } from "@tanstack/react-query";
import { assertNever } from "@bb/core-ui";
import {
  createDebouncedCallbackScheduler,
  type ChangedMessage,
  type EnvironmentChangeKind,
  type ThreadListEntry,
  type ThreadChangeKind,
  type ThreadWithRuntime,
} from "@bb/domain";
import { updateCachedThreadListPendingInteractionState } from "./queries/query-cache";
import {
  allThreadDraftsQueryKeyPrefix,
  allThreadPendingInteractionsQueryKeyPrefix,
  allThreadQueryKeyPrefix,
  allThreadTimelineQueryKeyPrefix,
  statusQueryKey,
  threadDraftsQueryKey,
  threadPendingInteractionsQueryKey,
  threadQueryKey,
  threadsQueryKey,
  threadTimelineQueryKeyPrefix,
} from "./queries/query-keys";
import {
  invalidateRealtimeEnvironmentChangeQueries,
  invalidateThreadStorageQueries,
} from "./environment-cache-effects";
import {
  invalidateHostChangeDependentQueries,
  invalidateHostsAfterServerInitialConnection,
  invalidateRealtimeQueriesAfterServerReconnect,
} from "./system-cache-effects";
import { invalidateProjectListQueries } from "./mutation-cache-effects";
import { createBufferedEnvironmentInvalidator } from "./buffered-environment-invalidator";
import * as api from "../lib/api";

const INVALIDATION_DEBOUNCE_MS = 50;
const INVALIDATION_MAX_WAIT_MS = 200;
const ENVIRONMENT_INVALIDATION_DEBOUNCE_MS = 250;
const ENVIRONMENT_INVALIDATION_MAX_WAIT_MS = 500;

export interface RealtimeConnectedEvent {
  reconnected: boolean;
}

export interface RealtimeCacheEffects {
  dispose: () => void;
  handleChanged: (message: ChangedMessage) => void;
  handleConnected: (event: RealtimeConnectedEvent) => void;
}

export interface RealtimeCacheEffectsOptions {
  queryClient: QueryClient;
}

interface ThreadChangeFlags {
  interactionsChanged: boolean;
  listChanged: boolean;
  queueChanged: boolean;
  threadChanged: boolean;
  timelineChanged: boolean;
  statusChanged: boolean;
}

interface ThreadChangeState {
  changedThreadKinds: Map<string, Set<ThreadChangeKind>>;
  globalChangeKinds: Set<ThreadChangeKind>;
  shouldInvalidateAllThreadDrafts: boolean;
  shouldInvalidateAllThreadPendingInteractions: boolean;
  shouldInvalidateAllThreadTimeline: boolean;
  shouldInvalidateAllThreadsById: boolean;
  shouldInvalidateStatus: boolean;
  shouldInvalidateThreads: boolean;
}

interface MergeThreadChangesArg {
  changes: readonly ThreadChangeKind[];
  state: ThreadChangeState;
  threadId: string;
}

interface EnvironmentArg {
  environmentId: string;
  queryClient: QueryClient;
}

interface RealtimeEnvironmentChangedArg extends EnvironmentArg {
  changeKinds: readonly EnvironmentChangeKind[];
}

function createThreadChangeState(): ThreadChangeState {
  return {
    changedThreadKinds: new Map<string, Set<ThreadChangeKind>>(),
    globalChangeKinds: new Set<ThreadChangeKind>(),
    shouldInvalidateAllThreadDrafts: false,
    shouldInvalidateAllThreadPendingInteractions: false,
    shouldInvalidateAllThreadTimeline: false,
    shouldInvalidateAllThreadsById: false,
    shouldInvalidateStatus: false,
    shouldInvalidateThreads: false,
  };
}

function resetThreadChangeState(state: ThreadChangeState): void {
  state.changedThreadKinds.clear();
  state.globalChangeKinds.clear();
  state.shouldInvalidateAllThreadDrafts = false;
  state.shouldInvalidateAllThreadPendingInteractions = false;
  state.shouldInvalidateAllThreadTimeline = false;
  state.shouldInvalidateAllThreadsById = false;
  state.shouldInvalidateStatus = false;
  state.shouldInvalidateThreads = false;
}

function getThreadChangeFlags(
  changes: readonly ThreadChangeKind[],
): ThreadChangeFlags {
  const flags: ThreadChangeFlags = {
    interactionsChanged: false,
    listChanged: false,
    queueChanged: false,
    threadChanged: false,
    timelineChanged: false,
    statusChanged: false,
  };

  for (const change of changes) {
    switch (change) {
      case "thread-created":
      case "thread-deleted":
      case "archived-changed":
      case "read-state-changed":
      case "title-changed":
        flags.listChanged = true;
        flags.threadChanged = true;
        if (change === "thread-created" || change === "thread-deleted") {
          flags.timelineChanged = true;
        }
        break;
      case "queue-changed":
        flags.queueChanged = true;
        flags.threadChanged = true;
        break;
      case "interactions-changed":
        flags.interactionsChanged = true;
        flags.threadChanged = true;
        flags.timelineChanged = true;
        break;
      case "status-changed":
        flags.listChanged = true;
        flags.threadChanged = true;
        flags.timelineChanged = true;
        flags.statusChanged = true;
        break;
      case "events-appended":
        flags.threadChanged = true;
        flags.timelineChanged = true;
        break;
      default:
        assertNever(change);
    }
  }

  return flags;
}

export function shouldFlushThreadChangesImmediately(
  changes: readonly ThreadChangeKind[],
): boolean {
  return getThreadChangeFlags(changes).statusChanged;
}

function collectCachedThreadIdsForEnvironment({
  environmentId,
  queryClient,
}: EnvironmentArg): string[] {
  const threadIds = new Set<string>();
  for (const [, thread] of queryClient.getQueriesData<ThreadWithRuntime>({
    queryKey: allThreadQueryKeyPrefix(),
  })) {
    if (thread?.environmentId === environmentId) {
      threadIds.add(thread.id);
    }
  }
  for (const [, threads] of queryClient.getQueriesData<ThreadListEntry[]>({
    queryKey: threadsQueryKey(),
  })) {
    for (const thread of threads ?? []) {
      if (thread.environmentId === environmentId) {
        threadIds.add(thread.id);
      }
    }
  }
  return Array.from(threadIds);
}

function mergeThreadChanges({
  changes,
  state,
  threadId,
}: MergeThreadChangesArg): void {
  let entry = state.changedThreadKinds.get(threadId);
  if (!entry) {
    entry = new Set<ThreadChangeKind>();
    state.changedThreadKinds.set(threadId, entry);
  }
  for (const change of changes) {
    entry.add(change);
  }
}

function flushThreadInvalidations(
  queryClient: QueryClient,
  state: ThreadChangeState,
): void {
  if (state.shouldInvalidateThreads) {
    queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
  }

  if (state.shouldInvalidateAllThreadsById) {
    queryClient.invalidateQueries({ queryKey: allThreadQueryKeyPrefix() });
  }
  if (state.shouldInvalidateAllThreadDrafts) {
    queryClient.invalidateQueries({
      queryKey: allThreadDraftsQueryKeyPrefix(),
    });
  }
  if (state.shouldInvalidateAllThreadPendingInteractions) {
    queryClient.invalidateQueries({
      queryKey: allThreadPendingInteractionsQueryKeyPrefix(),
    });
  }
  if (state.shouldInvalidateAllThreadTimeline) {
    queryClient.invalidateQueries({
      queryKey: allThreadTimelineQueryKeyPrefix(),
    });
  }

  for (const [threadId, changeKinds] of state.changedThreadKinds) {
    const flags = getThreadChangeFlags(Array.from(changeKinds));

    if (flags.threadChanged) {
      queryClient.invalidateQueries({ queryKey: threadQueryKey(threadId) });
    }
    if (flags.queueChanged) {
      queryClient.invalidateQueries({
        queryKey: threadDraftsQueryKey(threadId),
      });
    }
    if (flags.interactionsChanged) {
      queryClient.invalidateQueries({
        queryKey: threadPendingInteractionsQueryKey(threadId),
      });
      void queryClient
        .fetchQuery({
          queryKey: threadPendingInteractionsQueryKey(threadId),
          queryFn: ({ signal }) =>
            api.listThreadPendingInteractions(threadId, signal),
        })
        .then((interactions) => {
          updateCachedThreadListPendingInteractionState(
            queryClient,
            threadId,
            interactions.length > 0,
          );
        })
        .catch(() => {
          queryClient.invalidateQueries({ queryKey: threadsQueryKey() });
        });
    }
    if (flags.timelineChanged) {
      queryClient.invalidateQueries({
        queryKey: threadTimelineQueryKeyPrefix(threadId),
      });
    }
  }

  if (state.shouldInvalidateStatus) {
    queryClient.invalidateQueries({ queryKey: statusQueryKey() });
  }

  resetThreadChangeState(state);
}

function recordThreadChange(
  state: ThreadChangeState,
  message: ChangedMessage,
): void {
  if (message.entity !== "thread") {
    return;
  }

  if (message.id) {
    mergeThreadChanges({
      changes: message.changes,
      state,
      threadId: message.id,
    });
    const flags = getThreadChangeFlags(message.changes);
    if (flags.listChanged) {
      state.shouldInvalidateThreads = true;
      state.shouldInvalidateStatus = true;
    }
    return;
  }

  for (const change of message.changes) {
    state.globalChangeKinds.add(change);
  }
  const globalFlags = getThreadChangeFlags(Array.from(state.globalChangeKinds));
  if (globalFlags.listChanged) {
    state.shouldInvalidateThreads = true;
    state.shouldInvalidateStatus = true;
  }
  state.shouldInvalidateAllThreadsById = globalFlags.threadChanged;
  state.shouldInvalidateAllThreadDrafts = globalFlags.queueChanged;
  state.shouldInvalidateAllThreadPendingInteractions =
    globalFlags.interactionsChanged;
  state.shouldInvalidateAllThreadTimeline = globalFlags.timelineChanged;
}

function invalidateRealtimeEnvironmentChange({
  changeKinds,
  environmentId,
  queryClient,
}: RealtimeEnvironmentChangedArg): void {
  invalidateRealtimeEnvironmentChangeQueries({
    changeKinds,
    environmentId,
    queryClient,
  });
  if (!changeKinds.includes("thread-storage-changed")) {
    return;
  }
  for (const threadId of collectCachedThreadIdsForEnvironment({
    environmentId,
    queryClient,
  })) {
    invalidateThreadStorageQueries({ queryClient, threadId });
  }
}

export function createRealtimeCacheEffects({
  queryClient,
}: RealtimeCacheEffectsOptions): RealtimeCacheEffects {
  const threadChangeState = createThreadChangeState();
  const invalidationScheduler = createDebouncedCallbackScheduler({
    debounceMs: INVALIDATION_DEBOUNCE_MS,
    maxWaitMs: INVALIDATION_MAX_WAIT_MS,
    onFlush: () => flushThreadInvalidations(queryClient, threadChangeState),
  });
  const environmentInvalidator = createBufferedEnvironmentInvalidator({
    debounceMs: ENVIRONMENT_INVALIDATION_DEBOUNCE_MS,
    flushChangedEnvironmentIds: (changedEnvironments) => {
      for (const { changeKinds, environmentId } of changedEnvironments) {
        invalidateRealtimeEnvironmentChange({
          changeKinds,
          environmentId,
          queryClient,
        });
      }
    },
    maxWaitMs: ENVIRONMENT_INVALIDATION_MAX_WAIT_MS,
  });

  return {
    dispose: () => {
      invalidationScheduler.dispose();
      environmentInvalidator.dispose();
      resetThreadChangeState(threadChangeState);
    },
    handleChanged: (message) => {
      switch (message.entity) {
        case "thread":
          recordThreadChange(threadChangeState, message);
          if (shouldFlushThreadChangesImmediately(message.changes)) {
            invalidationScheduler.flush();
          } else {
            invalidationScheduler.schedule();
          }
          break;
        case "environment":
          if (message.id) {
            environmentInvalidator.markChanged(message.id, message.changes);
          }
          break;
        case "host":
          invalidateHostChangeDependentQueries({ queryClient });
          break;
        case "project":
          invalidateProjectListQueries({ queryClient });
          break;
        case "system":
          break;
        default:
          assertNever(message);
      }
    },
    handleConnected: ({ reconnected }) => {
      if (reconnected) {
        invalidateRealtimeQueriesAfterServerReconnect({ queryClient });
        return;
      }
      invalidateHostsAfterServerInitialConnection({ queryClient });
    },
  };
}
