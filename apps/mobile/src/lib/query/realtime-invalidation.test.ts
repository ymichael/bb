import { QueryClient, hashKey } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSocketFactory } from "../realtime/fake-socket";
import { createMobileRealtime } from "../realtime/mobile-realtime";
import {
  getDiffPatchEvictionGeneration,
  readDiffPatchEntry,
  writeDiffPatchEntry,
} from "./diff-patch-cache";
import {
  installRealtimeInvalidation,
  queryKeysForChangedMessage,
  threadPullRequestQueryKeysForCompletedTurn,
  timelineInvalidationPolicyForMessage,
} from "./realtime-invalidation";
import {
  allEnvironmentWorkStatusQueryKeyPrefix,
  allProjectDefaultExecutionOptionsQueryKeyPrefix,
  allProjectPathsQueryKeyPrefix,
  allProjectSourceBranchesQueryKeyPrefix,
  allSystemExecutionOptionsQueryKeyPrefix,
  allSystemProvidersQueryKeyPrefix,
  environmentMergeBaseBranchesQueryKeyPrefix,
  environmentPullRequestQueryKey,
  environmentQueryKey,
  environmentsQueryKey,
  environmentWorkStatusQueryKeyPrefix,
  projectsQueryKey,
  sidebarNavigationQueryKey,
  systemConfigQueryKey,
  threadDefaultExecutionOptionsQueryKey,
  threadDetailBootstrapQueryKey,
  threadPendingInteractionsQueryKey,
  threadQueryKey,
  threadSearchQueryKeyPrefix,
  threadTimelineQueryKey,
  threadTimelineTurnSummaryDetailsQueryKeyPrefix,
  threadsQueryKey,
  allPluginCatalogSearchQueryKeyPrefix,
  allProjectSkillsQueryKeyPrefix,
  pluginMarketplacesQueryKey,
  pluginsQueryKey,
  pluginUpdatesQueryKey,
  themeCatalogQueryKey,
} from "./query-keys";

function setup() {
  const factory = createFakeSocketFactory();
  const realtime = createMobileRealtime({
    url: "ws://x/ws",
    socketFactory: factory,
    onInvalidMessage: () => {},
  });
  const queryClient = new QueryClient();
  const invalidated: string[] = [];
  const invalidateSpy = vi
    .spyOn(queryClient, "invalidateQueries")
    .mockImplementation(async (filters) => {
      invalidated.push(filters?.queryKey ? hashKey(filters.queryKey) : "*");
    });
  const handle = installRealtimeInvalidation(queryClient, realtime);
  realtime.connect();
  factory.latest().open();
  return { factory, realtime, queryClient, invalidated, invalidateSpy, handle };
}

