import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import {
  ENVIRONMENT_CHANGE_KINDS,
  HOST_CHANGE_KINDS,
  PROJECT_CHANGE_KINDS,
  SYSTEM_CHANGE_KINDS,
  THREAD_CHANGE_KINDS,
} from "@bb/domain";
import { createAppQueryClient } from "@/lib/query-client";
import {
  archivedThreadsListQueryKey,
  environmentDiffFilesQueryKey,
  environmentDiffPatchQueryKey,
  environmentPullRequestQueryKey,
  environmentWorkStatusQueryKey,
  hostPathExistenceQueryKey,
  projectPathsQueryKey,
  projectCommandsQueryKey,
  projectFilePreviewQueryKey,
  projectPromptHistoryQueryKey,
  projectSourceBranchesQueryKey,
  projectsQueryKey,
  sidebarNavigationQueryKey,
  systemConfigQueryKey,
  systemExecutionOptionsQueryKey,
  systemProvidersQueryKey,
  threadDefaultExecutionOptionsQueryKey,
  threadConversationOutlineQueryKey,
  threadQueuedMessagesQueryKey,
  threadListQueryKey,
  threadPromptHistoryQueryKey,
  threadQueryKey,
  threadTabsQueryKey,
  threadSearchQueryKey,
  terminalsQueryKey,
  threadStorageFilePreviewQueryKey,
  threadTimelineQueryKey,
  threadTimelineQueryKeyPrefix,
  threadTimelineTurnSummaryDetailsQueryKey,
} from "./queries/query-keys";
import { pluginContributionsQueryKey } from "./queries/query-keys";
import {
  createRealtimeCacheEffects,
  resolveThreadInvalidationDebounce,
  type RealtimeCacheEffectsVisibility,
} from "./realtime-cache-effects";
import {
  REALTIME_ENVIRONMENT_CHANGE_REGISTRY,
  REALTIME_HOST_CHANGE_REGISTRY,
  REALTIME_PROJECT_CHANGE_REGISTRY,
  REALTIME_SYSTEM_CHANGE_REGISTRY,
  REALTIME_THREAD_CHANGE_REGISTRY,
} from "./cache-owners/realtime-cache-registry";

const PROJECT_PROMPT_HISTORY_THREAD_CHANGES = [
  "thread-created",
  "thread-deleted",
  "archived-changed",
] as const;
const NON_PROJECT_PROMPT_HISTORY_THREAD_CHANGES = [
  "parent-changed",
  "read-state-changed",
  "title-changed",
] as const;

interface CachedThreadListEntryFixture {
  hasPendingInteraction: boolean;
  id: string;
}

interface CachedSidebarNavigationProjectFixture {
  threads: CachedThreadListEntryFixture[];
}

interface CachedSidebarNavigationFixture {
  personalProject: CachedSidebarNavigationProjectFixture;
  projects: CachedSidebarNavigationProjectFixture[];
}

interface FakeVisibility extends RealtimeCacheEffectsVisibility {
  setVisible: (visible: boolean) => void;
}

const NO_THREAD_ACTIVITY = {
  activeBackgroundAgentCount: 0,
  activeBackgroundCommandCount: 0,
  activeGoalCount: 0,
  activePlanModeCount: 0,
  activeWorkflowCount: 0,
} as const;

