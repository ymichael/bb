// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingInteraction, ThreadListEntry } from "@bb/domain";
import type {
  SidebarBootstrapResponse,
  ThreadTimelineResponse,
  ThreadWithIncludesResponse,
} from "@bb/server-contract";
import { COMPACT_VIEWPORT_QUERY } from "@bb/shared-ui/hooks/use-compact-viewport";
import * as api from "@/lib/api";
import { sdk } from "@/lib/sdk";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ARCHIVED_THREADS_PAGE_SIZE } from "./archived-threads-page-size";
import {
  sidebarNavigationQueryKey,
  threadDetailBootstrapQueryKey,
  threadHostFilePreviewQueryKey,
  threadPendingInteractionsQueryKey,
  threadQueuedMessagesQueryKey,
  threadQueryKey,
  threadTimelineQueryKey,
} from "./query-keys";
import {
  COMPACT_THREAD_TIMELINE_SEGMENT_LIMIT,
  didThreadDetailBootstrapRefreshAfterMount,
  isPendingInteractionStateUnknown,
  useArchivedThreads,
  useChildThreads,
  useThread,
  useThreadDetailBootstrap,
  useThreadHostFilePreview,
  useThreadMentionCandidates,
  useThreadPendingInteractions,
  useThreadQueuedMessages,
  useThreadStorageLocation,
  useThreadTimeline,
} from "./thread-queries";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import {
  makeThreadResponse,
  makeThreadTimelineResponse,
} from "@/test/fixtures/thread-responses";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getThreadHostFilePreview: vi.fn(),
  };
});

vi.mock("@/lib/sdk", () => ({
  sdk: {
    threads: {
      get: vi.fn(),
      list: vi.fn(),
      queuedMessages: { list: vi.fn() },
      interactions: { list: vi.fn() },
      storageLocation: vi.fn(),
      timeline: vi.fn(),
    },
  },
}));

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useThreadDetailRealtimeSubscription: vi.fn(),
  useThreadListRealtimeSubscription: vi.fn(),
}));

const THREAD_WITH_INCLUDES = {
  ...makeThreadResponse({
    id: "thread-1",
    projectId: "project-1",
    environmentId: null,
    title: "Thread",
    titleFallback: "Thread",
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: 1,
  }),
  environment: null,
  host: null,
} satisfies ThreadWithIncludesResponse;

function makeSidebarNavigation(
  projectThreads: ThreadListEntry[],
  personalThreads: ThreadListEntry[] = [],
): SidebarBootstrapResponse {
  return makeSidebarBootstrapResponse({
    projects: [
      makeProjectWithThreadsResponse({
        id: "project-1",
        name: "Project",
        createdAt: 1,
        updatedAt: 1,
        threads: projectThreads,
      }),
    ],
    personalProject: makeProjectWithThreadsResponse({
      id: "proj_personal",
      kind: "personal",
      name: "Personal",
      createdAt: 1,
      updatedAt: 1,
      threads: personalThreads,
    }),
  });
}

function mockMatchMedia(matching: readonly string[]) {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: matching.includes(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.mocked(sdk.threads.get).mockResolvedValue(THREAD_WITH_INCLUDES);
  vi.mocked(sdk.threads.list).mockResolvedValue([]);
  vi.mocked(sdk.threads.queuedMessages.list).mockResolvedValue([]);
  vi.mocked(sdk.threads.interactions.list).mockResolvedValue([]);
  vi.mocked(sdk.threads.storageLocation).mockResolvedValue({
    hostId: "host-1",
    storageRootPath: "/tmp/thread-storage/thread-1",
  });
  vi.mocked(sdk.threads.timeline).mockResolvedValue(
    makeThreadTimelineResponse({
      timelinePage: {
        kind: "latest",
        segmentLimit: 100,
        returnedSegmentCount: 0,
        hasOlderRows: false,
        olderCursor: null,
      },
    }),
  );
  vi.mocked(api.getThreadHostFilePreview).mockResolvedValue({
    kind: "text",
    path: "/tmp/log.txt",
    url: "/api/v1/threads/thread-1/host-files/content?path=%2Ftmp%2Flog.txt",
    mimeType: "text/plain",
    content: "preview",
  });
});

