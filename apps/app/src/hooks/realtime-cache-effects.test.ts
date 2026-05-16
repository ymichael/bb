import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import {
  ENVIRONMENT_CHANGE_KINDS,
  HOST_CHANGE_KINDS,
  PROJECT_CHANGE_KINDS,
  THREAD_CHANGE_KINDS,
} from "@bb/domain";
import { createAppQueryClient } from "@/lib/query-client";
import {
  archivedThreadsListQueryKey,
  environmentGitDiffQueryKey,
  environmentWorkStatusQueryKey,
  localPathExistenceQueryKey,
  projectFilesQueryKey,
  projectGithubBranchesQueryKey,
  projectPromptHistoryQueryKey,
  projectSourceBranchesQueryKey,
  projectsQueryKey,
  threadQueuedMessagesQueryKey,
  threadListQueryKey,
  threadPromptHistoryQueryKey,
  threadQueryKey,
  threadTerminalsQueryKey,
  threadTimelineQueryKey,
} from "./queries/query-keys";
import { createRealtimeCacheEffects } from "./realtime-cache-effects";
import {
  REALTIME_ENVIRONMENT_CHANGE_REGISTRY,
  REALTIME_HOST_CHANGE_REGISTRY,
  REALTIME_PROJECT_CHANGE_REGISTRY,
  REALTIME_THREAD_CHANGE_REGISTRY,
} from "./realtime-cache-registry";

const PROJECT_PROMPT_HISTORY_THREAD_CHANGES = [
  "thread-created",
  "thread-deleted",
  "archived-changed",
] as const;
const NON_PROJECT_PROMPT_HISTORY_THREAD_CHANGES = [
  "manager-assignment-changed",
  "parent-changed",
  "read-state-changed",
  "title-changed",
] as const;

interface CachedThreadListEntryFixture {
  hasPendingInteraction: boolean;
  id: string;
}

