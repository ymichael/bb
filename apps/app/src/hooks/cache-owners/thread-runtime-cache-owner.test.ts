import type { ThreadListEntry, ThreadQueuedMessage } from "@bb/domain";
import type {
  SidebarBootstrapResponse,
  ThreadSearchResponse,
  ThreadTimelineResponse,
} from "@bb/server-contract";
import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import {
  makeThreadListEntry as makeThreadListEntryFixture,
  makeThreadQueuedMessage as makeThreadQueuedMessageFixture,
} from "@bb/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { makeThreadTimelineResponse as makeTimelineResponse } from "@/test/fixtures/thread-responses";
import {
  sidebarNavigationQueryKey,
  threadListQueryKey,
  threadPromptHistoryQueryKey,
  threadQueryKey,
  threadQueuedMessagesQueryKey,
  threadSearchQueryKey,
  threadTimelineQueryKey,
} from "../queries/query-keys";
import { threadDefaultExecutionOptionsQueryKey } from "../queries/thread-default-execution-options-query";
import {
  applyQueuedMessageCreateResult,
  applyQueuedMessageSendResult,
  applyQueuedMessageUpdateResult,
  applySendThreadMessageSuccess,
  applyThreadGoalClearResult,
  applyThreadPlanCancellationResult,
  beginCreateQueuedMessageTransaction,
  beginRemoveQueuedMessageTransaction,
  beginReorderQueuedMessageTransaction,
  beginSendQueuedMessageTransaction,
  beginSendThreadMessageTransaction,
  beginUpdateQueuedMessageTransaction,
  rollbackCreateQueuedMessageTransaction,
  rollbackRemoveQueuedMessageTransaction,
  rollbackSendThreadMessageTransaction,
  rollbackUpdateQueuedMessageTransaction,
} from "./thread-runtime-cache-owner";

function makeThreadListEntry(id = "thread-1"): ThreadListEntry {
  return makeThreadListEntryFixture({
    id,
    projectId: "project-1",
    environmentId: "env-1",
    status: "active",
    lastReadAt: null,
    latestAttentionAt: 50,
    createdAt: 1,
    updatedAt: 1,
    runtime: {
      displayStatus: "active",
      hostReconnectGraceExpiresAt: null,
    },
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 1,
      activeGoalCount: 1,
    },
    environmentHostId: "host-1",
    environmentName: "Environment",
    environmentBranchName: "main",
    environmentWorkspaceDisplayKind: "managed-worktree",
  });
}

function makeSidebarNavigation(
  threads: ThreadListEntry[],
): SidebarBootstrapResponse {
  return makeSidebarBootstrapResponse({
    projects: [
      makeProjectWithThreadsResponse({
        id: "project-1",
        name: "Project",
        createdAt: 1,
        updatedAt: 1,
        threads,
      }),
    ],
  });
}

function makeSearchResponse(thread: ThreadListEntry): ThreadSearchResponse {
  return {
    active: {
      total: 1,
      results: [{ thread, matches: [] }],
    },
    archived: { total: 0, results: [] },
  };
}

function makeQueuedMessage(
  message: Partial<ThreadQueuedMessage> = {},
): ThreadQueuedMessage {
  return makeThreadQueuedMessageFixture({
    id: "qmsg-1",
    threadId: "thread-1",
    model: "codex-test",
    createdAt: 1,
    updatedAt: 1,
    ...message,
  });
}

