import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { assertNever, type ThreadEvent } from "@beanbag/core";
import { wsManager } from "../lib/ws";
import { getThreadEvents } from "../lib/api";

const INVALIDATION_DEBOUNCE_MS = 250;
const INVALIDATION_MAX_WAIT_MS = 1500;

export function useWebSocket(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const changedThreadIds = new Set<string>();
    let shouldInvalidateThreads = false;
    let shouldInvalidateStatus = false;
    let shouldInvalidateAllThreadEvents = false;
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
        // Keep all per-thread detail caches aligned with the threads list,
        // even when the changed event does not include a specific thread id.
        queryClient.invalidateQueries({ queryKey: ["thread"] });
      }

      const changedIds = Array.from(changedThreadIds);
      for (const id of changedIds) {
        queryClient.invalidateQueries({ queryKey: ["thread", id] });
      }

      if (shouldInvalidateAllThreadEvents) {
        queryClient.invalidateQueries({ queryKey: ["threadEvents"] });
      } else if (changedIds.length > 0) {
        void Promise.all(changedIds.map((id) => appendThreadEventDelta(id)));
      }

      if (shouldInvalidateStatus) {
        queryClient.invalidateQueries({ queryKey: ["status"] });
      }

      changedThreadIds.clear();
      shouldInvalidateThreads = false;
      shouldInvalidateStatus = false;
      shouldInvalidateAllThreadEvents = false;
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
    const unsubscribe = wsManager.onChanged((entity, id) => {
      switch (entity) {
        case "thread":
          shouldInvalidateThreads = true;
          if (id) {
            changedThreadIds.add(id);
          } else {
            shouldInvalidateAllThreadEvents = true;
          }
          // Also invalidate system status since thread counts may change
          shouldInvalidateStatus = true;
          scheduleInvalidations();
          break;
        default:
          assertNever(entity);
      }
    });

    return () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }
      if (maxWaitTimer !== null) {
        clearTimeout(maxWaitTimer);
      }
      unsubscribe();
      wsManager.unsubscribe("thread");
      wsManager.disconnect();
    };
  }, [queryClient]);
}
