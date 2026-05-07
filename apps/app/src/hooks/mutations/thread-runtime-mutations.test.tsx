// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadWithRuntime } from "@bb/domain";
import type {
  PromptHistoryResponse,
  SendDraftResponse,
  ThreadTimelineResponse,
} from "@bb/server-contract";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import * as api from "@/lib/api";
import {
  projectPromptHistoryQueryKey,
  projectSourceWorkspaceStatusQueryKey,
  threadQueryKey,
  threadPromptHistoryQueryKey,
  threadTimelineQueryKey,
} from "../queries/query-keys";
import {
  useCreateThread,
  useCreateThreadDraft,
  useSendThreadDraft,
  useSendThreadMessage,
} from "./thread-runtime-mutations";

vi.mock("@/lib/api", () => ({
  createThread: vi.fn(),
  createThreadDraft: vi.fn(),
  sendThreadDraft: vi.fn(),
  sendThreadMessage: vi.fn(),
}));

vi.mock("@/lib/ws", () => ({
  wsManager: {
    getConnectionState: vi.fn(() => "connected"),
  },
}));

const queuedMessage = {
  id: "queued-1",
  content: [{ type: "text", text: "Continue" }],
  model: "gpt-5",
  reasoningLevel: "medium",
  permissionMode: "full",
  serviceTier: "default",
  createdAt: 1,
  updatedAt: 1,
} satisfies SendDraftResponse["queuedMessage"];

const createdThread = {
  id: "thread-created",
  projectId: "project-1",
  automationId: null,
  providerId: "codex",
  type: "standard",
  createdAt: 10,
  status: "idle",
  updatedAt: 10,
  lastReadAt: null,
  latestAttentionAt: 10,
  environmentId: "env-1",
  title: null,
  titleFallback: null,
  parentThreadId: null,
  archivedAt: null,
  stopRequestedAt: null,
  deletedAt: null,
  runtime: {
    displayStatus: "idle",
    hostReconnectGraceExpiresAt: null,
  },
} satisfies ThreadWithRuntime;

function makeThreadWithRuntime(
  thread: Partial<ThreadWithRuntime> = {},
): ThreadWithRuntime {
  return {
    id: "thread-1",
    projectId: "project-1",
    automationId: null,
    providerId: "codex",
    type: "standard",
    createdAt: 1,
    status: "active",
    updatedAt: 1,
    lastReadAt: null,
    latestAttentionAt: 1,
    environmentId: "env-1",
    title: null,
    titleFallback: null,
    parentThreadId: null,
    archivedAt: null,
    stopRequestedAt: null,
    deletedAt: null,
    runtime: {
      displayStatus: "waiting-for-host",
      hostReconnectGraceExpiresAt: null,
    },
    ...thread,
  };
}

