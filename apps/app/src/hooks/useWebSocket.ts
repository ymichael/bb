import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  assertNever,
  type ThreadChangeKind,
  type ThreadEvent,
} from "@beanbag/agent-core";
import { wsManager } from "../lib/ws";
import { getThreadEvents } from "../lib/api";

const INVALIDATION_DEBOUNCE_MS = 250;
const INVALIDATION_MAX_WAIT_MS = 1500;
const TIMELINE_EVENT_REFETCH_INTERVAL_MS = 1500;

interface ThreadChangeFlags {
  listChanged: boolean;
  threadChanged: boolean;
  timelineChanged: boolean;
  workStatusChanged: boolean;
  eventsAppended: boolean;
  statusChanged: boolean;
}

function toThreadChangeFlags(changes: readonly ThreadChangeKind[]): ThreadChangeFlags {
  const flags: ThreadChangeFlags = {
    listChanged: false,
    threadChanged: false,
    timelineChanged: false,
    workStatusChanged: false,
    eventsAppended: false,
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
        flags.threadChanged = true;
        break;
      case "status-changed":
        flags.listChanged = true;
        flags.threadChanged = true;
        flags.timelineChanged = true;
        flags.workStatusChanged = true;
        flags.statusChanged = true;
        break;
      case "work-status-changed":
        flags.workStatusChanged = true;
        break;
      case "events-appended":
        // Provider events (for example compaction) can update thread metadata
        // without emitting a dedicated thread change kind. Keep thread detail
        // metadata fresh when new events arrive.
        flags.threadChanged = true;
        flags.eventsAppended = true;
        flags.timelineChanged = true;
        break;
      default:
        assertNever(change);
    }
  }

  return flags;
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
    let shouldInvalidateAllThreadEvents = false;
    let shouldInvalidateAllThreadTimeline = false;
    let shouldInvalidateAllThreadsById = false;
    let shouldInvalidateAllThreadWorkStatus = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

    const appendThreadEventDelta = async (threadId: string) => {
      const queryKey = ["threadEvents", threadId] as const;
      const cachedEvents = queryClient.getQueryData<ThreadEvent[]>(queryKey);

      if (!cachedEvents || cachedEvents.length === 0) {
        queryClient.invalidateQueries({ queryKey });
        return;
      }

      const afterSeq = cachedEvents[cachedEvents.length - 1]?.seq;
      if (typeof afterSeq !== "number" || !Number.isFinite(afterSeq)) {
        queryClient.invalidateQueries({ queryKey });
        return;
      }

      try {
        const delta = await getThreadEvents(threadId, afterSeq);
        if (delta.length === 0) return;

        queryClient.setQueryData<ThreadEvent[]>(queryKey, (prev) => {
          const existing = prev ?? [];
          let lastSeq = existing.length > 0 ? existing[existing.length - 1].seq : -1;

          const next = [...existing];
          for (const event of delta) {
            if (event.seq > lastSeq) {
              next.push(event);
              lastSeq = event.seq;
            }
          }
          return next;
        });
      } catch {
        // Fall back to a full refetch on transient network/server failures.
        queryClient.invalidateQueries({ queryKey });
      }
    };

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
      if (shouldInvalidateAllThreadWorkStatus) {
        queryClient.invalidateQueries({ queryKey: ["threadWorkStatus"] });
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
        if (flags.workStatusChanged) {
          queryClient.invalidateQueries({ queryKey: ["threadWorkStatus", id] });
        }
        if (flags.timelineChanged) {
          if (flags.statusChanged) {
            queryClient.invalidateQueries({ queryKey: ["threadTimeline", id] });
            lastTimelineRefetchAtByThread.set(id, now);
          } else {
            const lastRefetchAt = lastTimelineRefetchAtByThread.get(id) ?? 0;
            if (now - lastRefetchAt >= TIMELINE_EVENT_REFETCH_INTERVAL_MS) {
              queryClient.invalidateQueries({ queryKey: ["threadTimeline", id] });
              lastTimelineRefetchAtByThread.set(id, now);
            }
          }
        }
      }

      if (shouldInvalidateAllThreadEvents) {
        queryClient.invalidateQueries({ queryKey: ["threadEvents"] });
      } else if (changedIds.length > 0) {
        const eventDeltaIds = changedIds.filter((id) => {
          const changeKinds = changedThreadKinds.get(id);
          if (!changeKinds) return false;
          return toThreadChangeFlags(Array.from(changeKinds)).eventsAppended;
        });
        if (eventDeltaIds.length > 0) {
          void Promise.all(eventDeltaIds.map((id) => appendThreadEventDelta(id)));
        }
      }

      if (shouldInvalidateStatus) {
        queryClient.invalidateQueries({ queryKey: ["status"] });
      }

      changedThreadKinds.clear();
      globalChangeKinds.clear();
      shouldInvalidateThreads = false;
      shouldInvalidateStatus = false;
      shouldInvalidateAllThreadEvents = false;
      shouldInvalidateAllThreadTimeline = false;
      shouldInvalidateAllThreadsById = false;
      shouldInvalidateAllThreadWorkStatus = false;
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

    // Subscribe to thread changes.
    wsManager.subscribe("thread");

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
            shouldInvalidateAllThreadWorkStatus = globalFlags.workStatusChanged;
            shouldInvalidateAllThreadTimeline = globalFlags.timelineChanged;
            shouldInvalidateAllThreadEvents = globalFlags.eventsAppended;
          }
          scheduleInvalidations();
          break;
        default:
          assertNever(message.entity);
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
      wsManager.disconnect();
    };
  }, [queryClient]);
}
