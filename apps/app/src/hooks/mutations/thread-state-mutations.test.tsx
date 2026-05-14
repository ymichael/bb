// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import * as api from "@/lib/api";
import { threadListQueryKey, threadQueryKey } from "../queries/query-keys";
import {
  useMarkThreadRead,
  useMarkThreadUnread,
} from "./thread-state-mutations";

vi.mock("@/lib/api", () => ({
  markThreadRead: vi.fn(),
  markThreadUnread: vi.fn(),
}));

function makeThread(
  overrides: Partial<ThreadWithRuntime> = {},
): ThreadWithRuntime {
  return {
    archivedAt: null,
    automationId: null,
    createdAt: 1,
    deletedAt: null,
    environmentId: "environment-1",
    id: "thread-1",
    lastReadAt: null,
    latestAttentionAt: 10,
    parentThreadId: null,
    projectId: "project-1",
    providerId: "codex",
    runtime: {
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    },
    status: "idle",
    stopRequestedAt: null,
    title: "Thread title",
    titleFallback: "Thread title",
    type: "standard",
    updatedAt: 10,
    ...overrides,
  };
}

function makeThreadListEntry(
  overrides: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  const thread = makeThread(overrides);
  return {
    ...thread,
    environmentBranchName: null,
    environmentHostId: null,
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("thread state mutations", () => {
  it("marks a thread read without invalidating active thread lists", async () => {
    const unreadThread = makeThread({
      lastReadAt: null,
      latestAttentionAt: 10,
    });
    const readThread = makeThread({ lastReadAt: 10, latestAttentionAt: 10 });
    vi.mocked(api.markThreadRead).mockResolvedValue(readThread);

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const listKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    queryClient.setQueryData(threadQueryKey(unreadThread.id), unreadThread);
    queryClient.setQueryData<ThreadListEntry[]>(listKey, [
      makeThreadListEntry({ lastReadAt: null, latestAttentionAt: 10 }),
    ]);

    const { result } = renderHook(() => useMarkThreadRead(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync(unreadThread.id);
    });

    expect(queryClient.getQueryData(threadQueryKey(unreadThread.id))).toEqual(
      readThread,
    );
    expect(
      queryClient.getQueryData<ThreadListEntry[]>(listKey)?.[0],
    ).toMatchObject({
      id: unreadThread.id,
      lastReadAt: 10,
      latestAttentionAt: 10,
    });
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(false);
  });

  it("marks a thread unread without invalidating active thread lists", async () => {
    const readThread = makeThread({ lastReadAt: 10, latestAttentionAt: 10 });
    const unreadThread = makeThread({ lastReadAt: 0, latestAttentionAt: 10 });
    vi.mocked(api.markThreadUnread).mockResolvedValue(unreadThread);

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const listKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    queryClient.setQueryData(threadQueryKey(readThread.id), readThread);
    queryClient.setQueryData<ThreadListEntry[]>(listKey, [
      makeThreadListEntry({ lastReadAt: 10, latestAttentionAt: 10 }),
    ]);

    const { result } = renderHook(() => useMarkThreadUnread(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync(readThread.id);
    });

    expect(queryClient.getQueryData(threadQueryKey(readThread.id))).toEqual(
      unreadThread,
    );
    expect(
      queryClient.getQueryData<ThreadListEntry[]>(listKey)?.[0],
    ).toMatchObject({
      id: readThread.id,
      lastReadAt: 0,
      latestAttentionAt: 10,
    });
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(false);
  });
});