function makeTimelineResponse(
  rows: ThreadTimelineResponse["rows"] = [],
): ThreadTimelineResponse {
  return {
    rows,
    activeThinking: null,
    timelinePage: {
      kind: "latest",
      segmentLimit: 20,
      returnedSegmentCount: rows.length > 0 ? 1 : 0,
      hasOlderRows: false,
      olderCursor: null,
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("thread runtime mutations", () => {
  it("adds project create history immediately after thread creation succeeds", async () => {
    vi.mocked(api.createThread).mockResolvedValue(createdThread);
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useCreateThread(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        input: [{ type: "text", text: "Open a debugging thread" }],
        projectId: "project-1",
        providerId: "codex",
        environment: {
          type: "host",
          hostId: "host-1",
          workspace: { type: "managed-clone" },
        },
      });
    });

    expect(
      queryClient.getQueryData<PromptHistoryResponse>(
        projectPromptHistoryQueryKey("project-1"),
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^optimistic-prompt-history:/u),
        createdAt: 10,
        input: [{ type: "text", text: "Open a debugging thread" }],
      },
    ]);
    expect(
      queryClient.getQueryState(projectPromptHistoryQueryKey("project-1"))
        ?.isInvalidated,
    ).toBe(true);
  });

  it("invalidates primary checkout status after sending a message", async () => {
    vi.mocked(api.sendThreadMessage).mockResolvedValue(undefined);
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const workspaceStatusQueryKey = projectSourceWorkspaceStatusQueryKey(
      "project-1",
      "source-1",
    );
    queryClient.setQueryData(workspaceStatusQueryKey, {});
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        input: [{ type: "text", text: "Continue" }],
        mode: "auto",
      });
    });

    expect(
      queryClient.getQueryState(workspaceStatusQueryKey)?.isInvalidated,
    ).toBe(true);
  });

  it("optimistically inserts a user message row into the timeline cache", async () => {
    let resolveSend: (() => void) | null = null;
    vi.mocked(api.sendThreadMessage).mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveSend = () => resolve(undefined);
        }),
    );
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1", undefined),
      makeTimelineResponse(),
    );
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    let mutationPromise: Promise<void> | undefined;
    act(() => {
      mutationPromise = result.current.mutateAsync({
        id: "thread-1",
        input: [{ type: "text", text: "Hello there" }],
        mode: "auto",
      });
    });

    await waitFor(() => {
      const timeline = queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1", undefined),
      );
      expect(timeline?.rows).toHaveLength(1);
    });
    const optimisticTimeline = queryClient.getQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1", undefined),
    );
    const onlyRow = optimisticTimeline?.rows[0];
    expect(onlyRow?.kind).toBe("conversation");
    if (onlyRow?.kind === "conversation") {
      expect(onlyRow.role).toBe("user");
      expect(onlyRow.text).toBe("Hello there");
    }

    await act(async () => {
      resolveSend?.();
      await mutationPromise;
    });
  });

  it("preserves unavailable-host runtime state during optimistic send", async () => {
    let resolveSend: (() => void) | null = null;
    vi.mocked(api.sendThreadMessage).mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveSend = () => resolve(undefined);
        }),
    );
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData<ThreadWithRuntime>(
      threadQueryKey("thread-1"),
      makeThreadWithRuntime(),
    );
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    let mutationPromise: Promise<void> | undefined;
    act(() => {
      mutationPromise = result.current.mutateAsync({
        id: "thread-1",
        input: [{ type: "text", text: "Hello there" }],
        mode: "auto",
      });
    });

    await waitFor(() => {
      const thread = queryClient.getQueryData<ThreadWithRuntime>(
        threadQueryKey("thread-1"),
      );
      expect(thread?.runtime.displayStatus).toBe("waiting-for-host");
    });

    await act(async () => {
      resolveSend?.();
      await mutationPromise;
    });
  });

  it("optimistically appends an active-turn steer to timeline rows", async () => {
    let resolveSend: (() => void) | null = null;
    vi.mocked(api.sendThreadMessage).mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveSend = () => resolve(undefined);
        }),
    );
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData<ThreadWithRuntime>(
      threadQueryKey("thread-1"),
      makeThreadWithRuntime({ status: "active" }),
    );
    queryClient.setQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1", undefined),
      makeTimelineResponse(),
    );
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    let mutationPromise: Promise<void> | undefined;
    act(() => {
      mutationPromise = result.current.mutateAsync({
        id: "thread-1",
        input: [{ type: "text", text: "Keep this in mind" }],
        mode: "auto",
      });
    });

    await waitFor(() => {
      const timeline = queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1", undefined),
      );
      expect(timeline?.rows).toHaveLength(1);
    });
    const timeline = queryClient.getQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1", undefined),
    );
    expect(timeline?.rows[0]).toMatchObject({
      kind: "conversation",
      role: "user",
      text: "Keep this in mind",
      userRequest: {
        kind: "steer",
        status: "pending",
      },
    });

    await act(async () => {
      resolveSend?.();
      await mutationPromise;
    });
  });

  it("does not optimistically append pending steers to manager conversation timelines", async () => {
    let resolveSend: (() => void) | null = null;
    vi.mocked(api.sendThreadMessage).mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveSend = () => resolve(undefined);
        }),
    );
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData<ThreadWithRuntime>(
      threadQueryKey("thread-1"),
      makeThreadWithRuntime({ status: "active", type: "manager" }),
    );
    queryClient.setQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1", undefined),
      makeTimelineResponse(),
    );
    queryClient.setQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1", "standard"),
      makeTimelineResponse(),
    );
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    let mutationPromise: Promise<void> | undefined;
    act(() => {
      mutationPromise = result.current.mutateAsync({
        id: "thread-1",
        input: [{ type: "text", text: "Keep this in mind" }],
        mode: "auto",
      });
    });

    await waitFor(() => {
      const conversationTimeline =
        queryClient.getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey("thread-1", undefined),
        );
      const standardTimeline = queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1", "standard"),
      );
      expect(conversationTimeline?.rows).toHaveLength(0);
      expect(standardTimeline?.rows).toHaveLength(1);
    });

    await act(async () => {
      resolveSend?.();
      await mutationPromise;
    });
  });

  it("skips optimistic pending steer timeline writes when thread data is missing", async () => {
    let resolveSend: (() => void) | null = null;
    vi.mocked(api.sendThreadMessage).mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveSend = () => resolve(undefined);
        }),
    );
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1", undefined),
      makeTimelineResponse(),
    );
    queryClient.setQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1", "standard"),
      makeTimelineResponse(),
    );
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    let mutationPromise: Promise<void> | undefined;
    act(() => {
      mutationPromise = result.current.mutateAsync({
        id: "thread-1",
        input: [{ type: "text", text: "Keep this in mind" }],
        mode: "steer",
      });
    });

    await waitFor(() => {
      expect(api.sendThreadMessage).toHaveBeenCalled();
    });
    expect(
      queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1", undefined),
      )?.rows,
    ).toEqual([]);
    expect(
      queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1", "standard"),
      )?.rows,
    ).toEqual([]);

    await act(async () => {
      resolveSend?.();
      await mutationPromise;
    });
  });

  it("rolls back the optimistic timeline row when send fails", async () => {
    vi.mocked(api.sendThreadMessage).mockRejectedValue(new Error("boom"));
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1", undefined),
      makeTimelineResponse(),
    );
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          id: "thread-1",
          input: [{ type: "text", text: "Hello there" }],
          mode: "auto",
        }),
      ).rejects.toThrow("boom");
    });

    const finalTimeline = queryClient.getQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1", undefined),
    );
    expect(finalTimeline?.rows).toHaveLength(0);
  });

  it("rolls back the optimistic pending steer when send fails", async () => {
    vi.mocked(api.sendThreadMessage).mockRejectedValue(new Error("boom"));
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData<ThreadWithRuntime>(
      threadQueryKey("thread-1"),
      makeThreadWithRuntime({ status: "active" }),
    );
    queryClient.setQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1", undefined),
      makeTimelineResponse(),
    );
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          id: "thread-1",
          input: [{ type: "text", text: "Keep this in mind" }],
          mode: "auto",
        }),
      ).rejects.toThrow("boom");
    });

    const finalTimeline = queryClient.getQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1", undefined),
    );
    expect(finalTimeline?.rows).toHaveLength(0);
  });

  it("invalidates primary checkout status after sending a queued draft", async () => {
    vi.mocked(api.sendThreadDraft).mockResolvedValue({
      ok: true,
      queuedMessage,
    });
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const workspaceStatusQueryKey = projectSourceWorkspaceStatusQueryKey(
      "project-1",
      "source-1",
    );
    queryClient.setQueryData(workspaceStatusQueryKey, {});
    const { result } = renderHook(() => useSendThreadDraft(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        queuedMessageId: "queued-1",
      });
    });

    expect(
      queryClient.getQueryState(workspaceStatusQueryKey)?.isInvalidated,
    ).toBe(true);
  });

  it("adds thread follow-up history immediately after sending succeeds", async () => {
    vi.mocked(api.sendThreadMessage).mockResolvedValue(undefined);
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        input: [{ type: "text", text: "Continue" }],
        mode: "auto",
      });
    });

    expect(
      queryClient.getQueryData<PromptHistoryResponse>(
        threadPromptHistoryQueryKey("thread-1"),
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^optimistic-prompt-history:/u),
        createdAt: expect.any(Number),
        input: [{ type: "text", text: "Continue" }],
      },
    ]);
  });

  it("does not create thread follow-up history when sending fails", async () => {
    vi.mocked(api.sendThreadMessage).mockRejectedValue(new Error("boom"));
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          id: "thread-1",
          input: [{ type: "text", text: "Continue" }],
          mode: "auto",
        }),
      ).rejects.toThrow("boom");
    });

    expect(
      queryClient.getQueryData<PromptHistoryResponse>(
        threadPromptHistoryQueryKey("thread-1"),
      ),
    ).toBeUndefined();
  });

  it("adds queued follow-up history immediately after draft creation succeeds", async () => {
    vi.mocked(api.createThreadDraft).mockResolvedValue(queuedMessage);
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useCreateThreadDraft(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        input: [{ type: "text", text: "Continue" }],
      });
    });

    expect(
      queryClient.getQueryData<PromptHistoryResponse>(
        threadPromptHistoryQueryKey("thread-1"),
      ),
    ).toEqual([
      {
        id: "draft:queued-1",
        createdAt: 1,
        input: [{ type: "text", text: "Continue" }],
      },
    ]);
  });
});