describe("useThreadDetailBootstrap", () => {
  it("starts the timeline request before the thread bootstrap settles", async () => {
    let resolveThread:
      | ((thread: ThreadWithIncludesResponse) => void)
      | undefined;
    const threadPromise = new Promise<ThreadWithIncludesResponse>((resolve) => {
      resolveThread = resolve;
    });
    vi.mocked(sdk.threads.get).mockReturnValue(threadPromise);
    const { wrapper } = createQueryClientTestHarness();

    const result = renderHook(
      () =>
        useThreadDetailBootstrap("thread-1", {
          timelinePrefetch: true,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.threads.get).toHaveBeenCalledTimes(1);
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(1);
    });
    expect(result.result.current.isPending).toBe(true);

    resolveThread?.(THREAD_WITH_INCLUDES);
    await waitFor(() => {
      expect(result.result.current.isSuccess).toBe(true);
    });
  });

  it("uses the cached timeline sequence and merges a prefetched delta", async () => {
    const previousTimeline = makeThreadTimelineResponse({
      rows: [
        {
          id: "row-1",
          kind: "system",
          threadId: "thread-1",
          turnId: null,
          sourceSeqStart: 7,
          sourceSeqEnd: 7,
          startedAt: 1,
          createdAt: 1,
          systemKind: "debug",
          title: "Existing row",
          detail: null,
          status: null,
        },
      ],
      timelinePage: {
        kind: "latest",
        segmentLimit: 100,
        returnedSegmentCount: 1,
        hasOlderRows: false,
        olderCursor: null,
      },
      maxSeq: 7,
    });
    vi.mocked(sdk.threads.timeline).mockResolvedValueOnce({
      ...previousTimeline,
      rows: [],
      maxSeq: 8,
      delta: { upsertRows: [] },
    });
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      previousTimeline,
      { updatedAt: 1 },
    );

    renderHook(
      () =>
        useThreadDetailBootstrap("thread-1", {
          timelinePrefetch: true,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledWith({
        afterSequence: "7",
        signal: expect.any(AbortSignal),
        threadId: "thread-1",
      });
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey("thread-1"),
        ),
      ).toEqual({
        ...previousTimeline,
        maxSeq: 8,
      });
    });
  });

  it("only suppresses a thread refetch for a bootstrap fetched after mount", () => {
    expect(
      didThreadDetailBootstrapRefreshAfterMount({
        dataUpdatedAt: 0,
        isFetchedAfterMount: false,
        isSuccess: true,
      }),
    ).toBe(false);
    expect(
      didThreadDetailBootstrapRefreshAfterMount({
        dataUpdatedAt: 0,
        isFetchedAfterMount: true,
        isSuccess: true,
      }),
    ).toBe(true);
  });

  it("skips the duplicate thread read for a freshly cached bootstrap", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const updatedAt = Date.now();
    queryClient.setQueryData(
      threadDetailBootstrapQueryKey("thread-1"),
      THREAD_WITH_INCLUDES,
      { updatedAt },
    );
    queryClient.setQueryData(threadQueryKey("thread-1"), THREAD_WITH_INCLUDES, {
      updatedAt,
    });

    const result = renderHook(
      () => {
        const bootstrap = useThreadDetailBootstrap("thread-1");
        return useThread("thread-1", {
          enabled: bootstrap.isSuccess,
          refetchOnMount: didThreadDetailBootstrapRefreshAfterMount(bootstrap)
            ? false
            : "always",
        });
      },
      { wrapper },
    );

    await waitFor(() => {
      expect(result.result.current.isSuccess).toBe(true);
    });
    expect(sdk.threads.get).not.toHaveBeenCalled();
  });

  it("refreshes the thread read for an old cached bootstrap", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(
      threadDetailBootstrapQueryKey("thread-1"),
      THREAD_WITH_INCLUDES,
      { updatedAt: 1 },
    );
    queryClient.setQueryData(threadQueryKey("thread-1"), THREAD_WITH_INCLUDES, {
      updatedAt: 1,
    });

    renderHook(
      () => {
        const bootstrap = useThreadDetailBootstrap("thread-1");
        return useThread("thread-1", {
          enabled: bootstrap.isSuccess,
          refetchOnMount: didThreadDetailBootstrapRefreshAfterMount(bootstrap)
            ? false
            : "always",
        });
      },
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.threads.get).toHaveBeenCalledTimes(1);
    });
    expect(sdk.threads.get).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      threadId: "thread-1",
    });
  });
});