describe("installRealtimeInvalidation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst of thread frames into one invalidation per key", () => {
    const { factory, invalidated } = setup();
    const socket = factory.latest();
    for (let i = 0; i < 20; i++) {
      socket.receive(
        JSON.stringify({
          type: "changed",
          entity: "thread",
          id: "t1",
          changes: ["events-appended"],
        }),
      );
      vi.advanceTimersByTime(10);
    }
    expect(invalidated).toEqual([hashKey(threadTimelineQueryKey("t1"))]);
    vi.advanceTimersByTime(500);
    expect(invalidated).toHaveLength(1);
    expect(invalidated).not.toContain(hashKey(threadQueryKey("t1")));
    expect(invalidated).not.toContain(hashKey(threadsQueryKey()));

    socket.receive(
      JSON.stringify({
        type: "changed",
        entity: "thread",
        id: "t2",
        changes: ["title-changed"],
      }),
    );
    vi.advanceTimersByTime(49);
    expect(invalidated).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(invalidated.slice(1)).toEqual([
      hashKey(threadQueryKey("t2")),
      hashKey(threadsQueryKey()),
      hashKey(sidebarNavigationQueryKey()),
      hashKey(threadSearchQueryKeyPrefix()),
    ]);
  });

  it("catches up from the reconnect watermark: only data older than the disconnect is invalidated, without cancelling in-flight fetches", () => {
    vi.setSystemTime(1_000_000);
    const { factory, queryClient, invalidateSpy } = setup();
    invalidateSpy.mockRestore();
    queryClient.setQueryData(threadQueryKey("stale"), { id: "stale" });
    const staleQuery = queryClient.getQueryCache().find({
      queryKey: threadQueryKey("stale"),
    });
    vi.advanceTimersByTime(10_000);
    factory.latest().drop();
    const disconnectedAt = Date.now();
    vi.advanceTimersByTime(500);
    queryClient.setQueryData(threadQueryKey("fresh"), { id: "fresh" });
    const freshQuery = queryClient.getQueryCache().find({
      queryKey: threadQueryKey("fresh"),
    });
    const spy = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockImplementation(async () => {});
    vi.advanceTimersByTime(500);
    factory.latest().open();

    expect(spy).toHaveBeenCalledTimes(1);
    const [filters, options] = spy.mock.calls[0] ?? [];
    expect(options).toEqual({ cancelRefetch: false });
    expect(filters?.queryKey).toBeUndefined();
    const predicate = filters?.predicate;
    if (!predicate || !staleQuery || !freshQuery) throw new Error("setup");
    expect(staleQuery.state.dataUpdatedAt).toBeLessThan(disconnectedAt);
    expect(freshQuery.state.dataUpdatedAt).toBeGreaterThan(disconnectedAt);
    expect(predicate(staleQuery)).toBe(true);
    expect(predicate(freshQuery)).toBe(false);
  });

  it("does not invalidate on the initial connect", () => {
    const { invalidated } = setup();
    vi.advanceTimersByTime(500);
    expect(invalidated).toEqual([]);
  });

  it("evicts the observer-less diff patch cache on a resume reconnect, before the watermark catch-up", () => {
    const factory = createFakeSocketFactory();
    const realtime = createMobileRealtime({
      url: "ws://x/ws",
      socketFactory: factory,
      onInvalidMessage: () => {},
    });
    const queryClient = new QueryClient();
    const order: string[] = [];
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(async () => {
      order.push("invalidate");
    });
    const removeQueries = queryClient.removeQueries.bind(queryClient);
    vi.spyOn(queryClient, "removeQueries").mockImplementation((filters) => {
      order.push(`remove:${String(filters?.queryKey?.[0])}`);
      removeQueries(filters);
    });
    const identity = {
      environmentId: "env_1",
      targetType: "all",
      targetKey: "main",
    };
    const entry = { path: "a.ts", patch: "old", truncated: false };
    writeDiffPatchEntry(queryClient, identity, entry);
    const handle = installRealtimeInvalidation(queryClient, realtime);
    realtime.connect();
    factory.latest().open();
    expect(readDiffPatchEntry(queryClient, identity, "a.ts")).toEqual(entry);
    expect(getDiffPatchEvictionGeneration(queryClient, "env_1")).toBe(0);
    expect(order).toEqual([]);

    realtime.suspend();
    realtime.resume();
    factory.latest().open();
    expect(readDiffPatchEntry(queryClient, identity, "a.ts")).toBeUndefined();
    expect(getDiffPatchEvictionGeneration(queryClient, "env_1")).toBe(1);
    expect(order).toEqual(["remove:environmentDiffPatch", "invalidate"]);
    handle.dispose();
  });

  it("keeps pending fine-grained work across a resume reconnect and adds the watermark catch-up", () => {
    const { factory, realtime, invalidated } = setup();
    factory.latest().receive(
      JSON.stringify({
        type: "changed",
        entity: "system",
        changes: ["config-changed"],
      }),
    );
    realtime.suspend();
    realtime.resume();
    factory.latest().open();
    vi.advanceTimersByTime(500);
    expect(invalidated).toEqual(
      expect.arrayContaining(["*", hashKey(systemConfigQueryKey())]),
    );
  });

  it("stops invalidating after dispose", () => {
    const { factory, invalidated, handle } = setup();
    handle.dispose();
    factory.latest().receive(
      JSON.stringify({
        type: "changed",
        entity: "system",
        changes: ["config-changed"],
      }),
    );
    vi.advanceTimersByTime(500);
    expect(invalidated).toEqual([]);
  });
});

