import { describe, expect, it, vi } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { createAppQueryClient } from "@/lib/query-client";
import {
  environmentDiffFilesQueryKey,
  environmentDiffPatchQueryKey,
  hostsQueryKey,
  sidebarNavigationQueryKey,
  systemProvidersQueryKey,
  systemExecutionOptionsQueryKey,
  systemVersionQueryKey,
  terminalsQueryKey,
  threadConversationOutlineQueryKey,
  threadDefaultExecutionOptionsQueryKey,
  threadDetailBootstrapQueryKey,
  threadHostFilePreviewQueryKey,
  threadPendingInteractionsQueryKey,
  threadPromptHistoryQueryKey,
  threadQueryKey,
  threadQueuedMessagesQueryKey,
  threadSearchQueryKey,
  threadStorageLocationQueryKey,
  threadTimelineQueryKey,
} from "./queries/query-keys";
import {
  invalidateRealtimeQueriesAfterServerReconnect,
  invalidateRealtimeQueriesFetchedBeforeInitialConnect,
} from "./cache-owners/system-cache-effects";

function afterAllCachedData(): number {
  return Date.now() + 1;
}

function createCacheEffectQueryClient() {
  return createAppQueryClient({
    defaultOptions: {
      queries: {
        gcTime: Infinity,
        retry: false,
      },
    },
    showMutationErrorToasts: false,
  });
}

interface ScopedSystemExecutionOptionsKeyArgs {
  environmentId: string;
}

function scopedSystemExecutionOptionsKey({
  environmentId,
}: ScopedSystemExecutionOptionsKeyArgs) {
  return systemExecutionOptionsQueryKey({
    environmentId,
    hostId: null,
    providerId: "codex",
  });
}

const EMPTY_EXECUTION_OPTIONS = {
  providers: [],
  models: [],
  selectedOnlyModels: [],
  modelLoadError: null,
};

interface ObservedQuery {
  queryFn: ReturnType<typeof vi.fn<() => Promise<string>>>;
  unsubscribe: () => void;
}

function observeIdleQuery(
  queryClient: QueryClient,
  queryKey: QueryKey,
): ObservedQuery {
  const queryFn = vi.fn<() => Promise<string>>().mockResolvedValue("loaded");
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  return {
    queryFn,
    unsubscribe: observer.subscribe(() => {}),
  };
}

async function waitForQueryCalls(
  queries: readonly ObservedQuery[],
  expectedCallCount: number,
): Promise<void> {
  await vi.waitFor(() => {
    for (const query of queries) {
      expect(query.queryFn).toHaveBeenCalledTimes(expectedCallCount);
    }
  });
}