describe("useArchivedThreads", () => {
  it("loads archived threads across all projects when no scope is selected", async () => {
    const { wrapper } = createQueryClientTestHarness();

    renderHook(() => useArchivedThreads({}), { wrapper });

    await waitFor(() => {
      expect(sdk.threads.list).toHaveBeenCalled();
    });
    expect(vi.mocked(sdk.threads.list).mock.calls[0]?.[0]).toEqual({
      archived: true,
      limit: ARCHIVED_THREADS_PAGE_SIZE,
      offset: 0,
      signal: expect.any(AbortSignal),
    });
  });

  it("maps the archived kind filter to the parent-thread query", async () => {
    const { wrapper } = createQueryClientTestHarness();

    renderHook(() => useArchivedThreads({ kind: "child" }), { wrapper });

    await waitFor(() => {
      expect(sdk.threads.list).toHaveBeenCalled();
    });
    expect(vi.mocked(sdk.threads.list).mock.calls[0]?.[0]).toEqual({
      archived: true,
      hasParent: true,
      limit: ARCHIVED_THREADS_PAGE_SIZE,
      offset: 0,
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps project scope for project archived lists", async () => {
    const { wrapper } = createQueryClientTestHarness();

    renderHook(() => useArchivedThreads({ projectId: "proj_1" }), {
      wrapper,
    });

    await waitFor(() => {
      expect(sdk.threads.list).toHaveBeenCalled();
    });
    expect(vi.mocked(sdk.threads.list).mock.calls[0]?.[0]).toEqual({
      archived: true,
      limit: ARCHIVED_THREADS_PAGE_SIZE,
      offset: 0,
      projectId: "proj_1",
      signal: expect.any(AbortSignal),
    });
  });
});

describe("useThreadQueuedMessages", () => {
  it("refetches stale queue data on window focus", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();

    renderHook(() => useThreadQueuedMessages("thread-1"), { wrapper });

    await waitFor(() => {
      expect(sdk.threads.queuedMessages.list).toHaveBeenCalledTimes(1);
    });

    const query = queryClient.getQueryCache().find({
      queryKey: threadQueuedMessagesQueryKey("thread-1"),
    });

    expect(query?.options).toEqual(
      expect.objectContaining({
        refetchOnMount: true,
        refetchOnWindowFocus: true,
      }),
    );
  });
});

describe("useThreadPendingInteractions", () => {
  it("keeps cached empty interactions unknown while their refresh is pending", () => {
    expect(isPendingInteractionStateUnknown([], true)).toBe(true);
    expect(isPendingInteractionStateUnknown([], false)).toBe(false);
  });

  it("reuses the first owner's fresh baseline when a second owner mounts", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const first = renderHook(() => useThreadPendingInteractions("thread-1"), {
      wrapper,
    });
    await waitFor(() => {
      expect(first.result.current.isSuccess).toBe(true);
    });
    queryClient.setQueryData(
      threadPendingInteractionsQueryKey("thread-1"),
      [],
      { updatedAt: Date.now() - 1_000 },
    );

    renderHook(() => useThreadPendingInteractions("thread-1"), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    expect(sdk.threads.interactions.list).toHaveBeenCalledTimes(1);
  });

  it("refreshes the baseline after every zero-owner interval", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const first = renderHook(() => useThreadPendingInteractions("thread-1"), {
      wrapper,
    });
    await waitFor(() => {
      expect(first.result.current.isSuccess).toBe(true);
    });
    first.unmount();
    const pendingInteraction: PendingInteraction = {
      id: "pint-plan",
      threadId: "thread-1",
      turnId: "turn-1",
      providerId: "claude-code",
      providerThreadId: "provider-thread-1",
      providerRequestId: "request-1",
      status: "pending",
      statusReason: null,
      createdAt: 1,
      resolvedAt: null,
      resolution: null,
      payload: {
        kind: "approval",
        reason: null,
        availableDecisions: ["allow_once", "deny"],
        subject: {
          kind: "plan",
          itemId: "plan-1",
          plan: "Refresh the baseline",
          planFilePath: null,
        },
      },
    };
    vi.mocked(sdk.threads.interactions.list).mockResolvedValue([
      pendingInteraction,
    ]);

    const second = renderHook(() => useThreadPendingInteractions("thread-1"), {
      wrapper,
    });

    await waitFor(() => {
      expect(second.result.current.data).toEqual([pendingInteraction]);
    });
    expect(sdk.threads.interactions.list).toHaveBeenCalledTimes(2);
  });

  it("refetches the interaction baseline when a stale owner remounts", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const first = renderHook(() => useThreadPendingInteractions("thread-1"), {
      wrapper,
    });
    await waitFor(() => {
      expect(first.result.current.isSuccess).toBe(true);
    });
    first.unmount();
    queryClient.setQueryData(
      threadPendingInteractionsQueryKey("thread-1"),
      [],
      { updatedAt: Date.now() - 2_500 },
    );

    renderHook(() => useThreadPendingInteractions("thread-1"), { wrapper });

    await waitFor(() => {
      expect(sdk.threads.interactions.list).toHaveBeenCalledTimes(2);
    });
  });
});

