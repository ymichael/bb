// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { ThreadListEntry } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  projectPromptHistoryQueryKey,
  threadListQueryKey,
} from "../queries/query-keys";
import { useArchiveThread, useUnarchiveThread } from "./thread-state-mutations";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();

  return {
    ...actual,
    archiveThread: vi.fn(),
    unarchiveThread: vi.fn(),
  };
});

type ThreadListEntryOverrides = Partial<ThreadListEntry>;

function makeThreadListEntry(
  overrides: ThreadListEntryOverrides = {},
): ThreadListEntry {
  return {
    id: "thread-1",
    projectId: "project-1",
    environmentId: "env-1",
    automationId: null,
    providerId: "codex",
    type: "standard",
    title: null,
    titleFallback: null,
    status: "idle",
    parentThreadId: null,
    archivedAt: null,
    stopRequestedAt: null,
    deletedAt: null,
    lastReadAt: null,
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: 1,
    runtime: {
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    },
    hasPendingInteraction: false,
    environmentHostId: null,
    environmentBranchName: null,
    environmentWorkspaceDisplayKind: "unmanaged-worktree",
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("thread state mutations", () => {
  it("invalidates project prompt history after archiving a thread", async () => {
    vi.mocked(api.archiveThread).mockResolvedValue(undefined);
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const projectPromptHistoryKey = projectPromptHistoryQueryKey("project-1");
    queryClient.setQueryData(
      threadListQueryKey({ projectId: "project-1", archived: false }),
      [makeThreadListEntry()],
    );
    queryClient.setQueryData(projectPromptHistoryKey, []);

    const { result } = renderHook(() => useArchiveThread(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        force: false,
        managerChildThreadsConfirmed: false,
      });
    });

    expect(api.archiveThread).toHaveBeenCalledWith("thread-1", {
      force: false,
      managerChildThreadsConfirmed: false,
    });
    expect(
      queryClient.getQueryState(projectPromptHistoryKey)?.isInvalidated,
    ).toBe(true);
  });

  it("invalidates project prompt history after unarchiving a thread", async () => {
    vi.mocked(api.unarchiveThread).mockResolvedValue(undefined);
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const projectPromptHistoryKey = projectPromptHistoryQueryKey("project-1");
    queryClient.setQueryData(
      threadListQueryKey({ projectId: "project-1", archived: true }),
      [makeThreadListEntry({ archivedAt: 10 })],
    );
    queryClient.setQueryData(projectPromptHistoryKey, []);

    const { result } = renderHook(() => useUnarchiveThread(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
      });
    });

    expect(api.unarchiveThread).toHaveBeenCalledWith("thread-1");
    expect(
      queryClient.getQueryState(projectPromptHistoryKey)?.isInvalidated,
    ).toBe(true);
  });
});
