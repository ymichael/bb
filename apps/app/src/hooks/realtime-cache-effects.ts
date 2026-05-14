import type { QueryClient } from "@tanstack/react-query";
import { assertNever } from "@bb/core-ui";
import {
  createDebouncedCallbackScheduler,
  type ChangedMessage,
  type EnvironmentChangeKind,
  type ThreadEventType,
  type ThreadChangeMetadata,
  type ThreadChangeKind,
  type ThreadWithRuntime,
} from "@bb/domain";
import {
  getCachedThreadLists,
  iterateThreadListCacheEntries,
} from "./queries/thread-list-cache-data";
import { allThreadQueryKeyPrefix, threadsQueryKey } from "./queries/query-keys";
import {
  invalidateRealtimeQueriesAfterServerReconnect,
  refetchErroredRealtimeQueriesOnInitialConnect,
} from "./system-cache-effects";
import { createBufferedEnvironmentInvalidator } from "./buffered-environment-invalidator";
import {
  executeRealtimeDirtyHandlers,
  REALTIME_ENVIRONMENT_CHANGE_REGISTRY,
  REALTIME_HOST_CHANGE_REGISTRY,
  REALTIME_PROJECT_CHANGE_REGISTRY,
  REALTIME_THREAD_CHANGE_REGISTRY,
  shouldFlushThreadChangesImmediately,
} from "./realtime-cache-registry";

export { shouldFlushThreadChangesImmediately } from "./realtime-cache-registry";

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

interface ThreadChangeState {
  changedThreadKinds: Map<string, Set<ThreadChangeKind>>;
  globalChangeKinds: Set<ThreadChangeKind>;
  metadataByThreadId: Map<string, ThreadChangeMetadata>;
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

function mergeEventTypes(
  current: readonly ThreadEventType[] | undefined,
  next: readonly ThreadEventType[] | undefined,
): readonly ThreadEventType[] | undefined {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return Array.from(new Set([...current, ...next]));
}

function mergeThreadChangeMetadata(
  current: ThreadChangeMetadata | undefined,
  next: ThreadChangeMetadata,
): ThreadChangeMetadata {
  const eventTypes = mergeEventTypes(current?.eventTypes, next.eventTypes);
  const hasPendingInteraction =
    next.hasPendingInteraction ?? current?.hasPendingInteraction;
  const projectId = next.projectId ?? current?.projectId;
  const metadata: ThreadChangeMetadata = {};
  if (eventTypes) {
    metadata.eventTypes = eventTypes;
  }
  if (hasPendingInteraction !== undefined) {
    metadata.hasPendingInteraction = hasPendingInteraction;
  }
  if (projectId !== undefined) {
    metadata.projectId = projectId;
  }
  return metadata;
}

function createThreadChangeState(): ThreadChangeState {
  return {
    changedThreadKinds: new Map<string, Set<ThreadChangeKind>>(),
    globalChangeKinds: new Set<ThreadChangeKind>(),
    metadataByThreadId: new Map<string, ThreadChangeMetadata>(),
  };
}

function resetThreadChangeState(state: ThreadChangeState): void {
  state.changedThreadKinds.clear();
  state.globalChangeKinds.clear();
  state.metadataByThreadId.clear();
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
  for (const changeKind of state.globalChangeKinds) {
    executeRealtimeDirtyHandlers({
      context: {
        eventTypes: undefined,
        hasPendingInteraction: undefined,
        projectId: undefined,
        queryClient,
        threadId: undefined,
      },
      handlers: REALTIME_THREAD_CHANGE_REGISTRY[changeKind].dirty,
    });
  }

  for (const [threadId, changeKinds] of state.changedThreadKinds) {
    const metadata = state.metadataByThreadId.get(threadId);
    for (const changeKind of changeKinds) {
      executeRealtimeDirtyHandlers({
        context: {
          hasPendingInteraction: metadata?.hasPendingInteraction,
          eventTypes: metadata?.eventTypes,
          projectId: metadata?.projectId,
          queryClient,
          threadId,
        },
        handlers: REALTIME_THREAD_CHANGE_REGISTRY[changeKind].dirty,
      });
    }
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
    if (message.metadata) {
      state.metadataByThreadId.set(
        message.id,
        mergeThreadChangeMetadata(
          state.metadataByThreadId.get(message.id),
          message.metadata,
        ),
      );
    }
    return;
  }

  for (const change of message.changes) {
    state.globalChangeKinds.add(change);
  }
}

function invalidateRealtimeEnvironmentChange({
  changeKinds,
  environmentId,
  queryClient,
}: RealtimeEnvironmentChangedArg): void {
  for (const changeKind of changeKinds) {
    executeRealtimeDirtyHandlers({
      context: {
        environmentId,
        getCachedThreadIdsForEnvironment: () =>
          collectCachedThreadIdsForEnvironment({ environmentId, queryClient }),
        queryClient,
      },
      handlers: REALTIME_ENVIRONMENT_CHANGE_REGISTRY[changeKind].dirty,
    });
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
          for (const changeKind of message.changes) {
            executeRealtimeDirtyHandlers({
              context: { queryClient },
              handlers: REALTIME_HOST_CHANGE_REGISTRY[changeKind].dirty,
            });
          }
          break;
        case "project":
          for (const changeKind of message.changes) {
            executeRealtimeDirtyHandlers({
              context: {
                projectId: message.id,
                queryClient,
              },
              handlers: REALTIME_PROJECT_CHANGE_REGISTRY[changeKind].dirty,
            });
          }
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
      refetchErroredRealtimeQueriesOnInitialConnect({ queryClient });
    },
  };
}
