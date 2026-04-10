import { describe, expect, it } from "vitest";
import type {
  Thread,
  ThreadGitDiffResponse,
  WorkspaceStatus,
} from "@bb/domain";
import type {
  ThreadTimelineResponse,
} from "@bb/server-contract";
import {
  getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys,
  getEnvironmentActionInvalidationQueryKeys,
  getEnvironmentBranchListInvalidationQueryKeys,
  getEnvironmentRecordInvalidationQueryKeys,
  getEnvironmentWorkspaceStateInvalidationQueryKeys,
} from "./query-cache";
import {
  environmentGitDiffQueryKey,
  environmentWorkStatusQueryKey,
} from "./query-keys";
import {
  resolveEnvironmentGitDiffPlaceholder,
  resolveEnvironmentWorkStatusPlaceholder,
  resolveThreadPlaceholder,
  resolveThreadTimelinePlaceholder,
} from "./query-placeholders";
import {
  createQueryClientTestHarness,
} from "@/test/queryClientTestHarness";

function makeStatus(state: WorkspaceStatus["workingTree"]["state"]): WorkspaceStatus {
  return {
    workingTree: {
      hasUncommittedChanges: false,
      state,
      changedFiles: 0,
      insertions: 0,
      deletions: 0,
      files: [],
    },
    branch: {
      currentBranch: "feature",
      defaultBranch: "main",
    },
    mergeBase: {
      mergeBaseBranch: "main",
      baseRef: "origin/main",
      aheadCount: 0,
      behindCount: 0,
      hasCommittedUnmergedChanges: false,
      commits: [],
    },
  };
}

function makeGitDiffResponse(): ThreadGitDiffResponse {
  return {
    diff: "diff --git a/file b/file",
    truncated: false,
    shortstat: " 1 file changed, 1 insertion(+)\n",
    files: "M\tfile\n",
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
    const previousThread: Thread = {
      id: "thread-1",
      projectId: "project-1",
      automationId: null,
      providerId: "codex",
      type: "standard",
      createdAt: 1,
      status: "idle",
      updatedAt: 1,
      lastReadAt: 1,
      environmentId: null,
      title: null,
      titleFallback: null,
      parentThreadId: null,
      archivedAt: null,
      stopRequestedAt: null,
      deletedAt: null,
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
    const previousThread: Thread = {
      id: "thread-1",
      projectId: "project-1",
      automationId: null,
      providerId: "codex",
      type: "standard",
      createdAt: 1,
      status: "idle",
      updatedAt: 1,
      lastReadAt: 1,
      environmentId: null,
      title: null,
      titleFallback: null,
      parentThreadId: null,
      archivedAt: null,
      stopRequestedAt: null,
      deletedAt: null,
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
      rows: [
        {
          kind: "message",
          id: "assistant-1",
          message: {
            id: "assistant-1",
            kind: "assistant-text",
            threadId: "thread-1",
            text: "Done",
            sourceSeqStart: 1,
            sourceSeqEnd: 1,
            createdAt: 1,
            status: "completed",
          },
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
    ).toEqual([
      ["environment", "env-1"],
    ]);
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
    ]);
  });
});

describe("getEnvironmentBranchListInvalidationQueryKeys", () => {
  it("targets environment branch list queries", () => {
    expect(
      getEnvironmentBranchListInvalidationQueryKeys({
        environmentId: "env-1",
      }),
    ).toEqual([
      ["environmentMergeBaseBranches", "env-1"],
    ]);
  });
});

describe("getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys", () => {
  it("targets only merge-base-dependent work status and branch-based diff queries", () => {
    const { queryClient } = createQueryClientTestHarness();

    queryClient.setQueryData(environmentWorkStatusQueryKey("env-1", null), null);
    queryClient.setQueryData(environmentWorkStatusQueryKey("env-1", "main"), null);
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

    const queryKeys = getCachedEnvironmentRefWorkspaceStateInvalidationQueryKeys(queryClient, {
      environmentId: "env-1",
    });

    expect(queryKeys).toHaveLength(2);
    expect(queryKeys).toContainEqual(environmentWorkStatusQueryKey("env-1", "main"));
    expect(queryKeys).toContainEqual(environmentGitDiffQueryKey("env-1", "all", "main"));
    expect(queryKeys).not.toContainEqual(environmentWorkStatusQueryKey("env-1", null));
    expect(queryKeys).not.toContainEqual(
      environmentGitDiffQueryKey("env-1", "commit", "abc123"),
    );
    expect(queryKeys).not.toContainEqual(environmentGitDiffQueryKey("env-2", "all", "main"));
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
      ["environmentMergeBaseBranches", "env-1"],
      ["threads"],
    ]);
  });
});
