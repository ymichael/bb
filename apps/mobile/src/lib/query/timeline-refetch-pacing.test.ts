import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadTimelineQueryKey } from "./query-keys";
import {
  disposeTrailingActiveRefetches,
  invalidateTimelineQueryKeyPaced,
  invalidateTimelineQueryKeyTerminal,
  resolveTrailingRefetchDelayMs,
} from "./timeline-refetch-pacing";

interface Deferred {
  resolve: (value: number) => void;
  reject: (error: Error) => void;
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const queryKey = threadTimelineQueryKey("t1");
  const fetches: Deferred[] = [];
  let nextValue = 0;
  const queryFn = vi.fn(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise<number>((resolve, reject) => {
        const deferred: Deferred = {
          resolve: () => resolve(++nextValue),
          reject,
        };
        signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
        fetches.push(deferred);
      }),
  );
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn,
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => {});
  return { queryClient, queryKey, fetches, queryFn, unsubscribe };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("resolveTrailingRefetchDelayMs", () => {
  it("floors fast fetches and caps slow ones", () => {
    expect(resolveTrailingRefetchDelayMs(0)).toBe(50);
    expect(resolveTrailingRefetchDelayMs(300)).toBe(300);
    expect(resolveTrailingRefetchDelayMs(5_000)).toBe(1_000);
  });
});

describe("invalidateTimelineQueryKeyPaced", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the in-flight read and refetches once after it settles", async () => {
    const { queryClient, queryKey, fetches, queryFn, unsubscribe } = setup();
    await flushMicrotasks();
    expect(fetches).toHaveLength(1);

    invalidateTimelineQueryKeyPaced(queryClient, queryKey);
    invalidateTimelineQueryKeyPaced(queryClient, queryKey);
    invalidateTimelineQueryKeyPaced(queryClient, queryKey);
    await flushMicrotasks();
    expect(fetches).toHaveLength(1);
    expect(queryFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(120);
    fetches[0]!.resolve(1);
    await flushMicrotasks();
    expect(queryFn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(119);
    await flushMicrotasks();
    expect(queryFn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(fetches).toHaveLength(2);

    fetches[1]!.resolve(2);
    await flushMicrotasks();
    vi.advanceTimersByTime(2_000);
    await flushMicrotasks();
    expect(queryFn).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("refetches immediately when no read is in flight", async () => {
    const { queryClient, queryKey, fetches, queryFn, unsubscribe } = setup();
    await flushMicrotasks();
    fetches[0]!.resolve(1);
    await flushMicrotasks();
    expect(queryFn).toHaveBeenCalledTimes(1);

    invalidateTimelineQueryKeyPaced(queryClient, queryKey);
    await flushMicrotasks();
    expect(queryFn).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("terminal invalidation cancels the stale read and drops the trailing refetch", async () => {
    const { queryClient, queryKey, fetches, queryFn, unsubscribe } = setup();
    await flushMicrotasks();
    invalidateTimelineQueryKeyPaced(queryClient, queryKey);
    await flushMicrotasks();

    invalidateTimelineQueryKeyTerminal(queryClient, queryKey);
    await flushMicrotasks();
    expect(queryFn).toHaveBeenCalledTimes(2);
    fetches[1]!.resolve(2);
    await flushMicrotasks();
    vi.advanceTimersByTime(2_000);
    await flushMicrotasks();
    expect(queryFn).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("dispose cancels a pending trailing refetch", async () => {
    const { queryClient, queryKey, fetches, queryFn, unsubscribe } = setup();
    await flushMicrotasks();
    invalidateTimelineQueryKeyPaced(queryClient, queryKey);
    fetches[0]!.resolve(1);
    await flushMicrotasks();
    disposeTrailingActiveRefetches(queryClient);
    vi.advanceTimersByTime(2_000);
    await flushMicrotasks();
    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
