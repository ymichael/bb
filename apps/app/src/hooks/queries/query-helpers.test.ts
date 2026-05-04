import { describe, expect, it } from "vitest";
import type {
  ThreadGitDiffResponse,
  ThreadListEntry,
  ThreadWithRuntime,
  WorkspaceStatus,
} from "@bb/domain";
import {
  makeWorkspaceMergeBase,
  makeWorkspaceStatus,
  makeWorkspaceWorkingTree,
} from "@bb/test-helpers";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import {
  getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys,
  getEnvironmentActionInvalidationQueryKeys,
  getEnvironmentBranchListInvalidationQueryKeys,
  getEnvironmentRecordInvalidationQueryKeys,
  getEnvironmentWorkspaceStateInvalidationQueryKeys,
  optimisticallyInsertThread,
} from "./query-cache";
import {
  environmentGitDiffQueryKey,
  environmentWorkStatusQueryKey,
  threadListQueryKey,
  threadsQueryKey,
} from "./query-keys";
import {
  resolveEnvironmentGitDiffPlaceholder,
  resolveEnvironmentWorkStatusPlaceholder,
  resolveThreadPlaceholder,
  resolveThreadTimelinePlaceholder,
} from "./query-placeholders";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";

function makeStatus(
  state: WorkspaceStatus["workingTree"]["state"],
): WorkspaceStatus {
  return makeWorkspaceStatus({
    workingTree: makeWorkspaceWorkingTree({ state }),
    branch: { currentBranch: "feature", defaultBranch: "main" },
    mergeBase: makeWorkspaceMergeBase({ baseRef: "origin/main" }),
  });
}

function makeGitDiffResponse(): ThreadGitDiffResponse {
  return {
    diff: "diff --git a/file b/file",
    truncated: false,
    shortstat: " 1 file changed, 1 insertion(+)\n",
    files: "M\tfile\n",
  };
}

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

describe("resolveEnvironmentWorkStatusPlaceholder", () => {
  it("keeps previous data when only merge-base selection changes", () => {
    const previousStatus = makeStatus("clean");

    expect(
      resolveEnvironmentWorkStatusPlaceholder(
        previousStatus,
        ["environmentWorkStatus", "thread-1", null],
        "thread-1",
      ),
    ).toBe(previousStatus);
  });

  it("drops previous data when switching to a different thread", () => {
    const previousStatus = makeStatus("dirty_uncommitted");

    expect(
      resolveEnvironmentWorkStatusPlaceholder(
        previousStatus,
        ["environmentWorkStatus", "thread-1", null],
        "thread-2",
      ),
    ).toBeUndefined();
  });

  it("preserves null placeholders only for the same thread", () => {
    expect(
      resolveEnvironmentWorkStatusPlaceholder(
        null,
        ["environmentWorkStatus", "thread-1", null],
        "thread-1",
      ),
    ).toBeNull();

    expect(
      resolveEnvironmentWorkStatusPlaceholder(
        null,
        ["environmentWorkStatus", "thread-1", null],
        "thread-2",
      ),
    ).toBeUndefined();
  });
});

describe("resolveThreadPlaceholder", () => {
  it("keeps previous data when the same thread query refreshes", () => {
    const previousThread: ThreadWithRuntime = {
      id: "thread-1",
      projectId: "project-1",
      automationId: null,
      providerId: "codex",
      type: "standard",
      createdAt: 1,
      status: "idle",
      updatedAt: 1,
      lastReadAt: 1,
      latestAttentionAt: 1,
      environmentId: null,
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
    };

    expect(
      resolveThreadPlaceholder(
        previousThread,
        ["thread", "thread-1"],
        "thread-1",
      ),
    ).toBe(previousThread);
  });

  it("drops previous data when switching to a different thread", () => {
    const previousThread: ThreadWithRuntime = {
      id: "thread-1",
      projectId: "project-1",
      automationId: null,
      providerId: "codex",
      type: "standard",
      createdAt: 1,
      status: "idle",
      updatedAt: 1,
      lastReadAt: 1,
      latestAttentionAt: 1,
      environmentId: null,
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
    };

    expect(
      resolveThreadPlaceholder(
        previousThread,
        ["thread", "thread-1"],
        "thread-2",
      ),
    ).toBeUndefined();
  });
});

describe("resolveThreadTimelinePlaceholder", () => {
  it("keeps previous timeline rows when the same thread query refreshes", () => {
    const previousTimeline: ThreadTimelineResponse = {
      activeThinking: null,
      pendingSteers: [],
      rows: [
        {
          id: "assistant-1",
          kind: "conversation",
          role: "assistant",
          threadId: "thread-1",
          turnId: "turn-1",
          text: "Done",
          sourceSeqStart: 1,
          sourceSeqEnd: 1,
          startedAt: 1,
          createdAt: 1,
          attachments: null,
          userRequest: null,
        },
      ],
    };

    expect(
      resolveThreadTimelinePlaceholder(
        previousTimeline,
        ["threadTimeline", "thread-1", false],
        "thread-1",
      ),
    ).toBe(previousTimeline);
  });

  it("drops previous timeline rows when switching to a different thread", () => {
    const previousTimeline: ThreadTimelineResponse = {
      activeThinking: null,
      pendingSteers: [],
      rows: [],
    };

    expect(
      resolveThreadTimelinePlaceholder(
        previousTimeline,
        ["threadTimeline", "thread-1", false],
        "thread-2",
      ),
    ).toBeUndefined();
  });
});

