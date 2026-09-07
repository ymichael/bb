// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ThreadQueuedMessage } from "@bb/domain";
import type {
  ExistingThreadExecutionInputSources,
  ThreadResponse,
  ThreadTimelineResponse,
} from "@bb/server-contract";
import { createDeferredPromise } from "@bb/test-helpers";
import { makeThreadQueuedMessage as makeThreadQueuedMessageFixture } from "@bb/test-helpers/domain-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BbHttpError, sdk } from "@/lib/sdk";
import { wsManager } from "@/lib/ws";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  makeThreadResponse as makeThreadResponseFixture,
  makeThreadTimelineResponse,
} from "@/test/fixtures/thread-responses";
import {
  threadQueryKey,
  threadQueuedMessagesQueryKey,
  threadTimelineQueryKey,
} from "../queries/query-keys";
import {
  useCancelThreadPlan,
  useClearThreadGoal,
  useCreateThread,
  useCreateThreadQueuedMessage,
  useDeleteThreadQueuedMessage,
  useEditThreadMessage,
  useSetThreadQueuedMessageGroupBoundary,
  useSendThreadQueuedMessage,
  useSendThreadMessage,
} from "./thread-runtime-mutations";

vi.mock("@/lib/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sdk")>();
  return {
    ...actual,
    sdk: {
      threads: {
        cancelPlan: vi.fn(),
        clearGoal: vi.fn(),
        editMessage: vi.fn(),
        queuedMessages: {
          create: vi.fn(),
          delete: vi.fn(),
          list: vi.fn(),
          send: vi.fn(),
          setGroupBoundary: vi.fn(),
        },
        send: vi.fn(),
        spawn: vi.fn(),
      },
    },
  };
});

vi.mock("@/lib/ws", () => ({
  wsManager: {
    getConnectionState: vi.fn(() => "connected"),
  },
}));

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

function makeThreadResponse(
  thread: Partial<ThreadResponse> = {},
): ThreadResponse {
  return makeThreadResponseFixture({
    id: "thread-1",
    projectId: "project-1",
    createdAt: 1,
    status: "pending",
    updatedAt: 1,
    lastReadAt: null,
    latestAttentionAt: 1,
    environmentId: null,
    runtime: {
      displayStatus: "pending",
      hostReconnectGraceExpiresAt: null,
    },
    canSpawnChild: false,
    queuedMessageCount: 1,
    ...thread,
  });
}