describe("useThreadHostFilePreview", () => {
  it("refetches stale host file previews on focus and reconnect", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();

    renderHook(
      () => useThreadHostFilePreview("thread-1", "env-1", "/tmp/log.txt"),
      { wrapper },
    );

    await waitFor(() => {
      expect(api.getThreadHostFilePreview).toHaveBeenCalledTimes(1);
    });

    const query = queryClient.getQueryCache().find({
      queryKey: threadHostFilePreviewQueryKey(
        "thread-1",
        "env-1",
        "/tmp/log.txt",
      ),
    });

    expect(query?.options).toEqual(
      expect.objectContaining({
        refetchOnReconnect: true,
        refetchOnWindowFocus: true,
      }),
    );
  });
});

describe("useChildThreads", () => {
  it("derives children from the sidebar cache across projects without a list request", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const projectChild = makeThreadListEntry({
      id: "child-1",
      projectId: "project-1",
      parentThreadId: "parent-1",
    });
    const personalChild = makeThreadListEntry({
      id: "child-2",
      projectId: "proj_personal",
      parentThreadId: "parent-1",
    });
    const hiddenChild = makeThreadListEntry({
      id: "child-hidden",
      parentThreadId: "parent-1",
      visibility: "hidden",
    });
    const otherChild = makeThreadListEntry({
      id: "child-other",
      parentThreadId: "parent-2",
    });
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation(
        [projectChild, hiddenChild, otherChild],
        [personalChild],
      ),
    );

    const { result } = renderHook(
      () => useChildThreads({ enabled: true, parentThreadId: "parent-1" }),
      { wrapper },
    );

    expect(result.current.data?.map((thread) => thread.id)).toEqual([
      "child-1",
      "child-2",
    ]);
    expect(result.current.isLoading).toBe(false);
    expect(sdk.threads.list).not.toHaveBeenCalled();

    const newChild = makeThreadListEntry({
      id: "child-3",
      parentThreadId: "parent-1",
    });
    act(() => {
      queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        makeSidebarNavigation([projectChild, newChild], [personalChild]),
      );
    });
    await waitFor(() => {
      expect(result.current.data?.map((thread) => thread.id)).toEqual([
        "child-1",
        "child-3",
        "child-2",
      ]);
    });
    expect(sdk.threads.list).not.toHaveBeenCalled();
  });

  it("keeps the derived list stable when unrelated sidebar rows change", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const child = makeThreadListEntry({
      id: "child-1",
      parentThreadId: "parent-1",
    });
    const unrelated = makeThreadListEntry({ id: "other", title: "Before" });
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([child, unrelated]),
    );
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useChildThreads({ enabled: true, parentThreadId: "parent-1" });
      },
      { wrapper },
    );
    const initialData = result.current.data;
    const initialRenders = renders;
    expect(initialData?.map((thread) => thread.id)).toEqual(["child-1"]);

    act(() => {
      queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        makeSidebarNavigation([child, { ...unrelated, title: "After" }]),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.data).toBe(initialData);
    expect(renders).toBe(initialRenders);
  });

  it("waits for an in-flight sidebar bootstrap instead of racing it with a list request", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const child = makeThreadListEntry({
      id: "child-1",
      parentThreadId: "parent-1",
    });
    let resolveBootstrap: (value: SidebarBootstrapResponse) => void = () => {};
    const bootstrapFetch = queryClient.prefetchQuery({
      queryKey: sidebarNavigationQueryKey(),
      queryFn: () =>
        new Promise<SidebarBootstrapResponse>((resolve) => {
          resolveBootstrap = resolve;
        }),
    });

    const { result } = renderHook(
      () => useChildThreads({ enabled: true, parentThreadId: "parent-1" }),
      { wrapper },
    );

    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
    expect(sdk.threads.list).not.toHaveBeenCalled();

    await act(async () => {
      resolveBootstrap(makeSidebarNavigation([child]));
      await bootstrapFetch;
    });
    await waitFor(() => {
      expect(result.current.data).toEqual([child]);
    });
    expect(result.current.isLoading).toBe(false);
    expect(sdk.threads.list).not.toHaveBeenCalled();
  });

  it("falls back to the parent-keyed list request without a sidebar cache", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const child = makeThreadListEntry({
      id: "child-1",
      parentThreadId: "parent-1",
    });
    vi.mocked(sdk.threads.list).mockResolvedValue([child]);

    const { result } = renderHook(
      () => useChildThreads({ enabled: true, parentThreadId: "parent-1" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.data).toEqual([child]);
    });
    expect(sdk.threads.list).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sdk.threads.list).mock.calls[0]?.[0]).toEqual({
      archived: false,
      parentThreadId: "parent-1",
      signal: expect.any(AbortSignal),
    });
  });
});

