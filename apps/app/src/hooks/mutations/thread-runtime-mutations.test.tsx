// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadWithRuntime } from "@bb/domain";
import type {
  SendDraftResponse,
  ThreadTimelineResponse,
} from "@bb/server-contract";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import * as api from "@/lib/api";
import {
  projectSourceWorkspaceStatusQueryKey,
  threadQueryKey,
  threadTimelineQueryKey,
} from "../queries/query-keys";
import {
  useSendThreadDraft,
  useSendThreadMessage,
} from "./thread-runtime-mutations";

vi.mock("@/lib/api", () => ({
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

afterEach(() => {
  vi.clearAllMocks();
});

describe("thread runtime mutations", () => {
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
      threadTimelineQueryKey("thread-1", false),
      { rows: [], activeThinking: null },
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
        threadTimelineQueryKey("thread-1", false),
      );
      expect(timeline?.rows).toHaveLength(1);
    });
    const optimisticTimeline = queryClient.getQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1", false),
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

  it("rolls back the optimistic timeline row when send fails", async () => {
    vi.mocked(api.sendThreadMessage).mockRejectedValue(new Error("boom"));
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey("thread-1", false),
      { rows: [], activeThinking: null },
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
      threadTimelineQueryKey("thread-1", false),
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
});