function makeBannerTimeline(): ThreadTimelineResponse {
  return makeThreadTimelineResponse({
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
}

const executionInputSources = {
  model: "explicit",
  serviceTier: "client-preference",
  reasoningLevel: "explicit",
  permissionMode: "client-preference",
} satisfies ExistingThreadExecutionInputSources;

beforeEach(() => {
  vi.mocked(wsManager.getConnectionState).mockReturnValue("connected");
  vi.mocked(sdk.threads.cancelPlan).mockResolvedValue({ ok: true });
  vi.mocked(sdk.threads.clearGoal).mockResolvedValue({ ok: true });
  vi.mocked(sdk.threads.editMessage).mockResolvedValue({
    ok: true,
    operationId: "edit-op-1",
    requestSequence: 42,
  });
  vi.mocked(sdk.threads.send).mockResolvedValue({
    ok: true,
    delivery: "sent",
  });
  vi.mocked(sdk.threads.spawn).mockResolvedValue(makeThreadResponse());
  vi.mocked(sdk.threads.queuedMessages.create).mockResolvedValue(
    makeQueuedMessage(),
  );
  vi.mocked(sdk.threads.queuedMessages.delete).mockResolvedValue({ ok: true });
  vi.mocked(sdk.threads.queuedMessages.list).mockResolvedValue([
    makeQueuedMessage(),
  ]);
  vi.mocked(sdk.threads.queuedMessages.send).mockResolvedValue({
    ok: true,
    delivery: "sent",
  });
  vi.mocked(sdk.threads.queuedMessages.setGroupBoundary).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("thread runtime mutations", () => {
  it("prefetches queued message detail as soon as a queued thread is created", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useCreateThread(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        projectId: "project-1",
        environment: { type: "project-default" },
        input: [{ type: "text", text: "Queued work", mentions: [] }],
      });
    });

    await waitFor(() =>
      expect(sdk.threads.queuedMessages.list).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "thread-1" }),
      ),
    );
    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual([makeQueuedMessage()]);
  });

  it("keeps the existing timeline while an edit is pending and lets connected realtime own success", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const edit = createDeferredPromise<{
      ok: true;
      operationId: string;
      requestSequence: number;
    }>();
    vi.mocked(sdk.threads.editMessage).mockReturnValueOnce(edit.promise);
    const timeline = makeBannerTimeline();
    queryClient.setQueryData(threadTimelineQueryKey("thread-1"), timeline);
    const { result } = renderHook(() => useEditThreadMessage(), {
      wrapper,
    });

    let editPromise!: Promise<unknown>;
    act(() => {
      editPromise = result.current.mutateAsync({
        id: "thread-1",
        operationId: "edit-op-1",
        expectedRequestSequence: 41,
        input: [{ type: "text", text: "Replacement", mentions: [] }],
      });
    });
    await waitFor(() => expect(sdk.threads.editMessage).toHaveBeenCalledOnce());
    expect(queryClient.getQueryData(threadTimelineQueryKey("thread-1"))).toBe(
      timeline,
    );
    expect(invalidateQueries).not.toHaveBeenCalled();

    edit.resolve({
      ok: true,
      operationId: "edit-op-1",
      requestSequence: 42,
    });
    await act(async () => {
      await editPromise;
    });
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("invalidates rewritten history after edit success when realtime is disconnected", async () => {
    vi.mocked(wsManager.getConnectionState).mockReturnValue("reconnecting");
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useEditThreadMessage(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        operationId: "edit-op-disconnected",
        expectedRequestSequence: 41,
        input: [{ type: "text", text: "Replacement", mentions: [] }],
      });
    });

    expect(invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: threadTimelineQueryKey("thread-1") }),
    );
  });

  it.each([
    ["Plan", useCancelThreadPlan, () => sdk.threads.cancelPlan],
    ["Goal", useClearThreadGoal, () => sdk.threads.clearGoal],
  ] as const)(
    "invalidates persisted banner state only after successful %s cancellation",
    async (_label, useMutationHook, getSdkMethod) => {
      const { queryClient, wrapper } = createQueryClientTestHarness();
      const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
      const cancellation = createDeferredPromise<{ ok: true }>();
      vi.mocked(getSdkMethod()).mockReturnValueOnce(cancellation.promise);
      queryClient.setQueryData(
        threadTimelineQueryKey("thread-1"),
        makeBannerTimeline(),
      );
      const { result } = renderHook(() => useMutationHook(), { wrapper });

      let cancellationPromise!: Promise<unknown>;
      act(() => {
        cancellationPromise = result.current.mutateAsync("thread-1");
      });
      await waitFor(() => expect(getSdkMethod()).toHaveBeenCalledOnce());
      expect(
        queryClient.getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey("thread-1"),
        ),
      ).toMatchObject({
        activePromptMode: { mode: "plan" },
        goal: { status: "active" },
      });

      cancellation.resolve({ ok: true });
      await act(async () => {
        await cancellationPromise;
      });
      expect(getSdkMethod()).toHaveBeenCalledWith({ threadId: "thread-1" });
      expect(invalidateQueries).toHaveBeenCalled();
      const timelineAfterSuccess =
        queryClient.getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey("thread-1"),
        );
      if (_label === "Plan") {
        expect(timelineAfterSuccess?.activePromptMode).toBeNull();
        expect(timelineAfterSuccess?.goal).toMatchObject({ status: "active" });
      } else {
        expect(timelineAfterSuccess?.activePromptMode).toMatchObject({
          mode: "plan",
        });
        expect(timelineAfterSuccess?.goal).toBeNull();
      }

      invalidateQueries.mockClear();
      queryClient.setQueryData(
        threadTimelineQueryKey("thread-1"),
        makeBannerTimeline(),
      );
      vi.mocked(getSdkMethod()).mockRejectedValueOnce(
        new Error("provider rejected cancellation"),
      );
      await act(async () => {
        await expect(result.current.mutateAsync("thread-1")).rejects.toThrow(
          "provider rejected cancellation",
        );
      });
      expect(invalidateQueries).not.toHaveBeenCalled();
      expect(
        queryClient.getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey("thread-1"),
        ),
      ).toMatchObject({
        activePromptMode: { mode: "plan" },
        goal: { status: "active" },
      });
    },
  );

  it("forwards execution input sources when sending a thread message", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        mode: "auto",
        input: [{ type: "text", text: "Run this", mentions: [] }],
        executionInputSources,
      });
    });

    expect(sdk.threads.send).toHaveBeenCalledWith(
      expect.objectContaining({
        executionInputSources,
        threadId: "thread-1",
      }),
    );
  });

  it("returns the server's delivery so a queued message is not treated as a started turn", async () => {
    vi.mocked(sdk.threads.send).mockResolvedValue({
      ok: true,
      delivery: "queued",
      queuedMessage: makeQueuedMessage({
        waitingOn: { kind: "interaction" },
      }),
    });
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    let sendResult: Awaited<ReturnType<typeof result.current.mutateAsync>> = {
      ok: true,
      delivery: "sent",
    };
    await act(async () => {
      sendResult = await result.current.mutateAsync({
        id: "thread-1",
        mode: "steer-if-active",
        input: [{ type: "text", text: "worker report", mentions: [] }],
      });
    });

    expect(sendResult).toEqual({
      ok: true,
      delivery: "queued",
      queuedMessage: makeQueuedMessage({
        waitingOn: { kind: "interaction" },
      }),
    });
  });

  it("restores a queued-row steer when provisioning keeps it queued", async () => {
    const queuedMessage = makeQueuedMessage({
      waitingOn: { kind: "thread-busy" },
    });
    const provisioningQueuedMessage = makeQueuedMessage({
      waitingOn: { kind: "provisioning" },
      updatedAt: 2,
    });
    vi.mocked(sdk.threads.queuedMessages.send).mockResolvedValue({
      ok: true,
      delivery: "queued",
      queuedMessage: provisioningQueuedMessage,
    });
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      queuedMessage,
    ]);
    queryClient.setQueryData(
      threadQueryKey("thread-1"),
      makeThreadResponse({
        status: "starting",
        runtime: {
          displayStatus: "provisioning",
          hostReconnectGraceExpiresAt: null,
        },
      }),
    );
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeBannerTimeline(),
    );
    const { result } = renderHook(() => useSendThreadQueuedMessage(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        mode: "steer",
        queuedMessageId: queuedMessage.id,
      });
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual([provisioningQueuedMessage]);
    expect(
      queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1"),
      )?.rows,
    ).toEqual([]);
  });

  it("forwards execution input sources and sender thread when queueing a message", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useCreateThreadQueuedMessage(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        input: [{ type: "text", text: "Queue this", mentions: [] }],
        senderThreadId: "thread-source",
        executionInputSources,
      });
    });

    expect(sdk.threads.queuedMessages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        executionInputSources,
        senderThreadId: "thread-source",
        threadId: "thread-1",
      }),
    );
  });

  it("keeps an optimistically deleted queued message removed when the server says it is already gone", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      makeQueuedMessage({ id: "qmsg-1" }),
      makeQueuedMessage({ id: "qmsg-2" }),
    ]);
    vi.mocked(sdk.threads.queuedMessages.delete).mockRejectedValue(
      new BbHttpError({
        status: 404,
        code: "invalid_request",
        message: "Queued message not found",
        body: {
          code: "invalid_request",
          message: "Queued message not found",
        },
      }),
    );
    const { result } = renderHook(() => useDeleteThreadQueuedMessage(), {
      wrapper,
    });

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          id: "thread-1",
          queuedMessageId: "qmsg-1",
        }),
      ).resolves.toBeUndefined();
    });

    expect(
      queryClient
        .getQueryData<ThreadQueuedMessage[]>(
          threadQueuedMessagesQueryKey("thread-1"),
        )
        ?.map((queuedMessage) => queuedMessage.id),
    ).toEqual(["qmsg-2"]);
  });

  it("sets the queued-message group boundary through the API", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useSetThreadQueuedMessageGroupBoundary(),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        expectedGroupedPrefixQueuedMessageIds: ["qmsg-1", "qmsg-2"],
        groupBoundaryQueuedMessageId: "qmsg-2",
      });
    });

    expect(sdk.threads.queuedMessages.setGroupBoundary).toHaveBeenCalledWith({
      expectedGroupedPrefixQueuedMessageIds: ["qmsg-1", "qmsg-2"],
      groupBoundaryQueuedMessageId: "qmsg-2",
      threadId: "thread-1",
    });
  });
});
