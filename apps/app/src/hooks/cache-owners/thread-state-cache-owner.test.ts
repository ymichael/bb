import type { ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import { makeThreadWithRuntime as makeThreadWithRuntimeFixture } from "@bb/test-helpers/domain-fixtures";
import type { SidebarBootstrapResponse } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeThreadListEntry as makeThreadListEntryFixture } from "@bb/test-helpers/domain-fixtures";
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
  beginThreadReadStateTransaction,
  beginThreadMetadataTransaction,
  rollbackThreadListMutationTransaction,
} from "./thread-state-cache-owner";

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

describe("thread state cache owner", () => {
  it("optimistically renames thread in thread, list, and sidebar caches", async () => {
    const { queryClient } = createQueryClientTestHarness();
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

    queryClient.setQueryData(threadQueryKey(threadId), thread);
    queryClient.setQueryData(threadListKey, [listEntry]);
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([listEntry]),
    );

    const transaction = await beginThreadMetadataTransaction({
      queryClient,
      threadId,
      title: "New title",
    });

    expect(
      queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey(threadId))
        ?.title,
    ).toBe("New title");
    expect(
      queryClient.getQueryData<ThreadListEntry[]>(threadListKey)?.[0]?.title,
    ).toBe("New title");
    expect(
      queryClient.getQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
      )?.projects[0]?.threads[0]?.title,
    ).toBe("New title");

    rollbackThreadListMutationTransaction({
      queryClient,
      threadId,
      transaction,
    });

    expect(
      queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey(threadId))
        ?.title,
    ).toBe("Old title");
    expect(
      queryClient.getQueryData<ThreadListEntry[]>(threadListKey)?.[0]?.title,
    ).toBe("Old title");
    expect(
      queryClient.getQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
      )?.projects[0]?.threads[0]?.title,
    ).toBe("Old title");
  });

  it("optimistically marks read state in thread, list, and sidebar caches", async () => {
    const { queryClient } = createQueryClientTestHarness();
    const threadId = "thread-1";
    const unreadThread = makeThreadWithRuntime({
      id: threadId,
      lastReadAt: 10,
      latestAttentionAt: 50,
    });
    const unreadListEntry = makeThreadListEntry({
      id: threadId,
      lastReadAt: 10,
      latestAttentionAt: 50,
    });
    const threadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });

    queryClient.setQueryData(threadQueryKey(threadId), unreadThread);
    queryClient.setQueryData(threadListKey, [unreadListEntry]);
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([unreadListEntry]),
    );

    const transaction = await beginThreadReadStateTransaction({
      lastReadAt: 20,
      queryClient,
      threadId,
    });

    expect(
      queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey(threadId))
        ?.lastReadAt,
    ).toBe(50);
    expect(
      queryClient.getQueryData<ThreadListEntry[]>(threadListKey)?.[0]
        ?.lastReadAt,
    ).toBe(50);
    expect(
      queryClient.getQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
      )?.projects[0]?.threads[0]?.lastReadAt,
    ).toBe(50);

    rollbackThreadListMutationTransaction({
      queryClient,
      threadId,
      transaction,
    });

    expect(
      queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey(threadId))
        ?.lastReadAt,
    ).toBe(10);
    expect(
      queryClient.getQueryData<ThreadListEntry[]>(threadListKey)?.[0]
        ?.lastReadAt,
    ).toBe(10);
    expect(
      queryClient.getQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
      )?.projects[0]?.threads[0]?.lastReadAt,
    ).toBe(10);
  });
});
