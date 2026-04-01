import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  assertNever,
} from "@bb/core-ui";
import type { Thread } from "@bb/domain";
import type { ThreadChangeKind } from "@bb/domain";
import { wsManager } from "../lib/ws";
import { getEnvironmentStateInvalidationQueryKeys } from "./useApi";

const INVALIDATION_DEBOUNCE_MS = 250;
// Keep realtime thread updates responsive while still coalescing bursts.
const INVALIDATION_MAX_WAIT_MS = 500;
const TIMELINE_EVENT_REFETCH_INTERVAL_MS = 500;

interface ThreadChangeFlags {
  listChanged: boolean;
  queueChanged: boolean;
  threadChanged: boolean;
  timelineChanged: boolean;
  statusChanged: boolean;
}

function toThreadChangeFlags(changes: readonly ThreadChangeKind[]): ThreadChangeFlags {
  const flags: ThreadChangeFlags = {
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
      case "status-changed":
        flags.listChanged = true;
        flags.threadChanged = true;
        flags.timelineChanged = true;
        flags.statusChanged = true;
        break;
      case "events-appended":
        // Provider events (for example compaction) can update thread metadata
        // without emitting a dedicated thread change kind. Keep thread detail
        // metadata fresh when new events arrive.
        flags.threadChanged = true;
        flags.timelineChanged = true;
        break;
      default:
        assertNever(change);
    }
  }

  return flags;
}

function shouldBypassTimelineEventThrottle(
  status: Thread["status"] | undefined,
): boolean {
  if (!status) return false;
  switch (status) {
    case "created":
    case "provisioning":
    case "error":
      return true;
    case "active":
    case "idle":
      return false;
    default:
      return assertNever(status);
  }
}

export function shouldFlushThreadChangesImmediately(
  changes: readonly ThreadChangeKind[],
): boolean {
  return toThreadChangeFlags(changes).statusChanged;
}

