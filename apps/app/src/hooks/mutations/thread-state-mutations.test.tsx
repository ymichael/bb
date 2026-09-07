// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import { makeThreadWithRuntime as makeThreadWithRuntimeFixture } from "@bb/test-helpers/domain-fixtures";
import type {
  SidebarBootstrapResponse,
  ThreadResponse,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeThreadListEntry as makeThreadListEntryFixture } from "@bb/test-helpers/domain-fixtures";
import { makeThreadResponse as makeThreadResponseFixture } from "@/test/fixtures/thread-responses";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import {
  sidebarNavigationQueryKey,
  threadListQueryKey,
  threadQueryKey,
} from "../queries/query-keys";
import {
  useUnpinAndMoveThread,
  useUpdateThread,
} from "./thread-state-mutations";

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { unpin: vi.fn(), update: vi.fn() } },
}));

function makeThreadWithRuntime(
  thread: Partial<ThreadWithRuntime> = {},
): ThreadWithRuntime {
  return makeThreadWithRuntimeFixture({
    id: "thread-1",
    projectId: "project-1",
    environmentId: "env-1",
    title: null,
    titleFallback: null,
    status: "active",
    lastReadAt: null,
    latestAttentionAt: 50,
    createdAt: 1,
    updatedAt: 1,
    runtime: {
      displayStatus: "waiting-for-host",
      hostReconnectGraceExpiresAt: null,
    },
    ...thread,
  });
}

function makeThreadResponse(
  thread: Partial<ThreadResponse> = {},
): ThreadResponse {
  return makeThreadResponseFixture({
    ...makeThreadWithRuntime(thread),
    ...thread,
  });
}

function makeThreadListEntry(
  thread: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  return makeThreadListEntryFixture({
    ...makeThreadWithRuntime(),
    environmentHostId: "host-1",
    environmentName: "Environment",
    environmentBranchName: "main",
    environmentWorkspaceDisplayKind: "managed-worktree",
    ...thread,
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("thread state mutations", () => {
  it("optimistically renames a thread while the update request is pending", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const threadId = "thread-1";
    const thread = makeThreadWithRuntime({
      id: threadId,
      title: "Old title",
    });
    const listEntry = makeThreadListEntry({
      id: threadId,
      title: "Old title",
    });
    const threadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    let resolveUpdate: (thread: ThreadResponse) => void = () => {};

    queryClient.setQueryData(threadQueryKey(threadId), thread);
    queryClient.setQueryData(threadListKey, [listEntry]);
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([listEntry]),
    );
    vi.mocked(sdk.threads.update).mockImplementation(
      () =>
        new Promise<ThreadResponse>((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    const { result } = renderHook(() => useUpdateThread(), { wrapper });

    act(() => {
      result.current.mutate({ id: threadId, title: "New title" });
    });

    await waitFor(() => {
      expect(
        queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey(threadId))
          ?.title,
      ).toBe("New title");
    });
    expect(
      queryClient.getQueryData<ThreadListEntry[]>(threadListKey)?.[0]?.title,
    ).toBe("New title");
    expect(
      queryClient.getQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
      )?.projects[0]?.threads[0]?.title,
    ).toBe("New title");
    expect(sdk.threads.update).toHaveBeenCalledWith({
      threadId,
      title: "New title",
    });

    act(() => {
      resolveUpdate(
        makeThreadResponse({
          id: threadId,
          title: "New title",
          updatedAt: 2,
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
  });

  it("optimistically moves a thread between sections while the update request is pending", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const threadId = "thread-1";
    const thread = makeThreadWithRuntime({
      id: threadId,
      sectionId: "sec_work",
    });
    const listEntry = makeThreadListEntry({
      id: threadId,
      sectionId: "sec_work",
    });
    const threadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    let resolveUpdate: (thread: ThreadResponse) => void = () => {};

    queryClient.setQueryData(threadQueryKey(threadId), thread);
    queryClient.setQueryData(threadListKey, [listEntry]);
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([listEntry]),
    );
    vi.mocked(sdk.threads.update).mockImplementation(
      () =>
        new Promise<ThreadResponse>((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    const { result } = renderHook(() => useUpdateThread(), { wrapper });

    act(() => {
      result.current.mutate({ id: threadId, sectionId: "sec_personal" });
    });

    await waitFor(() => {
      expect(
        queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey(threadId))
          ?.sectionId,
      ).toBe("sec_personal");
    });
    expect(
      queryClient.getQueryData<ThreadListEntry[]>(threadListKey)?.[0]
        ?.sectionId,
    ).toBe("sec_personal");
    expect(
      queryClient.getQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
      )?.projects[0]?.threads[0]?.sectionId,
    ).toBe("sec_personal");
    expect(sdk.threads.update).toHaveBeenCalledWith({
      threadId,
      sectionId: "sec_personal",
    });

    act(() => {
      resolveUpdate(
        makeThreadResponse({
          id: threadId,
          sectionId: "sec_personal",
          updatedAt: 2,
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
  });

  it("serializes unpin before section move while optimistically applying both fields", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const threadId = "thread-1";
    const destinationSectionId = "sec_personal";
    const thread = makeThreadWithRuntime({
      id: threadId,
      sectionId: null,
      pinnedAt: 10,
    });
    const listEntry = makeThreadListEntry({
      id: threadId,
      sectionId: null,
      pinnedAt: 10,
      pinSortKey: "a0",
    });
    const threadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    let resolveUnpin: (thread: ThreadResponse) => void = () => {};
    let resolveUpdate: (thread: ThreadResponse) => void = () => {};

    queryClient.setQueryData(threadQueryKey(threadId), thread);
    queryClient.setQueryData(threadListKey, [listEntry]);
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([listEntry]),
    );
    vi.mocked(sdk.threads.unpin).mockImplementation(
      () =>
        new Promise<ThreadResponse>((resolve) => {
          resolveUnpin = resolve;
        }),
    );
    vi.mocked(sdk.threads.update).mockImplementation(
      () =>
        new Promise<ThreadResponse>((resolve) => {
          resolveUpdate = resolve;
        }),
    );

    const { result } = renderHook(() => useUnpinAndMoveThread(), { wrapper });

    act(() => {
      result.current.mutate({ id: threadId, sectionId: destinationSectionId });
    });

    await waitFor(() => {
      expect(
        queryClient.getQueryData<ThreadListEntry[]>(threadListKey)?.[0],
      ).toMatchObject({
        sectionId: destinationSectionId,
        pinnedAt: null,
        pinSortKey: null,
      });
    });
    expect(
      queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey(threadId)),
    ).toMatchObject({
      sectionId: destinationSectionId,
      pinnedAt: null,
    });
    expect(sdk.threads.unpin).toHaveBeenCalledWith({ threadId });
    expect(sdk.threads.update).not.toHaveBeenCalled();

    act(() => {
      resolveUnpin(
        makeThreadResponse({
          id: threadId,
          sectionId: null,
          pinnedAt: null,
          updatedAt: 2,
        }),
      );
    });

    await waitFor(() => {
      expect(sdk.threads.update).toHaveBeenCalledWith({
        threadId,
        sectionId: destinationSectionId,
      });
    });

    act(() => {
      resolveUpdate(
        makeThreadResponse({
          id: threadId,
          sectionId: destinationSectionId,
          pinnedAt: null,
          updatedAt: 3,
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(
      queryClient.getQueryData<ThreadListEntry[]>(threadListKey)?.[0],
    ).toMatchObject({
      sectionId: destinationSectionId,
      pinnedAt: null,
      pinSortKey: null,
    });
  });
});