describe("queryKeysForChangedMessage", () => {
  it("maps thread change kinds to detail keys and, when the list can change, list keys", () => {
    expect(
      queryKeysForChangedMessage({
        type: "changed",
        entity: "thread",
        id: "t1",
        changes: ["interactions-changed", "history-rewritten"],
      }),
    ).toEqual([
      threadQueryKey("t1"),
      threadTimelineQueryKey("t1"),
      threadDetailBootstrapQueryKey("t1"),
      threadTimelineTurnSummaryDetailsQueryKeyPrefix("t1"),
      threadPendingInteractionsQueryKey("t1"),
      threadDefaultExecutionOptionsQueryKey("t1"),
      threadsQueryKey(),
      sidebarNavigationQueryKey(),
      threadSearchQueryKeyPrefix(),
    ]);
    expect(
      queryKeysForChangedMessage({
        type: "changed",
        entity: "thread",
        changes: ["order-changed"],
      }),
    ).toEqual([
      threadsQueryKey(),
      sidebarNavigationQueryKey(),
      threadSearchQueryKeyPrefix(),
    ]);
  });

  it("leaves the thread record alone for pure streaming batches but refetches it for background-activity and record changes", () => {
    expect(
      queryKeysForChangedMessage({
        type: "changed",
        entity: "thread",
        id: "t1",
        changes: ["events-appended"],
        metadata: { eventTypes: ["item/agentMessage/delta"] },
      }),
    ).toEqual([threadTimelineQueryKey("t1")]);
    expect(
      queryKeysForChangedMessage({
        type: "changed",
        entity: "thread",
        id: "t1",
        changes: ["events-appended"],
        metadata: { eventTypes: ["turn/completed"] },
      }),
    ).not.toContainEqual(threadQueryKey("t1"));
    expect(
      queryKeysForChangedMessage({
        type: "changed",
        entity: "thread",
        id: "t1",
        changes: ["events-appended"],
        metadata: { backgroundActivityChanged: true },
      }),
    ).toEqual([threadQueryKey("t1"), threadTimelineQueryKey("t1")]);
    expect(
      queryKeysForChangedMessage({
        type: "changed",
        entity: "thread",
        id: "t1",
        changes: ["status-changed"],
      }),
    ).toContainEqual(threadQueryKey("t1"));
  });

  it("maps system changes to config plus provider/default keys for settings and plugin changes", () => {
    expect(
      queryKeysForChangedMessage({
        type: "changed",
        entity: "system",
        changes: ["config-changed"],
      }),
    ).toEqual([
      systemConfigQueryKey(),
      allSystemProvidersQueryKeyPrefix(),
      allSystemExecutionOptionsQueryKeyPrefix(),
      allProjectDefaultExecutionOptionsQueryKeyPrefix(),
      themeCatalogQueryKey(),
    ]);
    expect(
      queryKeysForChangedMessage({
        type: "changed",
        entity: "system",
        changes: ["provider-registrations-changed"],
      }),
    ).toHaveLength(4);
  });

  it("maps plugins-changed onto the plugin management views and the skills library", () => {
    const keys = queryKeysForChangedMessage({
      type: "changed",
      entity: "system",
      changes: ["plugins-changed"],
    });
    expect(keys).toEqual(
      expect.arrayContaining([
        pluginsQueryKey(),
        pluginUpdatesQueryKey(),
        allPluginCatalogSearchQueryKeyPrefix(),
        allProjectSkillsQueryKeyPrefix(),
      ]),
    );
    expect(keys).not.toContainEqual(pluginMarketplacesQueryKey());
  });

  it("maps environment metadata changes onto the thread lists that project environment labels", () => {
    const statusKeys = queryKeysForChangedMessage({
      type: "changed",
      entity: "environment",
      id: "env_1",
      changes: ["status-changed"],
    });
    expect(statusKeys).toEqual(
      expect.arrayContaining([
        environmentsQueryKey(),
        environmentQueryKey("env_1"),
        environmentWorkStatusQueryKeyPrefix("env_1"),
        environmentPullRequestQueryKey("env_1"),
        environmentMergeBaseBranchesQueryKeyPrefix("env_1"),
      ]),
    );
    expect(
      queryKeysForChangedMessage({
        type: "changed",
        entity: "environment",
        id: "env_1",
        changes: ["metadata-changed"],
      }),
    ).toContainEqual(sidebarNavigationQueryKey());
  });

  it("keeps file-watcher work-status changes off the environment record and branch list", () => {
    const workStatusKeys = queryKeysForChangedMessage({
      type: "changed",
      entity: "environment",
      id: "env_1",
      changes: ["work-status-changed"],
    });
    expect(workStatusKeys).toContainEqual(
      environmentWorkStatusQueryKeyPrefix("env_1"),
    );
    expect(workStatusKeys).not.toContainEqual(environmentQueryKey("env_1"));
    expect(workStatusKeys).not.toContainEqual(
      environmentMergeBaseBranchesQueryKeyPrefix("env_1"),
    );
    expect(workStatusKeys).not.toContainEqual(
      environmentPullRequestQueryKey("env_1"),
    );
    const refKeys = queryKeysForChangedMessage({
      type: "changed",
      entity: "environment",
      id: "env_1",
      changes: ["git-refs-changed", "work-status-changed"],
    });
    expect(refKeys).toContainEqual(
      environmentMergeBaseBranchesQueryKeyPrefix("env_1"),
    );
    expect(refKeys).not.toContainEqual(environmentPullRequestQueryKey("env_1"));
    expect(
      queryKeysForChangedMessage({
        type: "changed",
        entity: "environment",
        changes: ["work-status-changed"],
      }),
    ).toContainEqual(allEnvironmentWorkStatusQueryKeyPrefix());
  });

  it("maps project source changes onto the source-dependent pickers", () => {
    expect(
      queryKeysForChangedMessage({
        type: "changed",
        entity: "project",
        id: "p1",
        changes: ["project-updated"],
      }),
    ).toEqual([
      projectsQueryKey(),
      threadsQueryKey(),
      sidebarNavigationQueryKey(),
      threadSearchQueryKeyPrefix(),
    ]);
    const keys = queryKeysForChangedMessage({
      type: "changed",
      entity: "project",
      id: "p1",
      changes: ["project-sources-changed"],
    });
    expect(keys).toContainEqual(allProjectPathsQueryKeyPrefix());
    expect(keys).toContainEqual(allProjectSourceBranchesQueryKeyPrefix());
    expect(keys).toContainEqual(
      allProjectDefaultExecutionOptionsQueryKeyPrefix(),
    );
  });
});

