// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { PendingInteraction, Thread, ThreadListEntry } from "@bb/domain";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils";
import {
  availableModelsQueryKey,
  cloudAuthSettingsQueryKey,
  environmentGitDiffQueryKey,
  environmentMergeBaseBranchesQueryKey,
  environmentPromotionQueryKey,
  environmentQueryKey,
  environmentWorkStatusQueryKey,
  githubReposQueryKey,
  hostQueryKey,
  hostsQueryKey,
  localPathExistenceQueryKey,
  projectFilesQueryKey,
  projectSourceWorkspaceStatusQueryKey,
  projectsQueryKey,
  replayCapturesQueryKey,
  sandboxBackendsQueryKey,
  sandboxEnvVarsQueryKey,
  statusQueryKey,
  systemProvidersQueryKey,
  threadDefaultExecutionOptionsQueryKey,
  threadDraftsQueryKey,
  threadListQueryKey,
  threadPendingInteractionsQueryKey,
  threadQueryKey,
  threadStorageFilePreviewQueryKey,
  threadTimelineQueryKey,
  threadStorageFilesQueryKey,
  threadsQueryKey,
} from "./queries/query-keys";
import {
  shouldFlushThreadChangesImmediately,
  useWebSocket,
} from "./useWebSocket";
import { useProjects } from "./queries/project-queries";

interface ConnectedEvent {
  reconnected: boolean;
}

type WebSocketConnectionState = "connecting" | "connected" | "reconnecting";

interface ChangedMessage {
  changes: string[];
  entity: "host" | "thread" | "project" | "environment" | "system";
  id?: string;
  type: "changed";
}

type ChangedCallback = (message: ChangedMessage) => void;
type ConnectedCallback = (event: ConnectedEvent) => void;
type ConnectionStateCallback = () => void;

const {
  changedCallbacks,
  connectedCallbacks,
  connectionStateCallbacks,
  connect,
  disconnect,
  getConnectionState,
  subscribe,
  unsubscribe,
} = vi.hoisted(() => {
  const changedCallbacks: ChangedCallback[] = [];
  const connectedCallbacks: ConnectedCallback[] = [];
  const connectionStateCallbacks: ConnectionStateCallback[] = [];

  return {
    changedCallbacks,
    connectedCallbacks,
    connectionStateCallbacks,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getConnectionState: vi.fn((): WebSocketConnectionState => "connected"),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };
});

vi.mock("../lib/ws", () => ({
  wsManager: {
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    getConnectionState,
    onChanged(callback: ChangedCallback) {
      changedCallbacks.push(callback);
      return () => {
        const index = changedCallbacks.indexOf(callback);
        if (index >= 0) {
          changedCallbacks.splice(index, 1);
        }
      };
    },
    onConnected(callback: ConnectedCallback) {
      connectedCallbacks.push(callback);
      return () => {
        const index = connectedCallbacks.indexOf(callback);
        if (index >= 0) {
          connectedCallbacks.splice(index, 1);
        }
      };
    },
    onConnectionStateChange(callback: ConnectionStateCallback) {
      connectionStateCallbacks.push(callback);
      return () => {
        const index = connectionStateCallbacks.indexOf(callback);
        if (index >= 0) {
          connectionStateCallbacks.splice(index, 1);
        }
      };
    },
  },
}));

afterEach(() => {
  changedCallbacks.length = 0;
  connectedCallbacks.length = 0;
  connectionStateCallbacks.length = 0;
  vi.useRealTimers();
  vi.clearAllMocks();
});

interface CreateThreadArgs {
  environmentId: string | null;
  id: string;
}

interface CreateThreadListEntryArgs extends CreateThreadArgs {
  hasPendingInteraction?: boolean;
}

interface QueryStateArgs {
  queryClient: QueryClient;
  queryKey: QueryKey;
}

interface QueryListStateArgs {
  queryClient: QueryClient;
  queryKeys: readonly QueryKey[];
}