describe("resolveEnvironmentGitDiffPlaceholder", () => {
  it("keeps previous data for the same environment while changing git diff options", () => {
    const previousGitDiff = makeGitDiffResponse();

    expect(
      resolveEnvironmentGitDiffPlaceholder(
        previousGitDiff,
        ["environmentGitDiff", "env-1", "all", "main"],
        "env-1",
      ),
    ).toBe(previousGitDiff);
  });

  it("drops previous data when switching to a different environment", () => {
    const previousGitDiff = makeGitDiffResponse();

    expect(
      resolveEnvironmentGitDiffPlaceholder(
        previousGitDiff,
        ["environmentGitDiff", "env-1", "all", "main"],
        "env-2",
      ),
    ).toBeUndefined();
  });
});

describe("getEnvironmentRecordInvalidationQueryKeys", () => {
  it("targets persisted environment queries", () => {
    expect(
      getEnvironmentRecordInvalidationQueryKeys({
        environmentId: "env-1",
      }),
    ).toEqual([["environment", "env-1"]]);
  });
});

describe("getEnvironmentWorkspaceStateInvalidationQueryKeys", () => {
  it("targets workspace-derived status and diff queries", () => {
    expect(
      getEnvironmentWorkspaceStateInvalidationQueryKeys({
        environmentId: "env-1",
      }),
    ).toEqual([
      ["environmentWorkStatus", "env-1"],
      ["environmentGitDiff", "env-1"],
      ["environmentPromotion", "env-1"],
    ]);
  });
});

describe("getEnvironmentBranchListInvalidationQueryKeys", () => {
  it("targets environment branch list queries", () => {
    expect(
      getEnvironmentBranchListInvalidationQueryKeys({
        environmentId: "env-1",
      }),
    ).toEqual([["environmentMergeBaseBranches", "env-1"]]);
  });
});

describe("getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys", () => {
  it("targets only merge-base-dependent work status and branch-based diff queries", () => {
    const { queryClient } = createQueryClientTestHarness();

    queryClient.setQueryData(
      environmentWorkStatusQueryKey("env-1", null),
      null,
    );
    queryClient.setQueryData(
      environmentWorkStatusQueryKey("env-1", "main"),
      null,
    );
    queryClient.setQueryData(
      environmentGitDiffQueryKey("env-1", "commit", "abc123"),
      makeGitDiffResponse(),
    );
    queryClient.setQueryData(
      environmentGitDiffQueryKey("env-1", "all", "main"),
      makeGitDiffResponse(),
    );
    queryClient.setQueryData(
      environmentGitDiffQueryKey("env-2", "all", "main"),
      makeGitDiffResponse(),
    );

    const queryKeys =
      getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys(queryClient, {
        environmentId: "env-1",
      });

    expect(queryKeys).toHaveLength(2);
    expect(queryKeys).toContainEqual(
      environmentWorkStatusQueryKey("env-1", "main"),
    );
    expect(queryKeys).toContainEqual(
      environmentGitDiffQueryKey("env-1", "all", "main"),
    );
    expect(queryKeys).not.toContainEqual(
      environmentWorkStatusQueryKey("env-1", null),
    );
    expect(queryKeys).not.toContainEqual(
      environmentGitDiffQueryKey("env-1", "commit", "abc123"),
    );
    expect(queryKeys).not.toContainEqual(
      environmentGitDiffQueryKey("env-2", "all", "main"),
    );
  });
});

describe("optimisticallyInsertThread", () => {
  it("does not treat the prefix-only threads key as an active thread list", () => {
    const { queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(threadsQueryKey(), []);

    optimisticallyInsertThread(queryClient, makeThreadWithRuntime());

    expect(
      queryClient.getQueryData<ThreadListEntry[]>(threadsQueryKey()),
    ).toEqual([]);
  });

  it("preserves the server-provided runtime state", () => {
    const { queryClient } = createQueryClientTestHarness();
    const threadListKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
    });
    queryClient.setQueryData(threadListKey, []);

    optimisticallyInsertThread(queryClient, makeThreadWithRuntime());

    const [thread] =
      queryClient.getQueryData<ThreadListEntry[]>(threadListKey) ?? [];
    expect(thread?.runtime).toEqual({
      displayStatus: "waiting-for-host",
      hostReconnectGraceExpiresAt: null,
    });
  });
});

describe("getEnvironmentActionInvalidationQueryKeys", () => {
  it("targets environment-scoped queries", () => {
    expect(
      getEnvironmentActionInvalidationQueryKeys({
        environmentId: "env-1",
      }),
    ).toEqual([
      ["environmentWorkStatus", "env-1"],
      ["environmentGitDiff", "env-1"],
      ["environmentPromotion", "env-1"],
      ["environmentMergeBaseBranches", "env-1"],
      ["threads"],
    ]);
  });
});