export function useWebSocket(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unsubscribeConnected = wsManager.onConnected(({ reconnected }) => {
      if (reconnected) {
        queryClient.invalidateQueries();
      }
    });

    const changedThreadKinds = new Map<string, Set<ThreadChangeKind>>();
    const globalChangeKinds = new Set<ThreadChangeKind>();
    const lastTimelineRefetchAtByThread = new Map<string, number>();
    let shouldInvalidateThreads = false;
    let shouldInvalidateStatus = false;
    let shouldInvalidateAllThreadDrafts = false;
    let shouldInvalidateAllThreadTimeline = false;
    let shouldInvalidateAllThreadsById = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

    const mergeThreadChanges = (threadId: string, changes: readonly ThreadChangeKind[]) => {
      let entry = changedThreadKinds.get(threadId);
      if (!entry) {
        entry = new Set<ThreadChangeKind>();
        changedThreadKinds.set(threadId, entry);
      }
      for (const change of changes) {
        entry.add(change);
      }
    };

    const flushInvalidations = () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }

      if (maxWaitTimer !== null) {
        clearTimeout(maxWaitTimer);
        maxWaitTimer = null;
      }

      if (shouldInvalidateThreads) {
        queryClient.invalidateQueries({ queryKey: ["threads"] });
      }

      if (shouldInvalidateAllThreadsById) {
        queryClient.invalidateQueries({ queryKey: ["thread"] });
      }
      if (shouldInvalidateAllThreadDrafts) {
        queryClient.invalidateQueries({ queryKey: ["threadDrafts"] });
      }
      if (shouldInvalidateAllThreadTimeline) {
        queryClient.invalidateQueries({ queryKey: ["threadTimeline"] });
      }

      const now = Date.now();
      const changedIds = Array.from(changedThreadKinds.keys());
      for (const id of changedIds) {
        const changeKinds = changedThreadKinds.get(id);
        if (!changeKinds) continue;
        const flags = toThreadChangeFlags(Array.from(changeKinds));

        if (flags.threadChanged) {
          queryClient.invalidateQueries({ queryKey: ["thread", id] });
        }
        if (flags.queueChanged) {
          queryClient.invalidateQueries({ queryKey: ["threadDrafts", id] });
        }
        if (flags.timelineChanged) {
          if (flags.statusChanged) {
            queryClient.invalidateQueries({ queryKey: ["threadTimeline", id] });
            lastTimelineRefetchAtByThread.set(id, now);
          } else {
            const lastRefetchAt = lastTimelineRefetchAtByThread.get(id) ?? 0;
            const cachedThread = queryClient.getQueryData<Thread>(["thread", id]);
            if (
              shouldBypassTimelineEventThrottle(cachedThread?.status) ||
              now - lastRefetchAt >= TIMELINE_EVENT_REFETCH_INTERVAL_MS
            ) {
              queryClient.invalidateQueries({ queryKey: ["threadTimeline", id] });
              lastTimelineRefetchAtByThread.set(id, now);
            }
          }
        }
      }

      if (shouldInvalidateStatus) {
        queryClient.invalidateQueries({ queryKey: ["status"] });
      }

      changedThreadKinds.clear();
      globalChangeKinds.clear();
      shouldInvalidateThreads = false;
      shouldInvalidateStatus = false;
      shouldInvalidateAllThreadDrafts = false;
      shouldInvalidateAllThreadTimeline = false;
      shouldInvalidateAllThreadsById = false;
    };

    const scheduleInvalidations = () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(flushInvalidations, INVALIDATION_DEBOUNCE_MS);

      if (maxWaitTimer === null) {
        maxWaitTimer = setTimeout(flushInvalidations, INVALIDATION_MAX_WAIT_MS);
      }
    };

    // Connect to WebSocket
    wsManager.connect();

    wsManager.subscribe("thread");
    wsManager.subscribe("project");
    wsManager.subscribe("environment");
    wsManager.subscribe("host");
    wsManager.subscribe("system");

    // Invalidate React Query caches on changes
    const unsubscribe = wsManager.onChanged((message) => {
      switch (message.entity) {
        case "thread":
          if (message.id) {
            mergeThreadChanges(message.id, message.changes);
            const flags = toThreadChangeFlags(message.changes);
            if (flags.listChanged) {
              shouldInvalidateThreads = true;
              shouldInvalidateStatus = true;
            }
          } else {
            for (const change of message.changes) {
              globalChangeKinds.add(change);
            }
            const globalFlags = toThreadChangeFlags(Array.from(globalChangeKinds));
            if (globalFlags.listChanged) {
              shouldInvalidateThreads = true;
              shouldInvalidateStatus = true;
            }
            shouldInvalidateAllThreadsById = globalFlags.threadChanged;
            shouldInvalidateAllThreadDrafts = globalFlags.queueChanged;
            shouldInvalidateAllThreadTimeline = globalFlags.timelineChanged;
          }
          if (shouldFlushThreadChangesImmediately(message.changes)) {
            flushInvalidations();
          } else {
            scheduleInvalidations();
          }
          break;
        case "environment":
          if (message.id) {
            for (const queryKey of getEnvironmentStateInvalidationQueryKeys({
              environmentId: message.id,
            })) {
              queryClient.invalidateQueries({ queryKey });
            }
          }
          break;
        case "host":
          queryClient.invalidateQueries({ queryKey: ["hosts"] });
          break;
        case "project":
          queryClient.invalidateQueries({ queryKey: ["projects"] });
          break;
        case "system":
          break;
        default:
          assertNever(message);
      }
    });

    return () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }
      if (maxWaitTimer !== null) {
        clearTimeout(maxWaitTimer);
      }
      unsubscribeConnected();
      unsubscribe();
      wsManager.unsubscribe("thread");
      wsManager.unsubscribe("project");
      wsManager.unsubscribe("environment");
      wsManager.unsubscribe("host");
      wsManager.unsubscribe("system");
      wsManager.disconnect();
    };
  }, [queryClient]);
}

export function useServerConnectionState() {
  return useSyncExternalStore(
    (callback) => wsManager.onConnectionStateChange(callback),
    () => wsManager.getConnectionState(),
    () => wsManager.getConnectionState(),
  )
}