describe("threadPullRequestQueryKeysForCompletedTurn", () => {
  const completed = {
    type: "changed",
    entity: "thread",
    id: "t1",
    changes: ["events-appended"],
    metadata: { eventTypes: ["item/completed", "turn/completed"] },
  } as const;

  it("refetches the PR of the thread's cached environment when a turn completes", () => {
    const queryClient = new QueryClient();
    expect(
      threadPullRequestQueryKeysForCompletedTurn(queryClient, completed),
    ).toEqual([]);
    queryClient.setQueryData(threadQueryKey("t1"), {
      id: "t1",
      environmentId: "env_1",
    });
    expect(
      threadPullRequestQueryKeysForCompletedTurn(queryClient, completed),
    ).toEqual([environmentPullRequestQueryKey("env_1")]);
    expect(
      threadPullRequestQueryKeysForCompletedTurn(queryClient, {
        ...completed,
        metadata: { eventTypes: ["item/agentMessage/delta"] },
      }),
    ).toEqual([]);
    queryClient.setQueryData(threadQueryKey("t1"), {
      id: "t1",
      environmentId: null,
    });
    expect(
      threadPullRequestQueryKeysForCompletedTurn(queryClient, completed),
    ).toEqual([]);
  });

  it("falls back to the sidebar bootstrap when the thread record is not cached", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(sidebarNavigationQueryKey(), {
      sections: [],
      projects: [{ id: "p1", threads: [{ id: "t1", environmentId: "env_2" }] }],
      personalProject: { id: "personal", threads: [] },
    });
    expect(
      threadPullRequestQueryKeysForCompletedTurn(queryClient, completed),
    ).toEqual([environmentPullRequestQueryKey("env_2")]);
  });

  it("is applied by the realtime bridge on the completed-turn flush", () => {
    vi.useFakeTimers();
    const { factory, queryClient, invalidated } = setup();
    queryClient.setQueryData(threadQueryKey("t1"), {
      id: "t1",
      environmentId: "env_1",
    });
    factory.latest().receive(JSON.stringify(completed));
    vi.advanceTimersByTime(250);
    expect(invalidated).toContain(
      hashKey(environmentPullRequestQueryKey("env_1")),
    );
    vi.useRealTimers();
  });
});

describe("timelineInvalidationPolicyForMessage", () => {
  it("paces plain appends, treats turn completion as terminal, and defaults rewrites", () => {
    expect(
      timelineInvalidationPolicyForMessage({
        type: "changed",
        entity: "thread",
        id: "t1",
        changes: ["events-appended"],
        metadata: { eventTypes: ["item/agentMessage/delta"] },
      }),
    ).toBe("timeline-paced");
    expect(
      timelineInvalidationPolicyForMessage({
        type: "changed",
        entity: "thread",
        id: "t1",
        changes: ["events-appended"],
        metadata: { eventTypes: ["item/completed", "turn/completed"] },
      }),
    ).toBe("timeline-terminal");
    expect(
      timelineInvalidationPolicyForMessage({
        type: "changed",
        entity: "thread",
        id: "t1",
        changes: ["events-appended", "history-rewritten"],
      }),
    ).toBe("default");
  });

  it("applies the paced path without cancelling the active timeline read", async () => {
    vi.useFakeTimers();
    const { factory, queryClient, invalidateSpy } = setup();
    factory.latest().receive(
      JSON.stringify({
        type: "changed",
        entity: "thread",
        id: "t1",
        changes: ["events-appended"],
        metadata: {
          eventTypes: ["item/agentMessage/delta"],
          backgroundActivityChanged: true,
        },
      }),
    );
    vi.advanceTimersByTime(250);
    await Promise.resolve();
    const timelineCall = invalidateSpy.mock.calls.find(
      ([filters]) =>
        filters?.queryKey !== undefined &&
        hashKey(filters.queryKey) === hashKey(threadTimelineQueryKey("t1")),
    );
    expect(timelineCall?.[1]).toEqual({ cancelRefetch: false });
    const threadCall = invalidateSpy.mock.calls.find(
      ([filters]) =>
        filters?.queryKey !== undefined &&
        hashKey(filters.queryKey) === hashKey(threadQueryKey("t1")),
    );
    expect(threadCall).toBeDefined();
    expect(threadCall?.[1]).toBeUndefined();
    void queryClient;
    vi.useRealTimers();
  });
});