function createRealtimeEffectsTestContext() {
  const queryClient = createAppQueryClient({
    defaultOptions: {
      queries: {
        gcTime: Infinity,
        retry: false,
      },
    },
    showMutationErrorToasts: false,
  });
  const effects = createRealtimeCacheEffects({ queryClient });
  const firstProjectHistoryKey = projectPromptHistoryQueryKey("project-1");
  const secondProjectHistoryKey = projectPromptHistoryQueryKey("project-2");
  const terminalKey = threadTerminalsQueryKey("thr_1");

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

  it("uses thread project metadata to invalidate only cached thread lists for the affected project", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const firstProjectThreadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    const firstProjectArchivedThreadListKey = archivedThreadsListQueryKey({
      kind: "all",
      projectId: "project-1",
    });
    const secondProjectThreadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-2",
    });
    queryClient.setQueryData(firstProjectThreadListKey, []);
    queryClient.setQueryData(firstProjectArchivedThreadListKey, []);
    queryClient.setQueryData(secondProjectThreadListKey, []);

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
      queryClient.getQueryState(secondProjectThreadListKey)?.isInvalidated,
    ).not.toBe(true);

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
    queryClient.setQueryData(threadKey, { id: "thr_1" });
    queryClient.setQueryData(threadListKey, []);
    const threadQueryFn = vi.fn(async () => null);
    const threadListQueryFn = vi.fn(async () => []);
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
    const unsubscribeThread = threadObserver.subscribe(() => {});
    const unsubscribeThreadList = threadListObserver.subscribe(() => {});
    threadQueryFn.mockClear();
    threadListQueryFn.mockClear();

    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_1",
      changes: ["read-state-changed"],
    });
    vi.advanceTimersByTime(50);

    expect(threadQueryFn).not.toHaveBeenCalled();
    expect(threadListQueryFn).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(threadKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(threadListKey)?.isInvalidated).toBe(true);

    unsubscribeThread();
    unsubscribeThreadList();
    effects.dispose();
  });

  it("does not refetch active git diff queries for work-status changes", async () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const gitDiffKey = environmentGitDiffQueryKey("env-1", "all", "main");
    const workStatusKey = environmentWorkStatusQueryKey("env-1", "main");
    queryClient.setQueryData(gitDiffKey, {
      diff: "diff --git a/file.ts b/file.ts\n",
      files: "M\tfile.ts\n",
      mergeBaseRef: "base-ref",
      shortstat: "1 file changed",
      truncated: false,
    });
    queryClient.setQueryData(workStatusKey, null);
    const gitDiffQueryFn = vi.fn(async () => ({
      diff: "",
      files: "",
      mergeBaseRef: "base-ref",
      shortstat: "",
      truncated: false,
    }));
    const workStatusQueryFn = vi.fn(async () => null);
    const gitDiffObserver = new QueryObserver(queryClient, {
      queryKey: gitDiffKey,
      queryFn: gitDiffQueryFn,
      staleTime: Infinity,
    });
    const workStatusObserver = new QueryObserver(queryClient, {
      queryKey: workStatusKey,
      queryFn: workStatusQueryFn,
      staleTime: Infinity,
    });
    const unsubscribeGitDiff = gitDiffObserver.subscribe(() => {});
    const unsubscribeWorkStatus = workStatusObserver.subscribe(() => {});
    gitDiffQueryFn.mockClear();
    workStatusQueryFn.mockClear();

    effects.handleChanged({
      type: "changed",
      entity: "environment",
      id: "env-1",
      changes: ["work-status-changed"],
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(gitDiffQueryFn).not.toHaveBeenCalled();
    expect(workStatusQueryFn).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(gitDiffKey)?.isInvalidated).toBe(true);

    unsubscribeGitDiff();
    unsubscribeWorkStatus();
    effects.dispose();
  });

  it("does not invalidate timeline queries for status-only thread changes", () => {
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const timelineKey = threadTimelineQueryKey("thr_1", undefined);
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

  it("invalidates timeline but not thread detail or prompt history for non-turn-request events", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const threadKey = threadQueryKey("thr_1");
    const timelineKey = threadTimelineQueryKey("thr_1", undefined);
    const promptHistoryKey = threadPromptHistoryQueryKey("thr_1");
    queryClient.setQueryData(threadKey, { id: "thr_1" });
    queryClient.setQueryData(promptHistoryKey, []);
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
    const timelineKey = threadTimelineQueryKey("thr_1", undefined);
    const threadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
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
    expect(queryClient.getQueryState(threadKey)?.isInvalidated).not.toBe(true);
    expect(queryClient.getQueryState(timelineKey)?.isInvalidated).not.toBe(
      true,
    );

    effects.dispose();
  });

  it("invalidates thread list and detail but not timeline for manager assignment changes", () => {
    vi.useFakeTimers();
    const { effects, queryClient } = createRealtimeEffectsTestContext();
    const threadKey = threadQueryKey("thr_1");
    const timelineKey = threadTimelineQueryKey("thr_1", undefined);
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
      changes: ["manager-assignment-changed"],
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
    const localPathKey = localPathExistenceQueryKey("host-1", [
      "/workspace/project",
    ]);
    const firstProjectFilesKey = projectFilesQueryKey(
      "project-1",
      "",
      20,
      null,
    );
    const secondProjectFilesKey = projectFilesQueryKey(
      "project-2",
      "",
      20,
      null,
    );
    const firstProjectSourceBranchesKey = projectSourceBranchesQueryKey(
      "project-1",
      "host-1",
    );
    const secondProjectSourceBranchesKey = projectSourceBranchesQueryKey(
      "project-2",
      "host-1",
    );
    const firstProjectGithubBranchesKey =
      projectGithubBranchesQueryKey("project-1");
    const secondProjectGithubBranchesKey =
      projectGithubBranchesQueryKey("project-2");
    queryClient.setQueryData(projectsKey, []);
    queryClient.setQueryData(localPathKey, []);
    queryClient.setQueryData(firstProjectFilesKey, []);
    queryClient.setQueryData(secondProjectFilesKey, []);
    queryClient.setQueryData(firstProjectSourceBranchesKey, []);
    queryClient.setQueryData(secondProjectSourceBranchesKey, []);
    queryClient.setQueryData(firstProjectGithubBranchesKey, []);
    queryClient.setQueryData(secondProjectGithubBranchesKey, []);

    effects.handleChanged({
      type: "changed",
      entity: "project",
      id: "project-1",
      changes: ["project-sources-changed"],
    });

    expect(queryClient.getQueryState(projectsKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(localPathKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(firstProjectFilesKey)?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryState(firstProjectSourceBranchesKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(firstProjectGithubBranchesKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(secondProjectFilesKey)?.isInvalidated,
    ).not.toBe(true);
    expect(
      queryClient.getQueryState(secondProjectSourceBranchesKey)?.isInvalidated,
    ).not.toBe(true);
    expect(
      queryClient.getQueryState(secondProjectGithubBranchesKey)?.isInvalidated,
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
});