function createFakeVisibility(): FakeVisibility {
  let visible = true;
  const listeners = new Set<() => void>();
  return {
    isDocumentVisible: () => visible,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setVisible: (nextVisible) => {
      visible = nextVisible;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function createRealtimeEffectsTestContext(
  visibility?: RealtimeCacheEffectsVisibility,
) {
  const queryClient = createAppQueryClient({
    defaultOptions: {
      queries: {
        gcTime: Infinity,
        retry: false,
      },
    },
    showMutationErrorToasts: false,
  });
  const effects = createRealtimeCacheEffects({ queryClient, visibility });
  const firstProjectHistoryKey = projectPromptHistoryQueryKey("project-1");
  const secondProjectHistoryKey = projectPromptHistoryQueryKey("project-2");
  const terminalKey = terminalsQueryKey({
    kind: "thread",
    threadId: "thr_1",
  });

  queryClient.setQueryData(firstProjectHistoryKey, []);
  queryClient.setQueryData(secondProjectHistoryKey, []);
  queryClient.setQueryData(terminalKey, { sessions: [] });

  return {
    effects,
    firstProjectHistoryKey,
    queryClient,
    secondProjectHistoryKey,
    terminalKey,
  };
}

describe("createRealtimeCacheEffects", () => {
  it("isolates project workspace caches between selected hosts", () => {
    expect(
      projectPathsQueryKey("project-1", null, "host-a", "src", 8, true, true),
    ).not.toEqual(
      projectPathsQueryKey("project-1", null, "host-b", "src", 8, true, true),
    );
    expect(
      projectCommandsQueryKey("project-1", "codex", null, "host-a"),
    ).not.toEqual(
      projectCommandsQueryKey("project-1", "codex", null, "host-b"),
    );
    expect(
      projectFilePreviewQueryKey("project-1", null, "host-a", "README.md"),
    ).not.toEqual(
      projectFilePreviewQueryKey("project-1", null, "host-b", "README.md"),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps every realtime thread change to at least one dirty handler", () => {
    for (const changeKind of THREAD_CHANGE_KINDS) {
      expect(
        REALTIME_THREAD_CHANGE_REGISTRY[changeKind].dirty.length,
      ).toBeGreaterThan(0);
    }
  });

  it("maps every realtime environment change to at least one dirty handler", () => {
    for (const changeKind of ENVIRONMENT_CHANGE_KINDS) {
      expect(
        REALTIME_ENVIRONMENT_CHANGE_REGISTRY[changeKind].dirty.length,
      ).toBeGreaterThan(0);
    }
  });

  it("maps every realtime project change to at least one dirty handler", () => {
    for (const changeKind of PROJECT_CHANGE_KINDS) {
      expect(
        REALTIME_PROJECT_CHANGE_REGISTRY[changeKind].dirty.length,
      ).toBeGreaterThan(0);
    }
  });

  it("maps every realtime host change to at least one dirty handler", () => {
    for (const changeKind of HOST_CHANGE_KINDS) {
      expect(
        REALTIME_HOST_CHANGE_REGISTRY[changeKind].dirty.length,
      ).toBeGreaterThan(0);
    }
  });

  it("maps every cache-affecting system change to a dirty handler", () => {
    for (const changeKind of SYSTEM_CHANGE_KINDS) {
      const dirty = REALTIME_SYSTEM_CHANGE_REGISTRY[changeKind]?.dirty ?? [];
      expect(dirty.length).toBeGreaterThan(0);
    }
  });

  it("invalidates the affected thread tabs when another client changes them", () => {
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const tabsKey = threadTabsQueryKey("thr_1");
    queryClient.setQueryData(tabsKey, { revision: 1, tabs: [] });

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["tabs-changed"],
    });

    expect(queryClient.getQueryState(tabsKey)?.isInvalidated).toBe(true);
    effects.dispose();
  });

  it("keeps provider pickers cached on unrelated plugins-changed events", () => {
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const contributionsKey = pluginContributionsQueryKey();
    queryClient.setQueryData(contributionsKey, {
      threadActions: [],
      mentionProviders: [],
    });
    const commandsKey = projectCommandsQueryKey(
      "project-1",
      "codex",
      "environment-1",
      null,
    );
    queryClient.setQueryData(commandsKey, { commands: [] });
    const providersKey = systemProvidersQueryKey({ hostId: "host-1" });
    queryClient.setQueryData(providersKey, []);
    const executionOptionsKey = systemExecutionOptionsQueryKey({
      environmentId: "environment-1",
      hostId: "host-1",
      providerId: "codex",
    });
    queryClient.setQueryData(executionOptionsKey, {});

    effects.handleChanged({
      type: "changed",
      entity: "system",
      changes: ["plugins-changed"],
    });

    expect(queryClient.getQueryState(contributionsKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(commandsKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(providersKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(executionOptionsKey)?.isInvalidated).toBe(
      false,
    );
  });

  it("invalidates provider pickers on provider registration changes", () => {
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const providersKey = systemProvidersQueryKey({ hostId: "host-1" });
    queryClient.setQueryData(providersKey, []);
    const executionOptionsKey = systemExecutionOptionsQueryKey({
      environmentId: "environment-1",
      hostId: "host-1",
      providerId: "codex",
    });
    queryClient.setQueryData(executionOptionsKey, {});

    effects.handleChanged({
      type: "changed",
      entity: "system",
      changes: ["provider-registrations-changed"],
    });

    expect(queryClient.getQueryState(providersKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(executionOptionsKey)?.isInvalidated).toBe(
      true,
    );
  });

  it("invalidates timelines when config changes provider event visibility", () => {
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const configKey = systemConfigQueryKey();
    const timelineKey = threadTimelineQueryKey("thr_1");
    const summaryKey = threadTimelineTurnSummaryDetailsQueryKey({
      threadId: "thr_1",
      turnId: "turn_1",
      sourceSeqStart: 1,
      sourceSeqEnd: 2,
    });
    queryClient.setQueryData(configKey, {});
    queryClient.setQueryData(timelineKey, {});
    queryClient.setQueryData(summaryKey, {});

    effects.handleChanged({
      type: "changed",
      entity: "system",
      changes: ["config-changed"],
    });

    expect(queryClient.getQueryState(configKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(timelineKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(summaryKey)?.isInvalidated).toBe(true);
    effects.dispose();
  });

  it.each(PROJECT_PROMPT_HISTORY_THREAD_CHANGES)(
    "invalidates all cached project prompt histories for %s thread events",
    (change) => {
      vi.useFakeTimers();
      const {
        effects,
        firstProjectHistoryKey,
        queryClient,
        secondProjectHistoryKey,
      } = createRealtimeEffectsTestContext();

      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thr_1",
        changes: [change],
      });

      expect(
        queryClient.getQueryState(firstProjectHistoryKey)?.isInvalidated,
      ).not.toBe(true);
      expect(
        queryClient.getQueryState(secondProjectHistoryKey)?.isInvalidated,
      ).not.toBe(true);

      vi.advanceTimersByTime(50);

      expect(
        queryClient.getQueryState(firstProjectHistoryKey)?.isInvalidated,
      ).toBe(true);
      expect(
        queryClient.getQueryState(secondProjectHistoryKey)?.isInvalidated,
      ).toBe(true);

      effects.dispose();
    },
  );

  it("uses thread project metadata to invalidate only the affected project prompt history", () => {
    vi.useFakeTimers();
    const {
      effects,
      firstProjectHistoryKey,
      queryClient,
      secondProjectHistoryKey,
    } = createRealtimeEffectsTestContext();

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { projectId: "project-1" },
      changes: ["thread-created"],
    });

    vi.advanceTimersByTime(50);

    expect(
      queryClient.getQueryState(firstProjectHistoryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(secondProjectHistoryKey)?.isInvalidated,
    ).not.toBe(true);

    effects.dispose();
  });

  it("uses thread project metadata to invalidate affected project and global thread lists", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const firstProjectThreadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    const firstProjectArchivedThreadListKey = archivedThreadsListQueryKey({
      projectId: "project-1",
    });
    const secondProjectThreadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-2",
    });
    const globalActiveThreadListKey = threadListQueryKey({
      archived: false,
    });
    const globalRootThreadListKey = threadListQueryKey({
      archived: false,
    });
    queryClient.setQueryData(firstProjectThreadListKey, []);
    queryClient.setQueryData(firstProjectArchivedThreadListKey, []);
    queryClient.setQueryData(secondProjectThreadListKey, []);
    queryClient.setQueryData(globalActiveThreadListKey, []);
    queryClient.setQueryData(globalRootThreadListKey, []);

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { projectId: "project-1" },
      changes: ["title-changed"],
    });

    vi.advanceTimersByTime(50);

    expect(
      queryClient.getQueryState(firstProjectThreadListKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(firstProjectArchivedThreadListKey)
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(globalActiveThreadListKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(globalRootThreadListKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(secondProjectThreadListKey)?.isInvalidated,
    ).not.toBe(true);

    effects.dispose();
  });

  it("invalidates sidebar navigation for thread list changes", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const sidebarNavigationKey = sidebarNavigationQueryKey();
    queryClient.setQueryData<CachedSidebarNavigationFixture>(
      sidebarNavigationKey,
      {
        projects: [{ threads: [] }],
        personalProject: { threads: [] },
      },
    );

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { projectId: "project-1" },
      changes: ["title-changed"],
    });
    vi.advanceTimersByTime(50);

    expect(queryClient.getQueryState(sidebarNavigationKey)?.isInvalidated).toBe(
      true,
    );

    effects.dispose();
  });

  it("invalidates cached thread search results only once a turn completes, not on every appended batch", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const threadSearchKey = threadSearchQueryKey({
      limitPerGroup: 20,
      query: "needle",
    });
    queryClient.setQueryData(threadSearchKey, {
      active: { results: [], total: 0 },
      archived: { results: [], total: 0 },
    });

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { eventTypes: ["item/completed"], projectId: "project-1" },
      changes: ["events-appended"],
    });
    vi.advanceTimersByTime(50);

    expect(queryClient.getQueryState(threadSearchKey)?.isInvalidated).toBe(
      false,
    );

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: {
        eventTypes: ["item/completed", "turn/completed"],
        projectId: "project-1",
      },
      changes: ["events-appended"],
    });
    vi.advanceTimersByTime(50);

    expect(queryClient.getQueryState(threadSearchKey)?.isInvalidated).toBe(
      true,
    );

    effects.dispose();
  });

  it("refreshes an open search once per flush without aborting the request in flight, then once it settles", async () => {
    vi.useFakeTimers();
    const visibility = createFakeVisibility();
    const { effects, queryClient } =
      createRealtimeEffectsTestContext(visibility);
    const threadSearchKey = threadSearchQueryKey({
      limitPerGroup: 20,
      query: "needle",
    });
    const signals: AbortSignal[] = [];
    const resolveFetches: Array<(value: unknown) => void> = [];
    const searchQueryFn = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return new Promise((resolve) => {
        resolveFetches.push(resolve);
      });
    });
    const searchObserver = new QueryObserver(queryClient, {
      queryKey: threadSearchKey,
      queryFn: searchQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeSearch = searchObserver.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(searchQueryFn).toHaveBeenCalledTimes(1);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    visibility.setVisible(false);
    for (const threadId of ["thr_1", "thr_2"]) {
      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: threadId,
        metadata: { eventTypes: ["turn/completed"], projectId: "project-1" },
        changes: ["events-appended"],
      });
    }
    visibility.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);

    const searchInvalidations = invalidateSpy.mock.calls.filter(
      ([filters]) =>
        JSON.stringify(filters?.queryKey) ===
        JSON.stringify([threadSearchKey[0]]),
    );
    expect(searchInvalidations).toHaveLength(1);
    expect(searchInvalidations[0]?.[1]).toEqual({ cancelRefetch: false });
    expect(signals[0]?.aborted).toBe(false);
    expect(searchQueryFn).toHaveBeenCalledTimes(1);

    resolveFetches[0]?.({
      active: { results: [], total: 0 },
      archived: { results: [], total: 0 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(searchQueryFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(searchQueryFn).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(false);

    resolveFetches[1]?.({
      active: { results: [], total: 0 },
      archived: { results: [], total: 0 },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(searchQueryFn).toHaveBeenCalledTimes(2);

    invalidateSpy.mockRestore();
    unsubscribeSearch();
    effects.dispose();
  });

  it("refetches an in-flight search once it settles after a status change instead of aborting it", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const threadSearchKey = threadSearchQueryKey({
      limitPerGroup: 20,
      query: "needle",
    });
    const idleResponse = {
      active: { results: [{ id: "thr_1", status: "idle" }], total: 1 },
      archived: { results: [], total: 0 },
    };
    const activeResponse = {
      active: { results: [{ id: "thr_1", status: "active" }], total: 1 },
      archived: { results: [], total: 0 },
    };
    queryClient.setQueryData(threadSearchKey, idleResponse);
    const signals: AbortSignal[] = [];
    const resolveFetches: Array<(value: unknown) => void> = [];
    const searchQueryFn = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return new Promise((resolve) => {
        resolveFetches.push(resolve);
      });
    });
    const searchObserver = new QueryObserver(queryClient, {
      queryKey: threadSearchKey,
      queryFn: searchQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeSearch = searchObserver.subscribe(() => {});
    void searchObserver.refetch();
    await vi.advanceTimersByTimeAsync(0);
    expect(searchQueryFn).toHaveBeenCalledTimes(1);

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: {
        projectId: "project-1",
        statusChange: {
          activity: NO_THREAD_ACTIVITY,
          latestAttentionAt: 100,
          runtime: {
            displayStatus: "active",
            hostReconnectGraceExpiresAt: null,
          },
          status: "active",
          updatedAt: 200,
        },
      },
      changes: ["status-changed"],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(signals[0]?.aborted).toBe(false);
    expect(searchQueryFn).toHaveBeenCalledTimes(1);

    resolveFetches[0]?.(idleResponse);
    await vi.advanceTimersByTimeAsync(0);
    expect(queryClient.getQueryData(threadSearchKey)).toEqual(idleResponse);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(searchQueryFn).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(false);

    resolveFetches[1]?.(activeResponse);
    await vi.advanceTimersByTimeAsync(0);
    expect(queryClient.getQueryData(threadSearchKey)).toEqual(activeResponse);
    expect(queryClient.getQueryState(threadSearchKey)?.isInvalidated).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(searchQueryFn).toHaveBeenCalledTimes(2);

    unsubscribeSearch();
    effects.dispose();
  });

  it("marks the timeline of an unviewed thread stale without scheduling a refetch", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const viewedTimelineKey = threadTimelineQueryKey("thr_viewed");
    const unviewedTimelineKey = threadTimelineQueryKey("thr_unviewed");
    queryClient.setQueryData(unviewedTimelineKey, { rows: [] });
    const viewedTimelineQueryFn = vi.fn(async () => ({ rows: [] }));
    const viewedObserver = new QueryObserver(queryClient, {
      queryKey: viewedTimelineKey,
      queryFn: viewedTimelineQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeViewed = viewedObserver.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    viewedTimelineQueryFn.mockClear();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    for (const threadId of ["thr_viewed", "thr_unviewed"]) {
      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: threadId,
        metadata: { eventTypes: ["item/completed"], projectId: "project-1" },
        changes: ["events-appended"],
      });
    }
    await vi.advanceTimersByTimeAsync(50);

    expect(queryClient.getQueryState(unviewedTimelineKey)?.isInvalidated).toBe(
      true,
    );
    const unviewedInvalidations = invalidateSpy.mock.calls.filter(
      ([filters]) =>
        JSON.stringify(filters?.queryKey) ===
        JSON.stringify(threadTimelineQueryKeyPrefix("thr_unviewed")),
    );
    expect(unviewedInvalidations).toHaveLength(1);
    expect(unviewedInvalidations[0]?.[0]?.refetchType).toBe("none");
    const viewedInvalidations = invalidateSpy.mock.calls.filter(
      ([filters]) =>
        JSON.stringify(filters?.queryKey) ===
        JSON.stringify(threadTimelineQueryKeyPrefix("thr_viewed")),
    );
    expect(viewedInvalidations).toHaveLength(1);
    expect(viewedInvalidations[0]?.[0]?.refetchType).toBeUndefined();
    expect(viewedTimelineQueryFn).toHaveBeenCalledTimes(1);

    invalidateSpy.mockRestore();
    unsubscribeViewed();
    effects.dispose();
  });

  it("refreshes the full conversation outline once at turn completion, not for streaming deltas", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const threadId = "thr_outline";
    const timelineKey = threadTimelineQueryKey(threadId);
    const outlineKey = threadConversationOutlineQueryKey(threadId);
    const timelineQueryFn = vi.fn(async () => ({ rows: [] }));
    const outlineQueryFn = vi.fn(async () => ({ items: [], maxSeq: 1 }));
    const timelineObserver = new QueryObserver(queryClient, {
      queryKey: timelineKey,
      queryFn: timelineQueryFn,
      staleTime: Infinity,
    });
    const outlineObserver = new QueryObserver(queryClient, {
      queryKey: outlineKey,
      queryFn: outlineQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeTimeline = timelineObserver.subscribe(() => {});
    const unsubscribeOutline = outlineObserver.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    timelineQueryFn.mockClear();
    outlineQueryFn.mockClear();

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: threadId,
      metadata: {
        eventTypes: ["item/agentMessage/delta"],
        projectId: "project-1",
      },
      changes: ["events-appended"],
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(timelineQueryFn).toHaveBeenCalledTimes(1);
    expect(outlineQueryFn).not.toHaveBeenCalled();

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: threadId,
      metadata: {
        eventTypes: ["item/completed", "turn/completed"],
        projectId: "project-1",
      },
      changes: ["events-appended"],
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(timelineQueryFn).toHaveBeenCalledTimes(2);
    expect(outlineQueryFn).toHaveBeenCalledTimes(1);

    unsubscribeOutline();
    unsubscribeTimeline();
    effects.dispose();
  });

  it("marks archived thread lists stale without refetching them for status changes", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const activeListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    const archivedListKey = archivedThreadsListQueryKey({
      projectId: "project-1",
    });
    const globalArchivedListKey = archivedThreadsListQueryKey({});
    const activeListQueryFn = vi.fn(async () => []);
    const archivedListQueryFn = vi.fn(async () => []);
    const globalArchivedListQueryFn = vi.fn(async () => []);
    const observers = [
      new QueryObserver(queryClient, {
        queryKey: activeListKey,
        queryFn: activeListQueryFn,
        staleTime: Infinity,
      }),
      new QueryObserver(queryClient, {
        queryKey: archivedListKey,
        queryFn: archivedListQueryFn,
        staleTime: Infinity,
      }),
      new QueryObserver(queryClient, {
        queryKey: globalArchivedListKey,
        queryFn: globalArchivedListQueryFn,
        staleTime: Infinity,
      }),
    ];
    const unsubscribers = observers.map((observer) =>
      observer.subscribe(() => {}),
    );
    await vi.advanceTimersByTimeAsync(0);
    activeListQueryFn.mockClear();
    archivedListQueryFn.mockClear();
    globalArchivedListQueryFn.mockClear();

    for (const change of ["status-changed", "title-changed"] as const) {
      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thr_1",
        metadata: { projectId: "project-1" },
        changes: [change],
      });
      await vi.advanceTimersByTimeAsync(50);
    }

    expect(activeListQueryFn).toHaveBeenCalledTimes(2);
    expect(archivedListQueryFn).not.toHaveBeenCalled();
    expect(globalArchivedListQueryFn).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(archivedListKey)?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryState(globalArchivedListKey)?.isInvalidated,
    ).toBe(true);

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { projectId: "project-1" },
      changes: ["archived-changed"],
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(archivedListQueryFn).toHaveBeenCalledTimes(1);
    expect(globalArchivedListQueryFn).toHaveBeenCalledTimes(1);

    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    effects.dispose();
  });

  it.each(["thread detail", "sidebar navigation"] as const)(
    "refetches the active environment pull request from %s when a turn completes",
    async (cacheSource) => {
      vi.useFakeTimers();
      const { effects, queryClient } = createRealtimeEffectsTestContext();
      const pullRequestKey = environmentPullRequestQueryKey("env-1");
      const nextPullRequest = {
        outcome: "available",
        pullRequest: { number: 42 },
      };
      const pullRequestQueryFn = vi.fn(async () => nextPullRequest);
      if (cacheSource === "thread detail") {
        queryClient.setQueryData(threadQueryKey("thr_1"), {
          environmentId: "env-1",
          id: "thr_1",
        });
      } else {
        queryClient.setQueryData(sidebarNavigationQueryKey(), {
          personalProject: { threads: [] },
          projects: [
            {
              threads: [{ environmentId: "env-1", id: "thr_1" }],
            },
          ],
        });
      }
      queryClient.setQueryData(pullRequestKey, { outcome: "absent" });
      const pullRequestObserver = new QueryObserver(queryClient, {
        queryFn: pullRequestQueryFn,
        queryKey: pullRequestKey,
        staleTime: Infinity,
      });
      const unsubscribePullRequest = pullRequestObserver.subscribe(() => {});

      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thr_1",
        metadata: { eventTypes: ["turn/completed"] },
        changes: ["events-appended"],
      });
      await vi.advanceTimersByTimeAsync(50);

      expect(pullRequestQueryFn).toHaveBeenCalledTimes(1);
      expect(queryClient.getQueryData(pullRequestKey)).toEqual(nextPullRequest);

      unsubscribePullRequest();
      effects.dispose();
    },
  );

  it("invalidates cached thread search results when environment metadata changes", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const threadSearchKey = threadSearchQueryKey({
      limitPerGroup: 20,
      query: "branch-label",
    });
    queryClient.setQueryData(threadSearchKey, {
      active: { results: [], total: 0 },
      archived: { results: [], total: 0 },
    });

    effects.handleChanged({
      type: "changed",
      entity: "environment",
      id: "env_1",
      changes: ["metadata-changed"],
    });
    vi.advanceTimersByTime(250);

    expect(queryClient.getQueryState(threadSearchKey)?.isInvalidated).toBe(
      true,
    );

    effects.dispose();
  });

  it("refetches active root thread lists without refetching child lists for order changes", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const activeProjectThreadListKey = threadListQueryKey({
      projectId: "project-1",
      archived: false,
    });
    const rootThreadListKey = threadListQueryKey({
      projectId: "project-1",
      hasParent: false,
      archived: false,
    });
    const childThreadListKey = threadListQueryKey({
      projectId: "project-1",
      parentThreadId: "thr_1",
      archived: false,
    });
    const globalActiveThreadListKey = threadListQueryKey({
      archived: false,
    });
    const globalRootThreadListKey = threadListQueryKey({
      archived: false,
      hasParent: false,
    });
    const archivedThreadListKey = archivedThreadsListQueryKey({
      projectId: "project-1",
    });
    queryClient.setQueryData(activeProjectThreadListKey, []);
    queryClient.setQueryData(rootThreadListKey, []);
    queryClient.setQueryData(childThreadListKey, []);
    queryClient.setQueryData(globalActiveThreadListKey, []);
    queryClient.setQueryData(globalRootThreadListKey, []);
    queryClient.setQueryData(archivedThreadListKey, []);
    const activeProjectThreadListQueryFn = vi.fn(async () => []);
    const rootThreadListQueryFn = vi.fn(async () => []);
    const childThreadListQueryFn = vi.fn(async () => []);
    const globalActiveThreadListQueryFn = vi.fn(async () => []);
    const globalRootThreadListQueryFn = vi.fn(async () => []);
    const activeProjectThreadListObserver = new QueryObserver(queryClient, {
      queryKey: activeProjectThreadListKey,
      queryFn: activeProjectThreadListQueryFn,
      staleTime: Infinity,
    });
    const rootThreadListObserver = new QueryObserver(queryClient, {
      queryKey: rootThreadListKey,
      queryFn: rootThreadListQueryFn,
      staleTime: Infinity,
    });
    const childThreadListObserver = new QueryObserver(queryClient, {
      queryKey: childThreadListKey,
      queryFn: childThreadListQueryFn,
      staleTime: Infinity,
    });
    const globalActiveThreadListObserver = new QueryObserver(queryClient, {
      queryKey: globalActiveThreadListKey,
      queryFn: globalActiveThreadListQueryFn,
      staleTime: Infinity,
    });
    const globalRootThreadListObserver = new QueryObserver(queryClient, {
      queryKey: globalRootThreadListKey,
      queryFn: globalRootThreadListQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeActiveProjectThreadList =
      activeProjectThreadListObserver.subscribe(() => {});
    const unsubscribeRootThreadList = rootThreadListObserver.subscribe(
      () => {},
    );
    const unsubscribeChildThreadList = childThreadListObserver.subscribe(
      () => {},
    );
    const unsubscribeGlobalActiveThreadList =
      globalActiveThreadListObserver.subscribe(() => {});
    const unsubscribeGlobalRootThreadList =
      globalRootThreadListObserver.subscribe(() => {});
    activeProjectThreadListQueryFn.mockClear();
    rootThreadListQueryFn.mockClear();
    childThreadListQueryFn.mockClear();
    globalActiveThreadListQueryFn.mockClear();
    globalRootThreadListQueryFn.mockClear();

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { projectId: "project-1" },
      changes: ["order-changed"],
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(activeProjectThreadListQueryFn).toHaveBeenCalledTimes(1);
    expect(rootThreadListQueryFn).toHaveBeenCalledTimes(1);
    expect(globalActiveThreadListQueryFn).toHaveBeenCalledTimes(1);
    expect(globalRootThreadListQueryFn).toHaveBeenCalledTimes(1);
    expect(childThreadListQueryFn).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryState(archivedThreadListKey)?.isInvalidated,
    ).not.toBe(true);

    unsubscribeActiveProjectThreadList();
    unsubscribeRootThreadList();
    unsubscribeChildThreadList();
    unsubscribeGlobalActiveThreadList();
    unsubscribeGlobalRootThreadList();
    effects.dispose();
  });

  it("falls back to invalidating all cached thread lists when a thread list event has no project metadata", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const firstProjectThreadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    const secondProjectThreadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-2",
    });
    queryClient.setQueryData(firstProjectThreadListKey, []);
    queryClient.setQueryData(secondProjectThreadListKey, []);

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["title-changed"],
    });

    vi.advanceTimersByTime(50);

    expect(
      queryClient.getQueryState(firstProjectThreadListKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(secondProjectThreadListKey)?.isInvalidated,
    ).toBe(true);

    effects.dispose();
  });

  it.each(NON_PROJECT_PROMPT_HISTORY_THREAD_CHANGES)(
    "does not invalidate cached project prompt histories for %s thread events",
    (change) => {
      vi.useFakeTimers();
      const {
        effects,
        firstProjectHistoryKey,
        queryClient,
        secondProjectHistoryKey,
      } = createRealtimeEffectsTestContext();

      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thr_1",
        changes: [change],
      });

      vi.advanceTimersByTime(50);

      expect(
        queryClient.getQueryState(firstProjectHistoryKey)?.isInvalidated,
      ).not.toBe(true);
      expect(
        queryClient.getQueryState(secondProjectHistoryKey)?.isInvalidated,
      ).not.toBe(true);

      effects.dispose();
    },
  );

  it("does not refetch active thread queries for read-state changes", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const threadKey = threadQueryKey("thr_1");
    const threadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    const sidebarNavigationKey = sidebarNavigationQueryKey();
    queryClient.setQueryData(threadKey, { id: "thr_1" });
    queryClient.setQueryData(threadListKey, []);
    queryClient.setQueryData<CachedSidebarNavigationFixture>(
      sidebarNavigationKey,
      {
        projects: [{ threads: [] }],
        personalProject: { threads: [] },
      },
    );
    const threadQueryFn = vi.fn(async () => null);
    const threadListQueryFn = vi.fn(async () => []);
    const sidebarNavigationQueryFn = vi.fn(async () => ({
      projects: [],
      personalProject: { threads: [] },
    }));
    const threadObserver = new QueryObserver(queryClient, {
      queryKey: threadKey,
      queryFn: threadQueryFn,
      staleTime: Infinity,
    });
    const threadListObserver = new QueryObserver(queryClient, {
      queryKey: threadListKey,
      queryFn: threadListQueryFn,
      staleTime: Infinity,
    });
    const sidebarNavigationObserver = new QueryObserver(queryClient, {
      queryKey: sidebarNavigationKey,
      queryFn: sidebarNavigationQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeThread = threadObserver.subscribe(() => {});
    const unsubscribeThreadList = threadListObserver.subscribe(() => {});
    const unsubscribeSidebarNavigation = sidebarNavigationObserver.subscribe(
      () => {},
    );
    threadQueryFn.mockClear();
    threadListQueryFn.mockClear();
    sidebarNavigationQueryFn.mockClear();

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["read-state-changed"],
    });
    vi.advanceTimersByTime(50);

    expect(threadQueryFn).not.toHaveBeenCalled();
    expect(threadListQueryFn).not.toHaveBeenCalled();
    expect(sidebarNavigationQueryFn).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(threadKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(threadListKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(sidebarNavigationKey)?.isInvalidated).toBe(
      true,
    );

    unsubscribeThread();
    unsubscribeThreadList();
    unsubscribeSidebarNavigation();
    effects.dispose();
  });

  it("refetches the active diff TOC and work-status queries but evicts the observer-less patch cache for work-status changes", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const diffFilesKey = environmentDiffFilesQueryKey("env-1", "all", "main");
    const diffPatchKey = environmentDiffPatchQueryKey(
      "env-1",
      "all",
      "main",
      "file.ts",
    );
    const workStatusKey = environmentWorkStatusQueryKey("env-1", "main");
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
    queryClient.setQueryData(workStatusKey, null);
    const diffFilesQueryFn = vi.fn(async () => ({
      outcome: "available" as const,
      files: [],
      shortstat: "",
      mergeBaseRef: "base-ref",
    }));
    const workStatusQueryFn = vi.fn(async () => null);
    const diffFilesObserver = new QueryObserver(queryClient, {
      queryKey: diffFilesKey,
      queryFn: diffFilesQueryFn,
      staleTime: Infinity,
    });
    const workStatusObserver = new QueryObserver(queryClient, {
      queryKey: workStatusKey,
      queryFn: workStatusQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeDiffFiles = diffFilesObserver.subscribe(() => {});
    const unsubscribeWorkStatus = workStatusObserver.subscribe(() => {});
    diffFilesQueryFn.mockClear();
    workStatusQueryFn.mockClear();

    effects.handleChanged({
      type: "changed",
      entity: "environment",
      id: "env-1",
      changes: ["work-status-changed"],
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(diffFilesQueryFn).toHaveBeenCalledTimes(1);
    expect(workStatusQueryFn).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(diffPatchKey)).toBeUndefined();

    unsubscribeDiffFiles();
    unsubscribeWorkStatus();
    effects.dispose();
  });

  it("does not refetch the environment pull request for work-status changes", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const pullRequestKey = environmentPullRequestQueryKey("env-1");
    const pullRequestQueryFn = vi.fn(async () => ({ outcome: "absent" }));
    const pullRequestObserver = new QueryObserver(queryClient, {
      queryFn: pullRequestQueryFn,
      queryKey: pullRequestKey,
      staleTime: Infinity,
    });
    const unsubscribePullRequest = pullRequestObserver.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    pullRequestQueryFn.mockClear();

    effects.handleChanged({
      type: "changed",
      entity: "environment",
      id: "env-1",
      changes: ["work-status-changed"],
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(pullRequestQueryFn).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(pullRequestKey)?.isInvalidated).toBe(
      false,
    );

    unsubscribePullRequest();
    effects.dispose();
  });

  it("paces work-status refetches to one per second and never aborts the probe in flight", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const workStatusKey = environmentWorkStatusQueryKey("env-1", "main");
    const signals: AbortSignal[] = [];
    const resolveFetches: Array<(value: unknown) => void> = [];
    const workStatusQueryFn = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return new Promise((resolve) => {
        resolveFetches.push(resolve);
      });
    });
    const workStatusObserver = new QueryObserver(queryClient, {
      queryKey: workStatusKey,
      queryFn: workStatusQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeWorkStatus = workStatusObserver.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(workStatusQueryFn).toHaveBeenCalledTimes(1);
    resolveFetches[0]?.(null);
    await vi.advanceTimersByTimeAsync(0);

    const emitWorkStatusChanged = () => {
      effects.handleChanged({
        type: "changed",
        entity: "environment",
        id: "env-1",
        changes: ["work-status-changed"],
      });
    };

    emitWorkStatusChanged();
    await vi.advanceTimersByTimeAsync(250);
    expect(workStatusQueryFn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(50);
    emitWorkStatusChanged();
    await vi.advanceTimersByTimeAsync(300);
    emitWorkStatusChanged();
    await vi.advanceTimersByTimeAsync(300);
    expect(signals[1]?.aborted).toBe(false);
    expect(workStatusQueryFn).toHaveBeenCalledTimes(2);

    resolveFetches[1]?.(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(workStatusQueryFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(400);
    expect(workStatusQueryFn).toHaveBeenCalledTimes(3);
    resolveFetches[2]?.(null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(workStatusQueryFn).toHaveBeenCalledTimes(3);

    unsubscribeWorkStatus();
    effects.dispose();
  });

  it("refetches active thread storage preview queries for thread storage changes", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const threadKey = threadQueryKey("thr_1");
    const storagePreviewKey = threadStorageFilePreviewQueryKey(
      "thr_1",
      "notes.md",
    );
    const initialStoragePreview = {
      kind: "text",
      content: "old",
      mimeType: "text/plain",
      path: "notes.md",
      url: "/old",
    };
    const nextStoragePreview = {
      kind: "text",
      content: "new",
      mimeType: "text/plain",
      path: "notes.md",
      url: "/new",
    };
    queryClient.setQueryData(threadKey, {
      id: "thr_1",
      environmentId: "env-1",
    });
    queryClient.setQueryData(storagePreviewKey, initialStoragePreview);
    const storagePreviewQueryFn = vi.fn(async () => nextStoragePreview);
    const storagePreviewObserver = new QueryObserver(queryClient, {
      queryKey: storagePreviewKey,
      queryFn: storagePreviewQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeStoragePreview = storagePreviewObserver.subscribe(
      () => {},
    );
    storagePreviewQueryFn.mockClear();

    effects.handleChanged({
      type: "changed",
      entity: "environment",
      id: "env-1",
      changes: ["thread-storage-changed"],
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(storagePreviewQueryFn).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(storagePreviewKey)).toEqual(
      nextStoragePreview,
    );

    unsubscribeStoragePreview();
    effects.dispose();
  });

  it("refetches active thread storage preview queries when a thread environment changes", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const storagePreviewKey = threadStorageFilePreviewQueryKey(
      "thr_1",
      "notes.md",
    );
    const initialStoragePreview = {
      kind: "text",
      content: "old",
      mimeType: "text/plain",
      path: "notes.md",
      url: "/old",
    };
    const nextStoragePreview = {
      kind: "text",
      content: "new",
      mimeType: "text/plain",
      path: "notes.md",
      url: "/new",
    };
    queryClient.setQueryData(storagePreviewKey, initialStoragePreview);
    const storagePreviewQueryFn = vi.fn(async () => nextStoragePreview);
    const storagePreviewObserver = new QueryObserver(queryClient, {
      queryKey: storagePreviewKey,
      queryFn: storagePreviewQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeStoragePreview = storagePreviewObserver.subscribe(
      () => {},
    );
    storagePreviewQueryFn.mockClear();

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["environment-changed"],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(storagePreviewQueryFn).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(storagePreviewKey)).toEqual(
      nextStoragePreview,
    );

    unsubscribeStoragePreview();
    effects.dispose();
  });

  it("refetches active thread default execution options when a thread environment changes", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const defaultOptionsKey = threadDefaultExecutionOptionsQueryKey("thr_1");
    const initialDefaults = {
      model: "gpt-5",
      permissionMode: "auto",
      reasoningLevel: "medium",
      serviceTier: "default",
      source: "client/turn/requested",
    };
    const nextDefaults = {
      model: "gpt-5.5",
      permissionMode: "accept-edits",
      reasoningLevel: "high",
      serviceTier: "default",
      source: "client/turn/requested",
    };
    queryClient.setQueryData(defaultOptionsKey, initialDefaults);
    const defaultOptionsQueryFn = vi.fn(async () => nextDefaults);
    const defaultOptionsObserver = new QueryObserver(queryClient, {
      queryKey: defaultOptionsKey,
      queryFn: defaultOptionsQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeDefaultOptions = defaultOptionsObserver.subscribe(
      () => {},
    );
    defaultOptionsQueryFn.mockClear();

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["environment-changed"],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(defaultOptionsQueryFn).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(defaultOptionsKey)).toEqual(nextDefaults);

    unsubscribeDefaultOptions();
    effects.dispose();
  });

  it("does not invalidate timeline queries for status-only thread changes", () => {
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const timelineKey = threadTimelineQueryKey("thr_1");
    queryClient.setQueryData(timelineKey, {
      rows: [],
      timelinePage: {
        kind: "latest",
        topLevelLimit: 100,
        returnedOlderTopLevelRowCount: 0,
        hasOlderRows: false,
        olderCursor: null,
      },
    });

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { projectId: "project-1" },
      changes: ["status-changed"],
    });

    expect(queryClient.getQueryState(timelineKey)?.isInvalidated).not.toBe(
      true,
    );

    effects.dispose();
  });

  it("keeps timeline invalidations debounced when status-changed rides the same publish", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const threadKey = threadQueryKey("thr_1");
    const timelineKey = threadTimelineQueryKey("thr_1");
    queryClient.setQueryData(threadKey, { id: "thr_1" });
    queryClient.setQueryData(timelineKey, {
      rows: [],
      timelinePage: {
        kind: "latest",
        topLevelLimit: 100,
        returnedOlderTopLevelRowCount: 0,
        hasOlderRows: false,
        olderCursor: null,
      },
    });

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { projectId: "project-1" },
      changes: ["events-appended", "queue-changed", "status-changed"],
    });

    expect(queryClient.getQueryState(threadKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(timelineKey)?.isInvalidated).not.toBe(
      true,
    );

    vi.advanceTimersByTime(50);
    expect(queryClient.getQueryState(timelineKey)?.isInvalidated).toBe(true);

    effects.dispose();
  });

  it("leaves another thread's buffered invalidations debounced when a status flip flushes", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const streamingTimelineKey = threadTimelineQueryKey("thr_streaming");
    const flippedThreadKey = threadQueryKey("thr_flipped");
    queryClient.setQueryData(flippedThreadKey, { id: "thr_flipped" });
    queryClient.setQueryData(streamingTimelineKey, {
      rows: [],
      timelinePage: {
        kind: "latest",
        topLevelLimit: 100,
        returnedOlderTopLevelRowCount: 0,
        hasOlderRows: false,
        olderCursor: null,
      },
    });

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_streaming",
      metadata: { eventTypes: ["item/agentMessage/delta"] },
      changes: ["events-appended"],
    });
    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_flipped",
      changes: ["status-changed"],
    });

    expect(queryClient.getQueryState(flippedThreadKey)?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryState(streamingTimelineKey)?.isInvalidated,
    ).not.toBe(true);

    vi.advanceTimersByTime(50);
    expect(queryClient.getQueryState(streamingTimelineKey)?.isInvalidated).toBe(
      true,
    );

    effects.dispose();
  });

  it("applies an id-less immediate change with undefined metadata like the global flush path", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const projectAListKey = threadListQueryKey({
      archived: false,
      projectId: "project-a",
    });
    const projectBListKey = threadListQueryKey({
      archived: false,
      projectId: "project-b",
    });
    queryClient.setQueryData(projectAListKey, []);
    queryClient.setQueryData(projectBListKey, []);

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      metadata: { projectId: "project-a" },
      changes: ["status-changed"],
    });

    expect(queryClient.getQueryState(projectAListKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(projectBListKey)?.isInvalidated).toBe(
      true,
    );

    effects.dispose();
  });

  it("invalidates timeline but not thread detail or prompt history for non-turn-request events", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const threadKey = threadQueryKey("thr_1");
    const timelineKey = threadTimelineQueryKey("thr_1");
    const promptHistoryKey = threadPromptHistoryQueryKey("thr_1");
    const turnDetailsKey = threadTimelineTurnSummaryDetailsQueryKey({
      threadId: "thr_1",
      turnId: "turn_1",
      sourceSeqStart: 1,
      sourceSeqEnd: 5,
    });
    queryClient.setQueryData(threadKey, { id: "thr_1" });
    queryClient.setQueryData(promptHistoryKey, []);
    queryClient.setQueryData(turnDetailsKey, { rows: [] });
    queryClient.setQueryData(timelineKey, {
      rows: [],
      timelinePage: {
        kind: "latest",
        topLevelLimit: 100,
        returnedOlderTopLevelRowCount: 0,
        hasOlderRows: false,
        olderCursor: null,
      },
    });

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { eventTypes: ["system/error"], projectId: "project-1" },
      changes: ["events-appended"],
    });
    vi.advanceTimersByTime(50);

    expect(queryClient.getQueryState(timelineKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(threadKey)?.isInvalidated).not.toBe(true);
    expect(queryClient.getQueryState(promptHistoryKey)?.isInvalidated).not.toBe(
      true,
    );
    expect(queryClient.getQueryState(turnDetailsKey)?.isInvalidated).not.toBe(
      true,
    );

    effects.dispose();
  });

  it("invalidates thread detail when background activity starts or settles", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const threadKey = threadQueryKey("thr_1");
    queryClient.setQueryData(threadKey, {
      activeBackgroundAgentCount: 0,
      id: "thr_1",
    });

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: {
        backgroundActivityChanged: true,
        eventTypes: ["item/started"],
        projectId: "project-1",
      },
      changes: ["events-appended"],
    });
    vi.advanceTimersByTime(50);

    expect(queryClient.getQueryState(threadKey)?.isInvalidated).toBe(true);

    queryClient.setQueryData(threadKey, {
      activeBackgroundAgentCount: 1,
      id: "thr_1",
    });
    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: {
        backgroundActivityChanged: true,
        eventTypes: ["item/completed"],
        projectId: "project-1",
      },
      changes: ["events-appended"],
    });
    vi.advanceTimersByTime(50);

    expect(queryClient.getQueryState(threadKey)?.isInvalidated).toBe(true);

    effects.dispose();
  });

  it("does not cancel active timeline refetches for repeated event invalidations", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const timelineKey = threadTimelineQueryKey("thr_1");
    const signals: AbortSignal[] = [];
    const resolveFetches: Array<(value: unknown) => void> = [];
    const timelineQueryFn = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return new Promise((resolve) => {
        resolveFetches.push(resolve);
      });
    });
    const timelineObserver = new QueryObserver(queryClient, {
      queryKey: timelineKey,
      queryFn: timelineQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeTimeline = timelineObserver.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(timelineQueryFn).toHaveBeenCalledTimes(1);

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { eventTypes: ["system/error"], projectId: "project-1" },
      changes: ["events-appended"],
    });
    await vi.advanceTimersByTimeAsync(50);
    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { eventTypes: ["item/completed"], projectId: "project-1" },
      changes: ["events-appended"],
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(signals[0]?.aborted).toBe(false);
    expect(timelineQueryFn).toHaveBeenCalledTimes(1);

    resolveFetches[0]?.({
      rows: [],
      timelinePage: {
        kind: "latest",
        topLevelLimit: 100,
        returnedOlderTopLevelRowCount: 0,
        hasOlderRows: false,
        olderCursor: null,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(timelineQueryFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);

    expect(timelineQueryFn).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(false);
    resolveFetches[1]?.({
      rows: [],
      timelinePage: {
        kind: "latest",
        topLevelLimit: 100,
        returnedOlderTopLevelRowCount: 0,
        hasOlderRows: false,
        olderCursor: null,
      },
    });

    unsubscribeTimeline();
    effects.dispose();
  });

  it("supersedes an in-flight timeline read when a turn completes", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const timelineKey = threadTimelineQueryKey("thr_1");
    const signals: AbortSignal[] = [];
    const resolveFetches: Array<(value: unknown) => void> = [];
    const timelineQueryFn = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return new Promise((resolve) => {
        resolveFetches.push(resolve);
      });
    });
    const timelineObserver = new QueryObserver(queryClient, {
      queryKey: timelineKey,
      queryFn: timelineQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeTimeline = timelineObserver.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(timelineQueryFn).toHaveBeenCalledTimes(1);

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { eventTypes: ["item/agentMessage/delta"] },
      changes: ["events-appended"],
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(signals[0]?.aborted).toBe(false);

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { eventTypes: ["turn/completed"] },
      changes: ["events-appended"],
    });
    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["status-changed"],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(signals[0]?.aborted).toBe(true);
    expect(timelineQueryFn).toHaveBeenCalledTimes(2);

    resolveFetches[1]?.({
      rows: [],
      timelinePage: {
        kind: "latest",
        topLevelLimit: 100,
        returnedOlderTopLevelRowCount: 0,
        hasOlderRows: false,
        olderCursor: null,
      },
    });
    await vi.advanceTimersByTimeAsync(1_500);

    expect(timelineQueryFn).toHaveBeenCalledTimes(2);

    unsubscribeTimeline();
    effects.dispose();
  });

  it("invalidates thread prompt history when a batched appended event includes a turn request", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const promptHistoryKey = threadPromptHistoryQueryKey("thr_1");
    queryClient.setQueryData(promptHistoryKey, []);

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { eventTypes: ["client/turn/requested"] },
      changes: ["events-appended"],
    });
    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { eventTypes: ["system/error"] },
      changes: ["events-appended"],
    });
    vi.advanceTimersByTime(50);

    expect(queryClient.getQueryState(promptHistoryKey)?.isInvalidated).toBe(
      true,
    );

    effects.dispose();
  });

  it("invalidates queued messages and prompt history but not thread detail for queue changes", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const threadKey = threadQueryKey("thr_1");
    const queuedMessagesKey = threadQueuedMessagesQueryKey("thr_1");
    const promptHistoryKey = threadPromptHistoryQueryKey("thr_1");
    queryClient.setQueryData(threadKey, { id: "thr_1" });
    queryClient.setQueryData(queuedMessagesKey, []);
    queryClient.setQueryData(promptHistoryKey, []);

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { projectId: "project-1" },
      changes: ["queue-changed"],
    });
    vi.advanceTimersByTime(50);

    expect(queryClient.getQueryState(queuedMessagesKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(promptHistoryKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(threadKey)?.isInvalidated).not.toBe(true);

    effects.dispose();
  });

  it("uses thread project metadata to mark only affected project thread lists stale for read-state changes", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const firstProjectThreadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    const secondProjectThreadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-2",
    });
    queryClient.setQueryData(firstProjectThreadListKey, []);
    queryClient.setQueryData(secondProjectThreadListKey, []);
    const firstProjectThreadListQueryFn = vi.fn(async () => []);
    const secondProjectThreadListQueryFn = vi.fn(async () => []);
    const firstProjectThreadListObserver = new QueryObserver(queryClient, {
      queryKey: firstProjectThreadListKey,
      queryFn: firstProjectThreadListQueryFn,
      staleTime: Infinity,
    });
    const secondProjectThreadListObserver = new QueryObserver(queryClient, {
      queryKey: secondProjectThreadListKey,
      queryFn: secondProjectThreadListQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeFirstProjectThreadList =
      firstProjectThreadListObserver.subscribe(() => {});
    const unsubscribeSecondProjectThreadList =
      secondProjectThreadListObserver.subscribe(() => {});
    firstProjectThreadListQueryFn.mockClear();
    secondProjectThreadListQueryFn.mockClear();

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { projectId: "project-1" },
      changes: ["read-state-changed"],
    });
    vi.advanceTimersByTime(50);

    expect(firstProjectThreadListQueryFn).not.toHaveBeenCalled();
    expect(secondProjectThreadListQueryFn).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryState(firstProjectThreadListKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(secondProjectThreadListKey)?.isInvalidated,
    ).not.toBe(true);

    unsubscribeFirstProjectThreadList();
    unsubscribeSecondProjectThreadList();
    effects.dispose();
  });

  it("patches cached thread list pending interaction state from notification metadata", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const threadKey = threadQueryKey("thr_1");
    const timelineKey = threadTimelineQueryKey("thr_1");
    const threadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    const sidebarNavigationKey = sidebarNavigationQueryKey();
    queryClient.setQueryData(threadKey, { id: "thr_1" });
    queryClient.setQueryData(timelineKey, {
      rows: [],
      timelinePage: {
        kind: "latest",
        topLevelLimit: 100,
        returnedOlderTopLevelRowCount: 0,
        hasOlderRows: false,
        olderCursor: null,
      },
    });
    queryClient.setQueryData<CachedThreadListEntryFixture[]>(threadListKey, [
      { hasPendingInteraction: false, id: "thr_1" },
    ]);
    queryClient.setQueryData<CachedSidebarNavigationFixture>(
      sidebarNavigationKey,
      {
        projects: [
          { threads: [{ hasPendingInteraction: false, id: "thr_1" }] },
        ],
        personalProject: { threads: [] },
      },
    );

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { hasPendingInteraction: true, projectId: "project-1" },
      changes: ["interactions-changed"],
    });
    vi.advanceTimersByTime(50);

    expect(
      queryClient
        .getQueryData<CachedThreadListEntryFixture[]>(threadListKey)
        ?.at(0)?.hasPendingInteraction,
    ).toBe(true);
    expect(
      queryClient
        .getQueryData<CachedSidebarNavigationFixture>(sidebarNavigationKey)
        ?.projects.at(0)
        ?.threads.at(0)?.hasPendingInteraction,
    ).toBe(true);
    expect(queryClient.getQueryState(threadKey)?.isInvalidated).not.toBe(true);
    expect(queryClient.getQueryState(timelineKey)?.isInvalidated).not.toBe(
      true,
    );

    effects.dispose();
  });

  it("patches cached thread list status from notification metadata instead of refetching the sidebar bootstrap", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const threadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    const sidebarNavigationKey = sidebarNavigationQueryKey();
    const idleRow = {
      activity: NO_THREAD_ACTIVITY,
      id: "thr_1",
      latestAttentionAt: 100,
      runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
      status: "idle",
      updatedAt: 100,
    };
    const otherRow = {
      activity: NO_THREAD_ACTIVITY,
      id: "thr_2",
      latestAttentionAt: 50,
      runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
      status: "idle",
      updatedAt: 50,
    };
    const threadListQueryFn = vi.fn(async () => [idleRow, otherRow]);
    const sidebarQueryFn = vi.fn(async () => ({
      projects: [{ threads: [idleRow, otherRow] }],
      personalProject: { threads: [] },
    }));
    const observers = [
      new QueryObserver(queryClient, {
        queryKey: threadListKey,
        queryFn: threadListQueryFn,
        staleTime: Infinity,
      }),
      new QueryObserver(queryClient, {
        queryKey: sidebarNavigationKey,
        queryFn: sidebarQueryFn,
        staleTime: Infinity,
      }),
    ];
    const unsubscribers = observers.map((observer) =>
      observer.subscribe(() => {}),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(sidebarQueryFn).toHaveBeenCalledTimes(1);
    expect(threadListQueryFn).toHaveBeenCalledTimes(1);

    const statusChange = {
      activity: { ...NO_THREAD_ACTIVITY, activePlanModeCount: 1 },
      latestAttentionAt: 100,
      runtime: {
        displayStatus: "active",
        hostReconnectGraceExpiresAt: null,
      },
      status: "active",
      updatedAt: 200,
    } as const;
    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { projectId: "project-1", statusChange },
      changes: ["status-changed"],
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(sidebarQueryFn).toHaveBeenCalledTimes(1);
    expect(threadListQueryFn).toHaveBeenCalledTimes(1);
    expect(
      queryClient.getQueryState(sidebarNavigationKey)?.isInvalidated,
    ).not.toBe(true);
    const sidebarThreads = queryClient.getQueryData<{
      projects: { threads: (typeof idleRow)[] }[];
    }>(sidebarNavigationKey)?.projects[0]?.threads;
    expect(sidebarThreads?.[0]).toEqual({ id: "thr_1", ...statusChange });
    expect(sidebarThreads?.[1]).toBe(otherRow);
    expect(
      queryClient.getQueryData<(typeof idleRow)[]>(threadListKey)?.[0],
    ).toEqual({ id: "thr_1", ...statusChange });

    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    effects.dispose();
  });

  it("refetches thread lists for a status change that carries no row metadata", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const sidebarNavigationKey = sidebarNavigationQueryKey();
    const sidebarQueryFn = vi.fn(async () => ({
      projects: [{ threads: [{ id: "thr_1", status: "idle" }] }],
      personalProject: { threads: [] },
    }));
    const observer = new QueryObserver(queryClient, {
      queryKey: sidebarNavigationKey,
      queryFn: sidebarQueryFn,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(sidebarQueryFn).toHaveBeenCalledTimes(1);

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { projectId: "project-1" },
      changes: ["status-changed"],
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(sidebarQueryFn).toHaveBeenCalledTimes(2);

    unsubscribe();
    effects.dispose();
  });

  it("throttles the metadata-less status fallback to one active refetch per second", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const sidebarNavigationKey = sidebarNavigationQueryKey();
    const sidebarQueryFn = vi.fn(async () => ({
      projects: [{ threads: [{ id: "thr_1", status: "idle" }] }],
      personalProject: { threads: [] },
    }));
    const observer = new QueryObserver(queryClient, {
      queryKey: sidebarNavigationKey,
      queryFn: sidebarQueryFn,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(sidebarQueryFn).toHaveBeenCalledTimes(1);

    const emitBareStatusChange = () => {
      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thr_1",
        metadata: { projectId: "project-1" },
        changes: ["status-changed"],
      });
    };

    emitBareStatusChange();
    await vi.advanceTimersByTimeAsync(0);
    expect(sidebarQueryFn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(100);
    emitBareStatusChange();
    await vi.advanceTimersByTimeAsync(100);
    expect(sidebarQueryFn).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryState(sidebarNavigationKey)?.isInvalidated).toBe(
      true,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sidebarQueryFn).toHaveBeenCalledTimes(3);

    unsubscribe();
    effects.dispose();
  });

  it("refetches a project list and its forks list once each for a bare status change", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const projectListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    const forksListKey = threadListQueryKey({
      archived: false,
      originKind: "fork",
      projectId: "project-1",
      sourceThreadId: "thr_1",
    });
    const createListQueryFn = () =>
      vi.fn(
        () =>
          new Promise<unknown[]>((resolve) => {
            setTimeout(() => resolve([]), 20);
          }),
      );
    const projectQueryFn = createListQueryFn();
    const forksQueryFn = createListQueryFn();
    const projectObserver = new QueryObserver(queryClient, {
      queryKey: projectListKey,
      queryFn: projectQueryFn,
      staleTime: Infinity,
    });
    const forksObserver = new QueryObserver(queryClient, {
      queryKey: forksListKey,
      queryFn: forksQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeProject = projectObserver.subscribe(() => {});
    const unsubscribeForks = forksObserver.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(20);
    expect(projectQueryFn).toHaveBeenCalledTimes(1);
    expect(forksQueryFn).toHaveBeenCalledTimes(1);

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_2",
      metadata: { projectId: "project-1" },
      changes: ["status-changed"],
    });
    await vi.advanceTimersByTimeAsync(1_500);

    expect(projectQueryFn).toHaveBeenCalledTimes(2);
    expect(forksQueryFn).toHaveBeenCalledTimes(2);

    unsubscribeProject();
    unsubscribeForks();
    effects.dispose();
  });

  it("refetches over a patched row when a bare status-changed arrives while visible", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const sidebarNavigationKey = sidebarNavigationQueryKey();
    const idleRow = {
      activity: NO_THREAD_ACTIVITY,
      id: "thr_1",
      latestAttentionAt: 100,
      runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
      status: "idle",
      updatedAt: 100,
    };
    const stoppedRow = { ...idleRow, updatedAt: 300 };
    let serverRow = idleRow;
    const sidebarQueryFn = vi.fn(async () => ({
      projects: [{ threads: [serverRow] }],
      personalProject: { threads: [] },
    }));
    const observer = new QueryObserver(queryClient, {
      queryKey: sidebarNavigationKey,
      queryFn: sidebarQueryFn,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(sidebarQueryFn).toHaveBeenCalledTimes(1);

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: {
        projectId: "project-1",
        statusChange: {
          activity: NO_THREAD_ACTIVITY,
          latestAttentionAt: 100,
          runtime: {
            displayStatus: "active",
            hostReconnectGraceExpiresAt: null,
          },
          status: "active",
          updatedAt: 200,
        },
      },
      changes: ["status-changed"],
    });

    expect(sidebarQueryFn).toHaveBeenCalledTimes(1);
    expect(
      queryClient.getQueryData<{
        projects: { threads: (typeof idleRow)[] }[];
      }>(sidebarNavigationKey)?.projects[0]?.threads[0]?.status,
    ).toBe("active");

    serverRow = stoppedRow;
    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["status-changed"],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(sidebarQueryFn).toHaveBeenCalledTimes(2);
    expect(
      queryClient.getQueryData<{
        projects: { threads: (typeof idleRow)[] }[];
      }>(sidebarNavigationKey)?.projects[0]?.threads[0],
    ).toEqual(stoppedRow);

    unsubscribe();
    effects.dispose();
  });

  it("restarts a sidebar fetch already in flight so its stale snapshot cannot overwrite the patched status", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const sidebarNavigationKey = sidebarNavigationQueryKey();
    const idleRow = {
      activity: NO_THREAD_ACTIVITY,
      id: "thr_1",
      latestAttentionAt: 100,
      runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
      status: "idle",
      updatedAt: 100,
    };
    const activeRow = {
      ...idleRow,
      runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
      status: "active",
      updatedAt: 200,
    };
    let activated = false;
    const responses: { activated: boolean; resolve: () => void }[] = [];
    const sidebarQueryFn = vi.fn(
      () =>
        new Promise<{
          projects: { threads: (typeof idleRow)[] }[];
          personalProject: { threads: never[] };
        }>((resolve) => {
          const snapshot = activated ? activeRow : idleRow;
          responses.push({
            activated,
            resolve: () =>
              resolve({
                projects: [{ threads: [snapshot] }],
                personalProject: { threads: [] },
              }),
          });
        }),
    );
    const observer = new QueryObserver(queryClient, {
      queryKey: sidebarNavigationKey,
      queryFn: sidebarQueryFn,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    responses.shift()?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(sidebarQueryFn).toHaveBeenCalledTimes(1);

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { projectId: "project-1" },
      changes: ["title-changed"],
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(sidebarQueryFn).toHaveBeenCalledTimes(2);
    const staleResponse = responses.shift();

    activated = true;
    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: {
        projectId: "project-1",
        statusChange: {
          activity: NO_THREAD_ACTIVITY,
          latestAttentionAt: 100,
          runtime: {
            displayStatus: "active",
            hostReconnectGraceExpiresAt: null,
          },
          status: "active",
          updatedAt: 200,
        },
      },
      changes: ["status-changed"],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(sidebarQueryFn).toHaveBeenCalledTimes(3);
    staleResponse?.resolve();
    responses.shift()?.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(
      queryClient.getQueryData<{
        projects: { threads: (typeof idleRow)[] }[];
      }>(sidebarNavigationKey)?.projects[0]?.threads[0]?.status,
    ).toBe("active");

    unsubscribe();
    effects.dispose();
  });

  it("invalidates thread list and detail but not timeline for parent changes", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const threadKey = threadQueryKey("thr_1");
    const timelineKey = threadTimelineQueryKey("thr_1");
    const firstProjectThreadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    const secondProjectThreadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-2",
    });
    queryClient.setQueryData(threadKey, { id: "thr_1" });
    queryClient.setQueryData(firstProjectThreadListKey, []);
    queryClient.setQueryData(secondProjectThreadListKey, []);
    queryClient.setQueryData(timelineKey, {
      rows: [],
      timelinePage: {
        kind: "latest",
        topLevelLimit: 100,
        returnedOlderTopLevelRowCount: 0,
        hasOlderRows: false,
        olderCursor: null,
      },
    });

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      metadata: { projectId: "project-1" },
      changes: ["parent-changed"],
    });
    vi.advanceTimersByTime(50);

    expect(queryClient.getQueryState(threadKey)?.isInvalidated).toBe(true);
    expect(
      queryClient.getQueryState(firstProjectThreadListKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(secondProjectThreadListKey)?.isInvalidated,
    ).not.toBe(true);
    expect(queryClient.getQueryState(timelineKey)?.isInvalidated).not.toBe(
      true,
    );

    effects.dispose();
  });

  it("invalidates cached project prompt history only for the changed project on project threads-changed events", () => {
    const {
      effects,
      firstProjectHistoryKey,
      queryClient,
      secondProjectHistoryKey,
    } = createRealtimeEffectsTestContext();

    effects.handleChanged({
      type: "changed",
      entity: "project",
      id: "project-1",
      changes: ["threads-changed"],
    });

    expect(
      queryClient.getQueryState(firstProjectHistoryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(secondProjectHistoryKey)?.isInvalidated,
    ).not.toBe(true);

    effects.dispose();
  });

  it("falls back to invalidating all cached project prompt histories when a project threads-changed event has no id", () => {
    const {
      effects,
      firstProjectHistoryKey,
      queryClient,
      secondProjectHistoryKey,
    } = createRealtimeEffectsTestContext();

    effects.handleChanged({
      type: "changed",
      entity: "project",
      changes: ["threads-changed"],
    });

    expect(
      queryClient.getQueryState(firstProjectHistoryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(secondProjectHistoryKey)?.isInvalidated,
    ).toBe(true);

    effects.dispose();
  });

  it("invalidates project source dependent queries for the changed project", () => {
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const projectsKey = projectsQueryKey();
    const localPathKey = hostPathExistenceQueryKey("host-1", [
      "/workspace/project",
    ]);
    const firstProjectPathsKey = projectPathsQueryKey(
      "project-1",
      null,
      "host-1",
      "",
      20,
      true,
      true,
    );
    const secondProjectPathsKey = projectPathsQueryKey(
      "project-2",
      null,
      "host-2",
      "",
      20,
      true,
      true,
    );
    const firstProjectSourceBranchesKey = projectSourceBranchesQueryKey(
      "project-1",
      "host-1",
    );
    const secondProjectSourceBranchesKey = projectSourceBranchesQueryKey(
      "project-2",
      "host-1",
    );
    queryClient.setQueryData(projectsKey, []);
    queryClient.setQueryData(localPathKey, []);
    queryClient.setQueryData(firstProjectPathsKey, []);
    queryClient.setQueryData(secondProjectPathsKey, []);
    queryClient.setQueryData(firstProjectSourceBranchesKey, []);
    queryClient.setQueryData(secondProjectSourceBranchesKey, []);

    effects.handleChanged({
      type: "changed",
      entity: "project",
      id: "project-1",
      changes: ["project-sources-changed"],
    });

    expect(queryClient.getQueryState(projectsKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(localPathKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(firstProjectPathsKey)?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryState(firstProjectSourceBranchesKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(secondProjectPathsKey)?.isInvalidated,
    ).not.toBe(true);
    expect(
      queryClient.getQueryState(secondProjectSourceBranchesKey)?.isInvalidated,
    ).not.toBe(true);

    effects.dispose();
  });

  it("invalidates cached thread terminals for terminal changes", () => {
    vi.useFakeTimers();
    const { effects, queryClient, terminalKey } =
      createRealtimeEffectsTestContext();

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["terminals-changed"],
    });

    expect(queryClient.getQueryState(terminalKey)?.isInvalidated).not.toBe(
      true,
    );

    vi.advanceTimersByTime(50);

    expect(queryClient.getQueryState(terminalKey)?.isInvalidated).toBe(true);

    effects.dispose();
  });

  it("keeps the fine-pointer cadence and widens it for coarse pointers", () => {
    expect(resolveThreadInvalidationDebounce(false)).toEqual({
      debounceMs: 50,
      maxWaitMs: 200,
    });
    expect(resolveThreadInvalidationDebounce(true)).toEqual({
      debounceMs: 150,
      maxWaitMs: 400,
    });
  });

  it("applies the reconnect watermark from the connected event", () => {
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const disconnectedAt = Date.now();
    const staleKey = threadQueryKey("thr_stale");
    const freshKey = threadQueryKey("thr_fresh");
    queryClient.setQueryData(
      staleKey,
      { id: "thr_stale" },
      { updatedAt: disconnectedAt - 1 },
    );
    queryClient.setQueryData(
      freshKey,
      { id: "thr_fresh" },
      { updatedAt: disconnectedAt + 1 },
    );

    effects.handleConnected({ reconnected: true, disconnectedAt });

    expect(queryClient.getQueryState(staleKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(freshKey)?.isInvalidated).toBe(false);
    effects.dispose();
  });

  describe("while the document is hidden", () => {
    it("merges thread changes and flushes them once on visible", () => {
      vi.useFakeTimers();
      const visibility = createFakeVisibility();
      const { effects, queryClient } =
        createRealtimeEffectsTestContext(visibility);
      const threadKey = threadQueryKey("thr_1");
      const timelineKey = threadTimelineQueryKey("thr_1");
      const sidebarNavigationKey = sidebarNavigationQueryKey();
      queryClient.setQueryData(threadKey, { id: "thr_1" });
      queryClient.setQueryData(timelineKey, { rows: [] });
      queryClient.setQueryData<CachedSidebarNavigationFixture>(
        sidebarNavigationKey,
        { projects: [], personalProject: { threads: [] } },
      );

      visibility.setVisible(false);
      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thr_1",
        changes: ["status-changed"],
      });
      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thr_1",
        changes: ["events-appended"],
      });
      vi.advanceTimersByTime(1000);

      expect(queryClient.getQueryState(threadKey)?.isInvalidated).toBe(false);
      expect(queryClient.getQueryState(timelineKey)?.isInvalidated).toBe(false);
      expect(
        queryClient.getQueryState(sidebarNavigationKey)?.isInvalidated,
      ).toBe(false);

      visibility.setVisible(true);

      expect(queryClient.getQueryState(threadKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(timelineKey)?.isInvalidated).toBe(true);
      expect(
        queryClient.getQueryState(sidebarNavigationKey)?.isInvalidated,
      ).toBe(true);
      effects.dispose();
    });

    it("refetches when a bare status-changed follows one that carried the row", () => {
      vi.useFakeTimers();
      const visibility = createFakeVisibility();
      const { effects, queryClient } =
        createRealtimeEffectsTestContext(visibility);
      const sidebarNavigationKey = sidebarNavigationQueryKey();
      const idleRow = {
        activity: NO_THREAD_ACTIVITY,
        id: "thr_1",
        latestAttentionAt: 100,
        runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
        status: "idle",
        updatedAt: 100,
      };
      queryClient.setQueryData(sidebarNavigationKey, {
        projects: [{ threads: [idleRow] }],
        personalProject: { threads: [] },
      });

      visibility.setVisible(false);
      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thr_1",
        metadata: {
          projectId: "project-1",
          statusChange: {
            activity: NO_THREAD_ACTIVITY,
            latestAttentionAt: 100,
            runtime: {
              displayStatus: "active",
              hostReconnectGraceExpiresAt: null,
            },
            status: "active",
            updatedAt: 200,
          },
        },
        changes: ["status-changed"],
      });
      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thr_1",
        changes: ["status-changed"],
      });
      visibility.setVisible(true);

      expect(
        queryClient.getQueryData<{
          projects: { threads: (typeof idleRow)[] }[];
        }>(sidebarNavigationKey)?.projects[0]?.threads[0],
      ).toBe(idleRow);
      expect(
        queryClient.getQueryState(sidebarNavigationKey)?.isInvalidated,
      ).toBe(true);
      effects.dispose();
    });

    it("holds a debounce that elapses hidden and non-thread changes until visible", async () => {
      vi.useFakeTimers();
      const visibility = createFakeVisibility();
      const { effects, queryClient } =
        createRealtimeEffectsTestContext(visibility);
      const timelineKey = threadTimelineQueryKey("thr_1");
      const workStatusKey = environmentWorkStatusQueryKey("env-1", "main");
      const projectsKey = projectsQueryKey();
      const configKey = systemConfigQueryKey();
      queryClient.setQueryData(timelineKey, { rows: [] });
      queryClient.setQueryData(workStatusKey, null);
      queryClient.setQueryData(projectsKey, []);
      queryClient.setQueryData(configKey, {});

      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thr_1",
        changes: ["events-appended"],
      });
      visibility.setVisible(false);
      vi.advanceTimersByTime(250);
      effects.handleChanged({
        type: "changed",
        entity: "environment",
        id: "env-1",
        changes: ["work-status-changed"],
      });
      effects.handleChanged({
        type: "changed",
        entity: "host",
        changes: ["host-connected"],
      });
      effects.handleChanged({
        type: "changed",
        entity: "system",
        changes: ["config-changed"],
      });
      await vi.advanceTimersByTimeAsync(1000);

      expect(queryClient.getQueryState(timelineKey)?.isInvalidated).toBe(false);
      expect(queryClient.getQueryState(workStatusKey)?.isInvalidated).toBe(
        false,
      );
      expect(queryClient.getQueryState(projectsKey)?.isInvalidated).toBe(false);
      expect(queryClient.getQueryState(configKey)?.isInvalidated).toBe(false);

      visibility.setVisible(true);
      await vi.advanceTimersByTimeAsync(250);

      expect(queryClient.getQueryState(timelineKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(workStatusKey)?.isInvalidated).toBe(
        true,
      );
      expect(queryClient.getQueryState(projectsKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(configKey)?.isInvalidated).toBe(true);
      effects.dispose();
    });
  });
});