describe("useThreadMentionCandidates", () => {
  it("serves candidates from the sidebar cache without a list request", () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const visible = makeThreadListEntry({ id: "thread-visible" });
    const hidden = makeThreadListEntry({
      id: "thread-hidden",
      visibility: "hidden",
    });
    const personal = makeThreadListEntry({
      id: "thread-personal",
      projectId: "proj_personal",
    });
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([visible, hidden], [personal]),
    );

    const { result } = renderHook(
      () => useThreadMentionCandidates({ enabled: true }),
      { wrapper },
    );

    expect(result.current.data?.map((thread) => thread.id)).toEqual([
      "thread-visible",
      "thread-personal",
    ]);
    expect(result.current.isLoading).toBe(false);
    expect(sdk.threads.list).not.toHaveBeenCalled();
  });

  it("falls back to the capped list request without a sidebar cache", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const thread = makeThreadListEntry({ id: "thread-1" });
    vi.mocked(sdk.threads.list).mockResolvedValue([thread]);

    const { result } = renderHook(
      () => useThreadMentionCandidates({ enabled: true }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.data).toEqual([thread]);
    });
    expect(vi.mocked(sdk.threads.list).mock.calls[0]?.[0]).toEqual({
      archived: false,
      limit: 200,
      signal: expect.any(AbortSignal),
    });
  });
});

describe("useThreadStorageLocation", () => {
  it("requests only the storage location for the thread", async () => {
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(() => useThreadStorageLocation("thread-1"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({
        hostId: "host-1",
        storageRootPath: "/tmp/thread-storage/thread-1",
      });
    });
    expect(sdk.threads.storageLocation).toHaveBeenCalledWith({
      threadId: "thread-1",
      signal: expect.any(AbortSignal),
    });
  });
});

describe("useThreadTimeline segment limit", () => {
  it("asks for the compact first window on compact viewports and keeps it for deltas", async () => {
    mockMatchMedia([COMPACT_VIEWPORT_QUERY]);
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(() => useThreadTimeline("thread-1"), {
      wrapper,
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(vi.mocked(sdk.threads.timeline).mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      segmentLimit: String(COMPACT_THREAD_TIMELINE_SEGMENT_LIMIT),
      signal: expect.any(AbortSignal),
    });

    await queryClient.refetchQueries({
      queryKey: threadTimelineQueryKey("thread-1"),
    });
    expect(vi.mocked(sdk.threads.timeline).mock.calls[1]?.[0]).toEqual({
      threadId: "thread-1",
      segmentLimit: String(COMPACT_THREAD_TIMELINE_SEGMENT_LIMIT),
      afterSequence: "0",
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps the server default window on wide viewports", async () => {
    mockMatchMedia([]);
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(() => useThreadTimeline("thread-1"), {
      wrapper,
    });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(vi.mocked(sdk.threads.timeline).mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      signal: expect.any(AbortSignal),
    });
  });
});