describe("system cache effects", () => {
  it("invalidates canonical active thread caches after reconnect", () => {
    const queryClient = createCacheEffectQueryClient();
    const threadKey = threadQueryKey("thread-1");
    const threadBootstrapKey = threadDetailBootstrapQueryKey("thread-1");
    const timelineKey = threadTimelineQueryKey("thread-1");
    const conversationOutlineKey =
      threadConversationOutlineQueryKey("thread-1");
    const queuedMessagesKey = threadQueuedMessagesQueryKey("thread-1");
    const promptHistoryKey = threadPromptHistoryQueryKey("thread-1");
    const pendingInteractionsKey =
      threadPendingInteractionsQueryKey("thread-1");
    const threadSearchKey = threadSearchQueryKey({
      limitPerGroup: 20,
      query: "needle",
    });
    const defaultExecutionOptionsKey =
      threadDefaultExecutionOptionsQueryKey("thread-1");
    const threadHostFilePreviewKey = threadHostFilePreviewQueryKey(
      "thread-1",
      "env-1",
      "/tmp/log.txt",
    );
    const executionOptionsKey = scopedSystemExecutionOptionsKey({
      environmentId: "env-1",
    });
    const terminalsKey = terminalsQueryKey({
      kind: "thread",
      threadId: "thread-1",
    });
    const sidebarNavigationKey = sidebarNavigationQueryKey();
    queryClient.setQueryData(threadKey, { id: "thread-1" });
    queryClient.setQueryData(threadBootstrapKey, { id: "thread-1" });
    queryClient.setQueryData(timelineKey, { rows: [] });
    queryClient.setQueryData(conversationOutlineKey, { items: [] });
    queryClient.setQueryData(queuedMessagesKey, []);
    queryClient.setQueryData(promptHistoryKey, []);
    queryClient.setQueryData(pendingInteractionsKey, []);
    queryClient.setQueryData(threadSearchKey, {
      active: { results: [], total: 0 },
      archived: { results: [], total: 0 },
    });
    queryClient.setQueryData(
      defaultExecutionOptionsKey,
      EMPTY_EXECUTION_OPTIONS,
    );
    queryClient.setQueryData(threadHostFilePreviewKey, {
      kind: "text",
      path: "/tmp/log.txt",
      url: "/api/v1/threads/thread-1/host-files/content?path=%2Ftmp%2Flog.txt",
      mimeType: "text/plain",
      content: "old",
    });
    queryClient.setQueryData(executionOptionsKey, EMPTY_EXECUTION_OPTIONS);
    queryClient.setQueryData(terminalsKey, { sessions: [] });
    queryClient.setQueryData(sidebarNavigationKey, {
      projects: [],
      personalProject: { threads: [] },
    });

    invalidateRealtimeQueriesAfterServerReconnect({
      disconnectedAt: afterAllCachedData(),
      queryClient,
    });

    expect(queryClient.getQueryState(threadKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(threadBootstrapKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(timelineKey)?.isInvalidated).toBe(true);
    expect(
      queryClient.getQueryState(conversationOutlineKey)?.isInvalidated,
    ).toBe(true);
    expect(queryClient.getQueryState(queuedMessagesKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(promptHistoryKey)?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryState(pendingInteractionsKey)?.isInvalidated,
    ).toBe(true);
    expect(queryClient.getQueryState(threadSearchKey)?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryState(defaultExecutionOptionsKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(threadHostFilePreviewKey)?.isInvalidated,
    ).toBe(true);
    expect(queryClient.getQueryState(executionOptionsKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(terminalsKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(sidebarNavigationKey)?.isInvalidated).toBe(
      true,
    );
  });

  it("re-checks the app version after reconnect", () => {
    const queryClient = createCacheEffectQueryClient();
    const versionKey = systemVersionQueryKey();
    queryClient.setQueryData(versionKey, {
      currentVersion: "0.0.5",
      latestVersion: "0.0.6",
      source: "npm",
      updateAvailable: true,
      isDevelopment: false,
      upgradeCommand: "npx bb-app@latest",
    });

    invalidateRealtimeQueriesAfterServerReconnect({
      disconnectedAt: afterAllCachedData(),
      queryClient,
    });

    expect(queryClient.getQueryState(versionKey)?.isInvalidated).toBe(true);
  });

  it("refetches active thread bundle queries together after reconnect", async () => {
    const queryClient = createCacheEffectQueryClient();
    queryClient.mount();
    const activeThreadQueries = [
      observeIdleQuery(queryClient, threadQueryKey("thread-1")),
      observeIdleQuery(queryClient, threadDetailBootstrapQueryKey("thread-1")),
      observeIdleQuery(
        queryClient,
        threadDefaultExecutionOptionsQueryKey("thread-1"),
      ),
      observeIdleQuery(queryClient, threadQueuedMessagesQueryKey("thread-1")),
      observeIdleQuery(queryClient, threadPromptHistoryQueryKey("thread-1")),
      observeIdleQuery(
        queryClient,
        threadPendingInteractionsQueryKey("thread-1"),
      ),
      observeIdleQuery(queryClient, threadTimelineQueryKey("thread-1")),
      observeIdleQuery(
        queryClient,
        threadConversationOutlineQueryKey("thread-1"),
      ),
    ];

    await waitForQueryCalls(activeThreadQueries, 1);

    invalidateRealtimeQueriesAfterServerReconnect({
      disconnectedAt: afterAllCachedData(),
      queryClient,
    });

    await waitForQueryCalls(activeThreadQueries, 2);

    for (const query of activeThreadQueries) {
      query.unsubscribe();
    }
    queryClient.unmount();
    queryClient.clear();
  });

  it("leaves queries fetched after the disconnect watermark alone and keeps in-flight fetches", async () => {
    const queryClient = createCacheEffectQueryClient();
    queryClient.mount();
    const disconnectedAt = Date.now();
    const staleKey = threadQueryKey("thread-stale");
    const freshKey = threadQueryKey("thread-fresh");
    const inFlightKey = threadTimelineQueryKey("thread-in-flight");
    queryClient.setQueryData(
      staleKey,
      { id: "thread-stale" },
      { updatedAt: disconnectedAt - 500 },
    );
    queryClient.setQueryData(
      freshKey,
      { id: "thread-fresh" },
      { updatedAt: disconnectedAt + 500 },
    );

    let resolveInFlight: ((value: string) => void) | undefined;
    const inFlightQueryFn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveInFlight = resolve;
        }),
    );
    const inFlightObserver = new QueryObserver(queryClient, {
      queryKey: inFlightKey,
      queryFn: inFlightQueryFn,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
    });
    const unsubscribeInFlight = inFlightObserver.subscribe(() => {});
    await vi.waitFor(() =>
      expect(inFlightObserver.getCurrentResult().fetchStatus).toBe("fetching"),
    );

    invalidateRealtimeQueriesAfterServerReconnect({
      disconnectedAt,
      queryClient,
    });

    expect(queryClient.getQueryState(staleKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(freshKey)?.isInvalidated).toBe(false);
    expect(inFlightQueryFn).toHaveBeenCalledTimes(1);
    resolveInFlight?.("loaded");
    await vi.waitFor(() =>
      expect(inFlightObserver.getCurrentResult().data).toBe("loaded"),
    );
    expect(inFlightQueryFn).toHaveBeenCalledTimes(1);

    unsubscribeInFlight();
    queryClient.unmount();
    queryClient.clear();
  });

  it("recovers a failed active thread-storage location query after reconnect", async () => {
    const queryClient = createCacheEffectQueryClient();
    queryClient.mount();
    const erroredKey = threadStorageLocationQueryKey("thread-1");
    const queryFn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("server restarting"))
      .mockResolvedValue("loaded");
    const observer = new QueryObserver(queryClient, {
      queryKey: erroredKey,
      queryFn,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().isError).toBe(true),
    );
    expect(queryClient.getQueryState(erroredKey)?.dataUpdatedAt).toBe(0);

    invalidateRealtimeQueriesAfterServerReconnect({
      disconnectedAt: Date.now(),
      queryClient,
    });

    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data).toBe("loaded"),
    );
    expect(queryFn).toHaveBeenCalledTimes(2);

    unsubscribe();
    queryClient.unmount();
    queryClient.clear();
  });

  it("invalidates realtime queries whose data predates the initial connect", () => {
    const queryClient = createCacheEffectQueryClient();
    const hostsKey = hostsQueryKey();
    const providersKey = systemProvidersQueryKey();
    const neverFetchedKey = sidebarNavigationQueryKey();
    const connectedAt = Date.now();
    queryClient.setQueryData(hostsKey, [], { updatedAt: connectedAt - 500 });
    queryClient.setQueryData(
      providersKey,
      { providers: [] },
      { updatedAt: connectedAt + 500 },
    );

    invalidateRealtimeQueriesFetchedBeforeInitialConnect({
      connectedAt,
      queryClient,
    });

    expect(queryClient.getQueryState(hostsKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(providersKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(neverFetchedKey)).toBeUndefined();
  });

  it("refetches an active diff TOC query but evicts the observer-less patch cache after reconnect", async () => {
    const queryClient = createCacheEffectQueryClient();
    const diffFilesKey = environmentDiffFilesQueryKey("env-1", "all", "main");
    const diffPatchKey = environmentDiffPatchQueryKey(
      "env-1",
      "all",
      "main",
      "file.ts",
    );
    queryClient.setQueryData(diffFilesKey, {
      outcome: "available",
      files: [],
      shortstat: "1 file changed",
      mergeBaseRef: "base-ref",
    });
    queryClient.setQueryData(diffPatchKey, {
      path: "file.ts",
      patch: "diff --git a/file.ts b/file.ts\n",
      truncated: false,
    });
    const diffFilesQueryFn = vi.fn(async () => ({
      outcome: "available" as const,
      files: [],
      shortstat: "",
      mergeBaseRef: "base-ref",
    }));
    const diffFilesObserver = new QueryObserver(queryClient, {
      queryKey: diffFilesKey,
      queryFn: diffFilesQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeDiffFiles = diffFilesObserver.subscribe(() => {});
    diffFilesQueryFn.mockClear();

    invalidateRealtimeQueriesAfterServerReconnect({
      disconnectedAt: afterAllCachedData(),
      queryClient,
    });

    await vi.waitFor(() => expect(diffFilesQueryFn).toHaveBeenCalledTimes(1));
    expect(queryClient.getQueryData(diffPatchKey)).toBeUndefined();

    unsubscribeDiffFiles();
  });
});