describe("thread runtime cache owner", () => {
  it.each([
    ["Plan", applyThreadPlanCancellationResult, "activePlanModeCount"],
    ["Goal", applyThreadGoalClearResult, "activeGoalCount"],
  ] as const)(
    "reconciles authoritative %s cancellation across banner caches while preserving independent state",
    (label, applyResult, clearedCount) => {
      const queryClient = createAppQueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
        showMutationErrorToasts: false,
      });
      const thread = makeThreadListEntry();
      const listKey = threadListQueryKey({
        archived: false,
        projectId: "project-1",
      });
      const secondListKey = threadListQueryKey({
        archived: false,
        projectId: undefined,
      });
      const searchKey = threadSearchQueryKey({
        query: "work",
        limitPerGroup: 20,
      });
      queryClient.setQueryData(listKey, [thread]);
      queryClient.setQueryData(secondListKey, [thread]);
      queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        makeSidebarNavigation([thread]),
      );
      queryClient.setQueryData(searchKey, makeSearchResponse(thread));
      queryClient.setQueryData(threadTimelineQueryKey("thread-1"), {
        ...makeTimelineResponse(),
        activePromptMode: {
          mode: "plan",
          providerId: "codex",
          prompt: "Plan the work",
        },
        goal: {
          sourceSeq: 1,
          updatedAt: 100,
          objective: "Finish the work",
          status: "active",
          tokenBudget: null,
          tokensUsed: 100,
          timeUsedSeconds: 10,
        },
      });

      applyResult({ queryClient, threadId: "thread-1" });

      const timeline = queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1"),
      );
      if (label === "Plan") {
        expect(timeline?.activePromptMode).toBeNull();
        expect(timeline?.goal).toMatchObject({ objective: "Finish the work" });
      } else {
        expect(timeline?.activePromptMode).toMatchObject({ mode: "plan" });
        expect(timeline?.goal).toBeNull();
      }

      const listEntries = [listKey, secondListKey].map(
        (queryKey) =>
          queryClient.getQueryData<ThreadListEntry[]>(queryKey)?.[0],
      );
      const sidebarEntry = queryClient.getQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
      )?.projects[0]?.threads[0];
      const searchEntry =
        queryClient.getQueryData<ThreadSearchResponse>(searchKey)?.active
          .results[0]?.thread;

      for (const entry of [...listEntries, sidebarEntry, searchEntry]) {
        expect(entry?.activity[clearedCount]).toBe(0);
        expect(
          entry?.activity[
            clearedCount === "activePlanModeCount"
              ? "activeGoalCount"
              : "activePlanModeCount"
          ],
        ).toBe(1);
      }
    },
  );

  it("omits agent-only text from optimistic user messages", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );

    await beginSendThreadMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        mode: "auto",
        input: [
          {
            type: "text",
            text: "Hidden source context",
            mentions: [],
            visibility: "agent-only",
          },
          {
            type: "text",
            text: "Visible question",
            mentions: [],
          },
        ],
      },
    });

    const timeline = queryClient.getQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1"),
    );
    expect(timeline?.rows).toHaveLength(1);
    expect(timeline?.rows[0]).toMatchObject({
      kind: "conversation",
      role: "user",
      text: "Visible question",
    });
  });

  it("optimistically appends queued messages and replaces them with the server row", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      makeQueuedMessage({ id: "qmsg-existing" }),
    ]);
    queryClient.setQueryData(
      threadDefaultExecutionOptionsQueryKey("thread-1"),
      {
        model: "codex-default",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
        serviceTier: "fast",
      },
    );
    queryClient.setQueryData(threadPromptHistoryQueryKey("thread-1"), []);

    const transaction = await beginCreateQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        input: [{ type: "text", text: "Queue this", mentions: [] }],
      },
    });

    const optimisticQueue = queryClient.getQueryData<ThreadQueuedMessage[]>(
      threadQueuedMessagesQueryKey("thread-1"),
    );
    expect(optimisticQueue).toHaveLength(2);
    expect(optimisticQueue?.[1]).toMatchObject({
      id: expect.stringMatching(/^optimistic-queued-/u),
      content: [{ type: "text", text: "Queue this", mentions: [] }],
      model: "codex-default",
      reasoningLevel: "high",
      permissionMode: "accept-edits",
      serviceTier: "fast",
    });

    const serverQueuedMessage = makeQueuedMessage({
      id: "qmsg-server",
      content: [{ type: "text", text: "Queue this", mentions: [] }],
      createdAt: 10,
      updatedAt: 10,
    });
    applyQueuedMessageCreateResult({
      queryClient,
      queuedMessage: serverQueuedMessage,
      threadId: "thread-1",
      transaction,
    });

    expect(
      queryClient
        .getQueryData<ThreadQueuedMessage[]>(
          threadQueuedMessagesQueryKey("thread-1"),
        )
        ?.map((queuedMessage) => queuedMessage.id),
    ).toEqual(["qmsg-existing", "qmsg-server"]);
    expect(
      queryClient.getQueryData(threadPromptHistoryQueryKey("thread-1")),
    ).toEqual([
      {
        id: "queued-message:qmsg-server",
        createdAt: 10,
        input: [{ type: "text", text: "Queue this", mentions: [] }],
      },
    ]);
  });

  it("rolls back optimistic queued message creation", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    const previousQueue = [makeQueuedMessage({ id: "qmsg-existing" })];
    queryClient.setQueryData(
      threadQueuedMessagesQueryKey("thread-1"),
      previousQueue,
    );

    const transaction = await beginCreateQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        input: [{ type: "text", text: "Queue this", mentions: [] }],
      },
    });
    rollbackCreateQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        input: [{ type: "text", text: "Queue this", mentions: [] }],
      },
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual(previousQueue);
  });

  it("updates queued message content without changing its queue position", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    const previousQueue = [
      makeQueuedMessage({ id: "qmsg-first" }),
      makeQueuedMessage({ id: "qmsg-edit", groupWithNext: true }),
      makeQueuedMessage({ id: "qmsg-last" }),
    ];
    queryClient.setQueryData(
      threadQueuedMessagesQueryKey("thread-1"),
      previousQueue,
    );
    const request = {
      expectedUpdatedAt: 1,
      id: "thread-1",
      input: [{ type: "text" as const, text: "Edited", mentions: [] }],
      queuedMessageId: "qmsg-edit",
    };

    const transaction = await beginUpdateQueuedMessageTransaction({
      queryClient,
      request,
    });
    expect(
      queryClient
        .getQueryData<ThreadQueuedMessage[]>(
          threadQueuedMessagesQueryKey("thread-1"),
        )
        ?.map((queuedMessage) => ({
          content: queuedMessage.content,
          groupWithNext: queuedMessage.groupWithNext,
          id: queuedMessage.id,
        })),
    ).toEqual([
      expect.objectContaining({ id: "qmsg-first" }),
      {
        content: [{ type: "text", text: "Edited", mentions: [] }],
        groupWithNext: true,
        id: "qmsg-edit",
      },
      expect.objectContaining({ id: "qmsg-last" }),
    ]);

    applyQueuedMessageUpdateResult({
      queryClient,
      queuedMessage: makeQueuedMessage({
        id: "qmsg-edit",
        content: [{ type: "text", text: "Edited", mentions: [] }],
        groupWithNext: true,
        updatedAt: 2,
      }),
      threadId: "thread-1",
    });
    expect(
      queryClient
        .getQueryData<ThreadQueuedMessage[]>(
          threadQueuedMessagesQueryKey("thread-1"),
        )
        ?.map((queuedMessage) => queuedMessage.id),
    ).toEqual(["qmsg-first", "qmsg-edit", "qmsg-last"]);

    expect(transaction.previousQueuedMessage).toEqual(previousQueue[1]);
  });

  it("rolls back only edited fields while preserving concurrent queue changes", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    const first = makeQueuedMessage({ id: "qmsg-first" });
    const edited = makeQueuedMessage({
      id: "qmsg-edit",
      content: [{ type: "text", text: "Original", mentions: [] }],
      groupWithNext: true,
      updatedAt: 5,
    });
    const last = makeQueuedMessage({ id: "qmsg-last" });
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      first,
      edited,
      last,
    ]);
    const request = {
      expectedUpdatedAt: edited.updatedAt,
      id: "thread-1",
      input: [{ type: "text" as const, text: "Edited", mentions: [] }],
      queuedMessageId: edited.id,
    };
    const transaction = await beginUpdateQueuedMessageTransaction({
      queryClient,
      request,
    });
    const added = makeQueuedMessage({ id: "qmsg-added" });
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      last,
      {
        ...edited,
        content: request.input,
        groupWithNext: false,
        updatedAt: transaction.optimisticUpdatedAt!,
      },
      added,
    ]);

    rollbackUpdateQueuedMessageTransaction({
      queryClient,
      request,
      transaction,
    });

    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toEqual([last, { ...edited, groupWithNext: false }, added]);
  });

  it("does not roll back a newer update to the same queued message", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    const edited = makeQueuedMessage({
      id: "qmsg-edit",
      content: [{ type: "text", text: "Original", mentions: [] }],
      updatedAt: 5,
    });
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      edited,
    ]);
    const request = {
      expectedUpdatedAt: edited.updatedAt,
      id: "thread-1",
      input: [{ type: "text" as const, text: "First edit", mentions: [] }],
      queuedMessageId: edited.id,
    };
    const transaction = await beginUpdateQueuedMessageTransaction({
      queryClient,
      request,
    });
    const newerQueuedMessage = {
      ...edited,
      content: [{ type: "text" as const, text: "Newer edit", mentions: [] }],
      updatedAt: transaction.optimisticUpdatedAt! + 1,
    };
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      newerQueuedMessage,
    ]);

    rollbackUpdateQueuedMessageTransaction({
      queryClient,
      request,
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual([newerQueuedMessage]);
  });

  it("does not resurrect an edited message removed before rollback", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    const edited = makeQueuedMessage({ id: "qmsg-edit", updatedAt: 5 });
    const remaining = makeQueuedMessage({ id: "qmsg-remaining" });
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      edited,
      remaining,
    ]);
    const request = {
      expectedUpdatedAt: edited.updatedAt,
      id: "thread-1",
      input: [{ type: "text" as const, text: "Edited", mentions: [] }],
      queuedMessageId: edited.id,
    };
    const transaction = await beginUpdateQueuedMessageTransaction({
      queryClient,
      request,
    });
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      remaining,
    ]);

    rollbackUpdateQueuedMessageTransaction({
      queryClient,
      request,
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual([remaining]);
  });

  it("optimistically queues queue-if-active sends", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    queryClient.setQueryData(threadQueryKey("thread-1"), {
      status: "active",
    });
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), []);

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        mode: "queue-if-active",
        input: [{ type: "text", text: "Queue through send", mentions: [] }],
      },
    });

    expect(transaction.kind).toBe("queued-message");
    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toMatchObject([
      {
        id: expect.stringMatching(/^optimistic-queued-/u),
        content: [{ type: "text", text: "Queue through send", mentions: [] }],
      },
    ]);

    rollbackSendThreadMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        mode: "queue-if-active",
        input: [{ type: "text", text: "Queue through send", mentions: [] }],
      },
      transaction,
    });
    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual([]);
  });

  it("optimistically queues a scheduled send even when the cached thread is idle", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    const sendAt = Date.now() + 3_600_000;
    queryClient.setQueryData(threadQueryKey("thread-1"), { status: "idle" });
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), []);
    const request = {
      id: "thread-1",
      mode: "auto" as const,
      input: [{ type: "text" as const, text: "Send later", mentions: [] }],
      sendAt,
    };

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    expect(transaction.kind).toBe("queued-message");
    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toMatchObject([{ sendAt, waitingOn: { kind: "time" } }]);

    applySendThreadMessageSuccess({
      queryClient,
      realtimeConnected: true,
      request,
      result: {
        ok: true,
        delivery: "queued",
        queuedMessage: makeQueuedMessage({
          id: "qmsg-scheduled",
          content: request.input,
          sendAt,
          waitingOn: { kind: "time" },
        }),
      },
      transaction,
    });

    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toMatchObject([
      { id: "qmsg-scheduled", sendAt, waitingOn: { kind: "time" } },
    ]);
  });

  it("optimistically removes queued messages and rolls back on failure", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    const previousQueue = [
      makeQueuedMessage({ id: "qmsg-1" }),
      makeQueuedMessage({ id: "qmsg-2" }),
    ];
    queryClient.setQueryData(
      threadQueuedMessagesQueryKey("thread-1"),
      previousQueue,
    );

    const transaction = await beginRemoveQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        queuedMessageId: "qmsg-1",
      },
    });

    expect(
      queryClient
        .getQueryData<ThreadQueuedMessage[]>(
          threadQueuedMessagesQueryKey("thread-1"),
        )
        ?.map((queuedMessage) => queuedMessage.id),
    ).toEqual(["qmsg-2"]);

    rollbackRemoveQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        queuedMessageId: "qmsg-1",
      },
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual(previousQueue);
  });

  it("clears optimistic group edges when deleting a grouped successor", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    const previousQueue = [
      makeQueuedMessage({ id: "qmsg-1", groupWithNext: true }),
      makeQueuedMessage({ id: "qmsg-2" }),
      makeQueuedMessage({ id: "qmsg-3" }),
    ];
    queryClient.setQueryData(
      threadQueuedMessagesQueryKey("thread-1"),
      previousQueue,
    );

    const transaction = await beginRemoveQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        queuedMessageId: "qmsg-2",
      },
    });

    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toMatchObject([
      { id: "qmsg-1", groupWithNext: false },
      { id: "qmsg-3", groupWithNext: false },
    ]);

    rollbackRemoveQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        queuedMessageId: "qmsg-2",
      },
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual(previousQueue);
  });

  it("preserves grouping when optimistically reordering without a boundary", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    const previousQueue = [
      makeQueuedMessage({ id: "qmsg-1", groupWithNext: true }),
      makeQueuedMessage({ id: "qmsg-2" }),
      makeQueuedMessage({ id: "qmsg-3" }),
    ];
    queryClient.setQueryData(
      threadQueuedMessagesQueryKey("thread-1"),
      previousQueue,
    );

    await beginReorderQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        queuedMessageId: "qmsg-3",
        previousQueuedMessageId: null,
        nextQueuedMessageId: "qmsg-1",
      },
    });

    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toMatchObject([
      { id: "qmsg-3", groupWithNext: false },
      { id: "qmsg-1", groupWithNext: false },
      { id: "qmsg-2", groupWithNext: false },
    ]);
  });

  it("optimistically projects sent queued messages into the timeline", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    const previousQueue = [makeQueuedMessage({ id: "qmsg-1" })];
    queryClient.setQueryData(
      threadQueuedMessagesQueryKey("thread-1"),
      previousQueue,
    );
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );

    const transaction = await beginSendQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        mode: "auto",
        queuedMessageId: "qmsg-1",
      },
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual([]);
    const timeline = queryClient.getQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1"),
    );
    expect(timeline?.rows).toHaveLength(1);
    expect(timeline?.rows[0]).toMatchObject({
      kind: "conversation",
      role: "user",
      text: "Queued message",
    });

    rollbackRemoveQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        queuedMessageId: "qmsg-1",
      },
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual(previousQueue);
    expect(
      queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1"),
      )?.rows,
    ).toEqual([]);
  });

  it("restores a queued row and removes its optimistic turn when delivery remains queued", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    const previousQueue = [
      makeQueuedMessage({
        id: "qmsg-1",
        waitingOn: { kind: "thread-busy" },
      }),
    ];
    const previousThread = {
      id: "thread-1",
      status: "starting",
      updatedAt: 1,
      runtime: {
        displayStatus: "provisioning",
        hostReconnectGraceExpiresAt: null,
      },
    };
    queryClient.setQueryData(
      threadQueuedMessagesQueryKey("thread-1"),
      previousQueue,
    );
    queryClient.setQueryData(threadQueryKey("thread-1"), previousThread);
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );
    const request = {
      id: "thread-1",
      mode: "steer" as const,
      queuedMessageId: "qmsg-1",
    };
    const transaction = await beginSendQueuedMessageTransaction({
      queryClient,
      request,
    });

    applyQueuedMessageSendResult({
      queryClient,
      request,
      result: {
        ok: true,
        delivery: "queued",
        queuedMessage: makeQueuedMessage({
          id: "qmsg-1",
          waitingOn: { kind: "provisioning" },
          updatedAt: 2,
        }),
      },
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual([
      makeQueuedMessage({
        id: "qmsg-1",
        waitingOn: { kind: "provisioning" },
        updatedAt: 2,
      }),
    ]);
    expect(
      queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1"),
      )?.rows,
    ).toEqual([]);
    expect(queryClient.getQueryData(threadQueryKey("thread-1"))).toEqual(
      previousThread,
    );
  });

  it("does not duplicate a queued-row steer or overwrite newer thread state after realtime wins", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    const queuedMessage = makeQueuedMessage({
      waitingOn: { kind: "thread-busy" },
    });
    const previousThread = {
      id: "thread-1",
      status: "starting",
      updatedAt: 1,
      runtime: {
        displayStatus: "provisioning",
        hostReconnectGraceExpiresAt: null,
      },
    };
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      queuedMessage,
    ]);
    queryClient.setQueryData(threadQueryKey("thread-1"), previousThread);
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );
    const request = {
      id: "thread-1",
      mode: "steer" as const,
      queuedMessageId: queuedMessage.id,
    };
    const transaction = await beginSendQueuedMessageTransaction({
      queryClient,
      request,
    });
    const authoritativeQueuedMessage = makeQueuedMessage({
      waitingOn: { kind: "provisioning" },
      updatedAt: 2,
    });
    const realtimeThread = {
      ...previousThread,
      title: "Realtime title",
      updatedAt: 2,
    };
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      authoritativeQueuedMessage,
    ]);
    queryClient.setQueryData(threadQueryKey("thread-1"), realtimeThread);

    applyQueuedMessageSendResult({
      queryClient,
      request,
      result: {
        ok: true,
        delivery: "queued",
        queuedMessage: authoritativeQueuedMessage,
      },
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual([authoritativeQueuedMessage]);
    expect(queryClient.getQueryData(threadQueryKey("thread-1"))).toEqual(
      realtimeThread,
    );
    expect(
      queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1"),
      )?.rows,
    ).toEqual([]);
  });

  it("clears optimistic group edges when sending a grouped successor", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    const previousQueue = [
      makeQueuedMessage({ id: "qmsg-1", groupWithNext: true }),
      makeQueuedMessage({ id: "qmsg-2" }),
      makeQueuedMessage({ id: "qmsg-3" }),
    ];
    queryClient.setQueryData(
      threadQueuedMessagesQueryKey("thread-1"),
      previousQueue,
    );
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );

    const transaction = await beginSendQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        mode: "auto",
        queuedMessageId: "qmsg-2",
      },
    });

    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toMatchObject([
      { id: "qmsg-1", groupWithNext: false },
      { id: "qmsg-3", groupWithNext: false },
    ]);

    rollbackRemoveQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        queuedMessageId: "qmsg-2",
      },
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual(previousQueue);
  });

  it("optimistically removes the lead queued-message group without merging timeline text", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    const previousQueue = [
      makeQueuedMessage({ id: "qmsg-1", groupWithNext: true }),
      makeQueuedMessage({
        id: "qmsg-2",
        content: [{ type: "text", text: "Second", mentions: [] }],
      }),
      makeQueuedMessage({
        id: "qmsg-3",
        content: [{ type: "text", text: "Third", mentions: [] }],
      }),
    ];
    queryClient.setQueryData(
      threadQueuedMessagesQueryKey("thread-1"),
      previousQueue,
    );
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );

    const transaction = await beginSendQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        mode: "auto",
        queuedMessageId: "qmsg-1",
      },
    });

    expect(
      queryClient
        .getQueryData<ThreadQueuedMessage[]>(
          threadQueuedMessagesQueryKey("thread-1"),
        )
        ?.map((queuedMessage) => queuedMessage.id),
    ).toEqual(["qmsg-3"]);
    const timeline = queryClient.getQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1"),
    );
    expect(timeline?.rows).toEqual([]);

    rollbackRemoveQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        queuedMessageId: "qmsg-1",
      },
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual(previousQueue);
    expect(
      queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1"),
      )?.rows,
    ).toEqual([]);
  });
  it("moves an optimistic turn into the queue when the server holds an idle send", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    queryClient.setQueryData(threadQueryKey("thread-1"), {
      id: "thread-1",
      status: "idle",
      updatedAt: 1,
      runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
    });
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), []);
    const request = {
      id: "thread-1",
      mode: "queue-if-active" as const,
      input: [{ type: "text" as const, text: "ship the notes", mentions: [] }],
    };
    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });
    expect(transaction.kind).toBe("accepted-turn");

    applySendThreadMessageSuccess({
      queryClient,
      realtimeConnected: true,
      request,
      result: {
        ok: true,
        delivery: "queued",
        queuedMessage: makeQueuedMessage({
          content: request.input,
          waitingOn: { kind: "plugin", pluginId: "limiter", reason: "busy" },
        }),
      },
      transaction,
    });
    await Promise.resolve();

    expect(
      queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1"),
      )?.rows,
    ).toEqual([]);
    expect(queryClient.getQueryData(threadQueryKey("thread-1"))).toMatchObject({
      status: "idle",
      runtime: { displayStatus: "idle" },
    });
    expect(
      queryClient.getQueryData(threadPromptHistoryQueryKey("thread-1")),
    ).toMatchObject([{ input: request.input }]);
    expect(
      queryClient.getQueryState(threadQueuedMessagesQueryKey("thread-1"))
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toMatchObject([
      {
        content: request.input,
        waitingOn: { kind: "plugin", pluginId: "limiter" },
      },
    ]);
  });

  it("keeps newer realtime queue and thread state when it arrives before send success", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    const previousThread = {
      id: "thread-1",
      status: "idle",
      updatedAt: 1,
      runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
    };
    queryClient.setQueryData(threadQueryKey("thread-1"), previousThread);
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), []);
    const request = {
      id: "thread-1",
      mode: "auto" as const,
      input: [{ type: "text" as const, text: "Wait for input", mentions: [] }],
    };
    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });
    const authoritativeQueuedMessage = makeQueuedMessage({
      id: "qmsg-realtime",
      content: request.input,
      waitingOn: { kind: "interaction" },
      updatedAt: 5,
    });
    const realtimeThread = {
      ...previousThread,
      status: "starting",
      updatedAt: 5,
      runtime: {
        displayStatus: "provisioning",
        hostReconnectGraceExpiresAt: null,
      },
    };
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      authoritativeQueuedMessage,
    ]);
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );
    queryClient.setQueryData(threadQueryKey("thread-1"), realtimeThread);

    applySendThreadMessageSuccess({
      queryClient,
      realtimeConnected: true,
      request,
      result: {
        ok: true,
        delivery: "queued",
        queuedMessage: authoritativeQueuedMessage,
      },
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual([authoritativeQueuedMessage]);
    expect(queryClient.getQueryData(threadQueryKey("thread-1"))).toEqual(
      realtimeThread,
    );
    expect(
      queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1"),
      )?.rows,
    ).toEqual([]);
  });

  it("keeps an accepted send local while realtime is connected: prompt history is prepended, not refetched, and default execution options only go stale", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    queryClient.setQueryData(threadQueryKey("thread-1"), {
      id: "thread-1",
      status: "idle",
      runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
    });
    const promptHistoryQueryFn = vi.fn(async () => []);
    const defaultExecutionOptionsQueryFn = vi.fn(async () => null);
    const promptHistoryObserver = new QueryObserver(queryClient, {
      queryKey: threadPromptHistoryQueryKey("thread-1"),
      queryFn: promptHistoryQueryFn,
      staleTime: Infinity,
    });
    const defaultExecutionOptionsObserver = new QueryObserver(queryClient, {
      queryKey: threadDefaultExecutionOptionsQueryKey("thread-1"),
      queryFn: defaultExecutionOptionsQueryFn,
      staleTime: Infinity,
    });
    const unsubscribers = [
      promptHistoryObserver.subscribe(() => {}),
      defaultExecutionOptionsObserver.subscribe(() => {}),
    ];
    await vi.waitFor(() => {
      expect(promptHistoryQueryFn).toHaveBeenCalledTimes(1);
      expect(defaultExecutionOptionsQueryFn).toHaveBeenCalledTimes(1);
    });
    const request = {
      id: "thread-1",
      mode: "auto" as const,
      input: [{ type: "text" as const, text: "Accepted prompt", mentions: [] }],
    };
    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });
    expect(transaction.kind).toBe("accepted-turn");

    applySendThreadMessageSuccess({
      queryClient,
      realtimeConnected: true,
      request,
      result: { ok: true, delivery: "sent" },
      transaction,
    });
    await Promise.resolve();

    expect(
      queryClient.getQueryData(threadPromptHistoryQueryKey("thread-1")),
    ).toMatchObject([{ input: request.input }]);
    expect(promptHistoryQueryFn).toHaveBeenCalledTimes(1);
    expect(
      queryClient.getQueryState(threadPromptHistoryQueryKey("thread-1"))
        ?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryState(
        threadDefaultExecutionOptionsQueryKey("thread-1"),
      )?.isInvalidated,
    ).toBe(true);
    expect(defaultExecutionOptionsQueryFn).toHaveBeenCalledTimes(1);

    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  });

  it("moves a predicted queued send into the timeline when the server sends it", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      showMutationErrorToasts: false,
    });
    const activeThread = {
      status: "active",
      updatedAt: 1,
      runtime: {
        displayStatus: "active",
        hostReconnectGraceExpiresAt: null,
      },
    };
    queryClient.setQueryData(threadQueryKey("thread-1"), activeThread);
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );
    const queuedMessagesQueryFn = vi.fn(async () => []);
    const promptHistoryQueryFn = vi.fn(async () => []);
    const threadQueryFn = vi.fn(async () => activeThread);
    const observers = [
      new QueryObserver(queryClient, {
        queryKey: threadQueuedMessagesQueryKey("thread-1"),
        queryFn: queuedMessagesQueryFn,
        staleTime: Infinity,
      }),
      new QueryObserver(queryClient, {
        queryKey: threadPromptHistoryQueryKey("thread-1"),
        queryFn: promptHistoryQueryFn,
        staleTime: Infinity,
      }),
      new QueryObserver(queryClient, {
        queryKey: threadQueryKey("thread-1"),
        queryFn: threadQueryFn,
        staleTime: Infinity,
      }),
    ];
    const unsubscribers = observers.map((observer) =>
      observer.subscribe(() => {}),
    );
    await vi.waitFor(() => {
      expect(queuedMessagesQueryFn).toHaveBeenCalledTimes(1);
      expect(promptHistoryQueryFn).toHaveBeenCalledTimes(1);
    });
    const request = {
      id: "thread-1",
      mode: "queue-if-active" as const,
      input: [{ type: "text" as const, text: "Queued prompt", mentions: [] }],
    };
    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });
    expect(transaction.kind).toBe("queued-message");

    applySendThreadMessageSuccess({
      queryClient,
      realtimeConnected: true,
      request,
      result: { ok: true, delivery: "sent" },
      transaction,
    });
    await vi.waitFor(() => {
      expect(queuedMessagesQueryFn).toHaveBeenCalledTimes(2);
    });

    expect(
      queryClient.getQueryData(threadPromptHistoryQueryKey("thread-1")),
    ).toMatchObject([{ input: request.input }]);
    expect(promptHistoryQueryFn).toHaveBeenCalledTimes(1);
    expect(threadQueryFn).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryState(threadQueryKey("thread-1"))?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toEqual([]);
    expect(
      queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1"),
      )?.rows,
    ).toMatchObject([{ kind: "conversation", text: "Queued prompt" }]);

    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  });
});