function createThread(args: CreateThreadArgs): Thread {
  return {
    id: args.id,
    projectId: "proj-1",
    environmentId: args.environmentId,
    providerId: "codex",
    type: "manager",
    title: "Manager",
    titleFallback: "Manager",
    status: "idle",
    automationId: null,
    parentThreadId: null,
    archivedAt: null,
    stopRequestedAt: null,
    deletedAt: null,
    lastReadAt: null,
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createThreadListEntry(
  args: CreateThreadListEntryArgs,
): ThreadListEntry {
  return {
    ...createThread(args),
    environmentBranchName: null,
    environmentHostId: null,
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: args.hasPendingInteraction ?? false,
    runtime: {
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    },
  };
}

function activeThreadListQueryKey() {
  return threadListQueryKey({ projectId: "proj-1", archived: false });
}

function createPendingInteraction(threadId: string): PendingInteraction {
  return {
    id: "pi-1",
    threadId,
    turnId: "turn-1",
    providerId: "codex",
    providerThreadId: "provider-thread-1",
    providerRequestId: "provider-request-1",
    status: "pending",
    payload: {
      subject: {
        kind: "permission_grant",
        itemId: "item-1",
        toolName: "WebFetch",
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
      },
      reason: "Need network access",
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    },
    resolution: null,
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
  };
}

function cacheQuery({ queryClient, queryKey }: QueryStateArgs): void {
  queryClient.setQueryData(queryKey, { cached: true });
}

function cacheQueries({ queryClient, queryKeys }: QueryListStateArgs): void {
  for (const queryKey of queryKeys) {
    cacheQuery({ queryClient, queryKey });
  }
}

function expectQueryInvalidated({
  queryClient,
  queryKey,
}: QueryStateArgs): void {
  expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
}

function expectQueryNotInvalidated({
  queryClient,
  queryKey,
}: QueryStateArgs): void {
  expect(queryClient.getQueryState(queryKey)?.isInvalidated).not.toBe(true);
}

describe("shouldFlushThreadChangesImmediately", () => {
  it("flushes status changes immediately", () => {
    expect(
      shouldFlushThreadChangesImmediately([
        "events-appended",
        "status-changed",
      ]),
    ).toBe(true);
  });

  it("does not fast-flush pure timeline appends", () => {
    expect(shouldFlushThreadChangesImmediately(["events-appended"])).toBe(
      false,
    );
  });
});

describe("useWebSocket", () => {
  it("invalidates host-dependent queries when host status changes", () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const queryKeys = [
      hostsQueryKey(),
      hostQueryKey("host-1"),
      projectsQueryKey(),
      systemProvidersQueryKey(),
      availableModelsQueryKey("provider-1", "model-1"),
    ];
    cacheQueries({ queryClient, queryKeys });

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["host-connected"],
        entity: "host",
        type: "changed",
      });
    });

    for (const queryKey of queryKeys) {
      expectQueryInvalidated({ queryClient, queryKey });
    }
  });

  it("invalidates only host availability on initial connection", () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const hostQueryKeys = [hostsQueryKey(), hostQueryKey("host-1")];
    const unrelatedQueryKeys = [
      threadsQueryKey(),
      threadQueryKey("thread-1"),
      replayCapturesQueryKey(),
    ];
    cacheQueries({
      queryClient,
      queryKeys: [...hostQueryKeys, ...unrelatedQueryKeys],
    });

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      connectedCallbacks[0]?.({ reconnected: false });
    });

    for (const queryKey of hostQueryKeys) {
      expectQueryInvalidated({ queryClient, queryKey });
    }
    for (const queryKey of unrelatedQueryKeys) {
      expectQueryNotInvalidated({ queryClient, queryKey });
    }
  });

  it("refetches failed active realtime-backed queries on initial connection", async () => {
    let projectsRequestCount = 0;
    const fetchMock = installFetchRoutes([
      {
        pathname: "/api/v1/projects",
        handler: () => {
          projectsRequestCount += 1;
          return projectsRequestCount === 1
            ? new Response("starting", { status: 503 })
            : jsonResponse([]);
        },
      },
    ]);
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => {
        useWebSocket();
        return useProjects();
      },
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    act(() => {
      connectedCallbacks[0]?.({ reconnected: false });
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([]);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("scopes reconnect invalidation to websocket-backed cache", () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const realtimeBackedQueryKeys = [
      hostsQueryKey(),
      hostQueryKey("host-1"),
      projectsQueryKey(),
      projectFilesQueryKey("proj-1", "query", 10, null),
      threadsQueryKey(),
      threadQueryKey("thread-1"),
      threadTimelineQueryKey("thread-1", undefined),
      threadDraftsQueryKey("thread-1"),
      threadPendingInteractionsQueryKey("thread-1"),
      threadDefaultExecutionOptionsQueryKey("thread-1"),
      threadStorageFilesQueryKey("thread-1"),
      threadStorageFilePreviewQueryKey("thread-1", "docs/a.txt"),
      environmentQueryKey("env-1"),
      environmentWorkStatusQueryKey("env-1", null),
      environmentPromotionQueryKey("env-1"),
      environmentMergeBaseBranchesQueryKey("env-1"),
      environmentGitDiffQueryKey("env-1", "all", "main"),
      projectSourceWorkspaceStatusQueryKey("proj-1", "source-1"),
      localPathExistenceQueryKey("host-1", ["/repo"]),
      systemProvidersQueryKey(),
      availableModelsQueryKey("provider-1", "model-1"),
      statusQueryKey(),
    ];
    const unrelatedQueryKeys = [
      replayCapturesQueryKey(),
      cloudAuthSettingsQueryKey(),
      sandboxEnvVarsQueryKey(),
      sandboxBackendsQueryKey(),
      githubReposQueryKey("openai"),
    ];
    cacheQueries({
      queryClient,
      queryKeys: [...realtimeBackedQueryKeys, ...unrelatedQueryKeys],
    });

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      connectedCallbacks[0]?.({ reconnected: true });
    });

    for (const queryKey of realtimeBackedQueryKeys) {
      expectQueryInvalidated({ queryClient, queryKey });
    }
    for (const queryKey of unrelatedQueryKeys) {
      expectQueryNotInvalidated({ queryClient, queryKey });
    }
  });

  it("invalidates thread storage queries for cached environment threads", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const thread = createThread({
      environmentId: "env-1",
      id: "thread-1",
    });
    const invalidatedQueryKeys = [
      threadStorageFilesQueryKey("thread-1"),
      threadStorageFilePreviewQueryKey("thread-1", "docs/a.txt"),
    ];
    const preservedQueryKeys = [
      environmentQueryKey("env-1"),
      environmentWorkStatusQueryKey("env-1", null),
      environmentGitDiffQueryKey("env-1", null, null),
      environmentMergeBaseBranchesQueryKey("env-1"),
    ];
    cacheQueries({
      queryClient,
      queryKeys: [...invalidatedQueryKeys, ...preservedQueryKeys],
    });
    queryClient.setQueryData(threadQueryKey(thread.id), thread);
    queryClient.setQueryData(activeThreadListQueryKey(), [
      createThreadListEntry({
        environmentId: thread.environmentId,
        id: thread.id,
      }),
    ]);

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["thread-storage-changed"],
        entity: "environment",
        id: "env-1",
        type: "changed",
      });
      vi.advanceTimersByTime(500);
    });

    for (const queryKey of invalidatedQueryKeys) {
      expectQueryInvalidated({ queryClient, queryKey });
    }
    for (const queryKey of preservedQueryKeys) {
      expectQueryNotInvalidated({ queryClient, queryKey });
    }
  });

  it("invalidates workspace-derived queries but not the persisted environment record for work-status changes", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidatedQueryKeys = [
      environmentWorkStatusQueryKey("env-1", null),
      environmentGitDiffQueryKey("env-1", null, null),
    ];
    const preservedQueryKeys = [
      environmentQueryKey("env-1"),
      environmentMergeBaseBranchesQueryKey("env-1"),
    ];
    cacheQueries({
      queryClient,
      queryKeys: [...invalidatedQueryKeys, ...preservedQueryKeys],
    });

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["work-status-changed"],
        entity: "environment",
        id: "env-1",
        type: "changed",
      });
      vi.advanceTimersByTime(500);
    });

    for (const queryKey of invalidatedQueryKeys) {
      expectQueryInvalidated({ queryClient, queryKey });
    }
    for (const queryKey of preservedQueryKeys) {
      expectQueryNotInvalidated({ queryClient, queryKey });
    }
  });

  it("invalidates only merge-base-dependent queries for shared git ref changes without touching plain work status", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const plainWorkStatusQueryKey = environmentWorkStatusQueryKey(
      "env-1",
      null,
    );
    const mergeBaseWorkStatusQueryKey = environmentWorkStatusQueryKey(
      "env-1",
      "main",
    );
    const mergeBaseBranchesQueryKey =
      environmentMergeBaseBranchesQueryKey("env-1");
    const branchGitDiffQueryKey = environmentGitDiffQueryKey(
      "env-1",
      "all",
      "main",
    );
    const commitGitDiffQueryKey = environmentGitDiffQueryKey(
      "env-1",
      "commit",
      "abc123",
    );

    queryClient.setQueryData(plainWorkStatusQueryKey, null);
    queryClient.setQueryData(mergeBaseWorkStatusQueryKey, null);
    queryClient.setQueryData(mergeBaseBranchesQueryKey, ["main"]);
    queryClient.setQueryData(branchGitDiffQueryKey, {
      diff: "",
      truncated: false,
      shortstat: "",
      files: "",
    });
    queryClient.setQueryData(commitGitDiffQueryKey, {
      diff: "",
      truncated: false,
      shortstat: "",
      files: "",
    });

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["git-refs-changed"],
        entity: "environment",
        id: "env-1",
        type: "changed",
      });
      vi.advanceTimersByTime(500);
    });

    expect(
      queryClient.getQueryState(plainWorkStatusQueryKey)?.isInvalidated,
    ).not.toBe(true);
    expect(
      queryClient.getQueryState(mergeBaseWorkStatusQueryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(mergeBaseBranchesQueryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(branchGitDiffQueryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(commitGitDiffQueryKey)?.isInvalidated,
    ).not.toBe(true);
  });

  it("invalidates persisted environment, workspace, and branch queries for metadata changes", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const queryKeys = [
      environmentQueryKey("env-1"),
      environmentWorkStatusQueryKey("env-1", null),
      environmentGitDiffQueryKey("env-1", null, null),
      environmentMergeBaseBranchesQueryKey("env-1"),
    ];
    cacheQueries({ queryClient, queryKeys });

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["metadata-changed"],
        entity: "environment",
        id: "env-1",
        type: "changed",
      });
      vi.advanceTimersByTime(500);
    });

    for (const queryKey of queryKeys) {
      expectQueryInvalidated({ queryClient, queryKey });
    }
  });

  it("invalidates persisted environment, workspace, and branch queries for status changes", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const queryKeys = [
      environmentQueryKey("env-1"),
      environmentWorkStatusQueryKey("env-1", null),
      environmentGitDiffQueryKey("env-1", null, null),
      environmentMergeBaseBranchesQueryKey("env-1"),
    ];
    cacheQueries({ queryClient, queryKeys });

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["status-changed"],
        entity: "environment",
        id: "env-1",
        type: "changed",
      });
      vi.advanceTimersByTime(500);
    });

    for (const queryKey of queryKeys) {
      expectQueryInvalidated({ queryClient, queryKey });
    }
  });

  it("invalidates both environment and thread storage queries when both change kinds are present", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const thread = createThread({
      environmentId: "env-1",
      id: "thread-1",
    });
    const queryKeys = [
      environmentWorkStatusQueryKey("env-1", null),
      environmentGitDiffQueryKey("env-1", null, null),
      threadStorageFilesQueryKey("thread-1"),
      threadStorageFilePreviewQueryKey("thread-1", "docs/a.txt"),
    ];
    cacheQueries({ queryClient, queryKeys });
    queryClient.setQueryData(threadQueryKey(thread.id), thread);
    queryClient.setQueryData(activeThreadListQueryKey(), [
      createThreadListEntry({
        environmentId: thread.environmentId,
        id: thread.id,
      }),
    ]);

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["work-status-changed", "thread-storage-changed"],
        entity: "environment",
        id: "env-1",
        type: "changed",
      });
      vi.advanceTimersByTime(500);
    });

    for (const queryKey of queryKeys) {
      expectQueryInvalidated({ queryClient, queryKey });
    }
  });

  it("debounces pure thread event appends within the single invalidation window", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const timelineQueryKey = threadTimelineQueryKey("thread-1", undefined);
    const threadDetailQueryKey = threadQueryKey("thread-1");
    cacheQueries({
      queryClient,
      queryKeys: [timelineQueryKey, threadDetailQueryKey],
    });

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["events-appended"],
        entity: "thread",
        id: "thread-1",
        type: "changed",
      });
      vi.advanceTimersByTime(40);
    });

    expectQueryNotInvalidated({ queryClient, queryKey: timelineQueryKey });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["events-appended"],
        entity: "thread",
        id: "thread-1",
        type: "changed",
      });
      vi.advanceTimersByTime(49);
    });

    expectQueryNotInvalidated({ queryClient, queryKey: timelineQueryKey });

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expectQueryInvalidated({ queryClient, queryKey: timelineQueryKey });
    expectQueryInvalidated({ queryClient, queryKey: threadDetailQueryKey });
  });

  it("invalidates successive thread append bursts after each debounce window", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const timelineQueryKey = threadTimelineQueryKey("thread-1", undefined);
    cacheQuery({ queryClient, queryKey: timelineQueryKey });

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["events-appended"],
        entity: "thread",
        id: "thread-1",
        type: "changed",
      });
      vi.advanceTimersByTime(50);
    });

    expectQueryInvalidated({ queryClient, queryKey: timelineQueryKey });
    cacheQuery({ queryClient, queryKey: timelineQueryKey });
    expectQueryNotInvalidated({ queryClient, queryKey: timelineQueryKey });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["events-appended"],
        entity: "thread",
        id: "thread-1",
        type: "changed",
      });
      vi.advanceTimersByTime(50);
    });

    expectQueryInvalidated({ queryClient, queryKey: timelineQueryKey });
  });

  it("flushes thread status changes immediately without waiting for the debounce window", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const queryKeys = [
      threadTimelineQueryKey("thread-1", undefined),
      threadQueryKey("thread-1"),
      threadsQueryKey(),
      statusQueryKey(),
    ];
    cacheQueries({ queryClient, queryKeys });

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["status-changed"],
        entity: "thread",
        id: "thread-1",
        type: "changed",
      });
    });

    for (const queryKey of queryKeys) {
      expectQueryInvalidated({ queryClient, queryKey });
    }
  });

  it("invalidates pending interaction queries and timeline state for thread interaction changes", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const queryKeys = [
      threadPendingInteractionsQueryKey("thread-1"),
      threadTimelineQueryKey("thread-1", undefined),
      threadQueryKey("thread-1"),
    ];
    cacheQueries({ queryClient, queryKeys });

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["interactions-changed"],
        entity: "thread",
        id: "thread-1",
        type: "changed",
      });
      vi.advanceTimersByTime(200);
    });

    expectQueryInvalidated({
      queryClient,
      queryKey: threadTimelineQueryKey("thread-1", undefined),
    });
    expectQueryInvalidated({
      queryClient,
      queryKey: threadQueryKey("thread-1"),
    });
  });

  it("updates the cached thread list after fetching changed pending interactions", async () => {
    vi.useFakeTimers();
    installFetchRoutes([
      {
        pathname: "/api/v1/threads/thread-1/interactions",
        handler: () => jsonResponse([createPendingInteraction("thread-1")]),
      },
    ]);
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const threadListKey = activeThreadListQueryKey();
    queryClient.setQueryData(threadListKey, [
      createThreadListEntry({
        environmentId: "env-1",
        id: "thread-1",
        hasPendingInteraction: false,
      }),
    ]);
    cacheQueries({
      queryClient,
      queryKeys: [
        threadPendingInteractionsQueryKey("thread-1"),
        threadTimelineQueryKey("thread-1", undefined),
        threadQueryKey("thread-1"),
      ],
    });

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["interactions-changed"],
        entity: "thread",
        id: "thread-1",
        type: "changed",
      });
      vi.advanceTimersByTime(200);
    });

    await vi.waitFor(() => {
      expect(
        queryClient.getQueryData<ThreadListEntry[]>(threadListKey),
      ).toEqual([
        expect.objectContaining({
          hasPendingInteraction: true,
          id: "thread-1",
        }),
      ]);
    });
  });

  it("invalidates all thread-scoped caches for global thread changes", () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const queryKeys = [
      threadsQueryKey(),
      statusQueryKey(),
      threadQueryKey("thread-1"),
      threadDraftsQueryKey("thread-1"),
      threadPendingInteractionsQueryKey("thread-1"),
      threadTimelineQueryKey("thread-1", undefined),
    ];
    cacheQueries({ queryClient, queryKeys });

    renderHook(() => useWebSocket(), { wrapper });

    act(() => {
      changedCallbacks[0]?.({
        changes: ["queue-changed", "interactions-changed", "status-changed"],
        entity: "thread",
        type: "changed",
      });
    });

    for (const queryKey of queryKeys) {
      expectQueryInvalidated({ queryClient, queryKey });
    }
  });
});
