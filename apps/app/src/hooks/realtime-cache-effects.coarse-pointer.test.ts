import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import { threadTimelineQueryKey } from "./queries/query-keys";

describe("createRealtimeCacheEffects on coarse pointers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("widens the thread invalidation debounce on coarse pointers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      location: { origin: "http://localhost" },
      matchMedia: (query: string) => ({
        matches: query === "(pointer: coarse)",
      }),
    });
    vi.resetModules();
    try {
      const coarseModule = await import("./realtime-cache-effects");
      const queryClient = createAppQueryClient({
        defaultOptions: {
          queries: {
            gcTime: Infinity,
            retry: false,
          },
        },
        showMutationErrorToasts: false,
      });
      const effects = coarseModule.createRealtimeCacheEffects({ queryClient });
      const timelineKey = threadTimelineQueryKey("thr_1");
      queryClient.setQueryData(timelineKey, { rows: [] });

      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thr_1",
        metadata: {
          eventTypes: ["item/agentMessage/delta"],
          projectId: "project-1",
        },
        changes: ["events-appended"],
      });

      vi.advanceTimersByTime(50);
      expect(queryClient.getQueryState(timelineKey)?.isInvalidated).not.toBe(
        true,
      );
      vi.advanceTimersByTime(100);
      expect(queryClient.getQueryState(timelineKey)?.isInvalidated).toBe(true);

      effects.dispose();
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
