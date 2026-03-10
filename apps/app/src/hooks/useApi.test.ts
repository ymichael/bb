import { describe, expect, it } from "vitest";
import type { Thread, ThreadGitDiffResponse, ThreadWorkStatus } from "@beanbag/agent-core";
import {
  resolveThreadPlaceholder,
  resolveThreadGitDiffPlaceholder,
  resolveThreadWorkStatusPlaceholder,
} from "./useApi";

function makeStatus(state: ThreadWorkStatus["state"]): ThreadWorkStatus {
  return {
    state,
    changedFiles: 0,
    insertions: 0,
    deletions: 0,
    workspaceChangedFiles: 0,
    workspaceInsertions: 0,
    workspaceDeletions: 0,
    hasUncommittedChanges: false,
    hasCommittedUnmergedChanges: false,
    aheadCount: 0,
    behindCount: 0,
  };
}

function makeGitDiffResponse(): ThreadGitDiffResponse {
  return {
    mode: "worktree_commits",
    currentBranch: "feat/test",
    mergeBaseBranch: "main",
    mergeBaseRef: "origin/main",
    commits: [],
    selection: { type: "combined" },
    diff: "diff --git a/file b/file",
    truncated: false,
  };
}

describe("resolveThreadWorkStatusPlaceholder", () => {
  it("keeps previous data when only merge-base selection changes", () => {
    const previousStatus = makeStatus("clean");

    expect(
      resolveThreadWorkStatusPlaceholder(
        previousStatus,
        ["threadWorkStatus", "thread-1", null],
        "thread-1",
      ),
    ).toBe(previousStatus);
  });

  it("drops previous data when switching to a different thread", () => {
    const previousStatus = makeStatus("deleted");

    expect(
      resolveThreadWorkStatusPlaceholder(
        previousStatus,
        ["threadWorkStatus", "thread-1", null],
        "thread-2",
      ),
    ).toBeUndefined();
  });

  it("preserves null placeholders only for the same thread", () => {
    expect(
      resolveThreadWorkStatusPlaceholder(
        null,
        ["threadWorkStatus", "thread-1", null],
        "thread-1",
      ),
    ).toBeNull();

    expect(
      resolveThreadWorkStatusPlaceholder(
        null,
        ["threadWorkStatus", "thread-1", null],
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
      createdAt: 1,
      status: "idle",
      updatedAt: 1,
      lastReadAt: 1,
      builtInActions: [],
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
      createdAt: 1,
      status: "idle",
      updatedAt: 1,
      lastReadAt: 1,
      builtInActions: [],
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

describe("resolveThreadGitDiffPlaceholder", () => {
  it("keeps previous data for the same thread while changing git diff options", () => {
    const previousGitDiff = makeGitDiffResponse();

    expect(
      resolveThreadGitDiffPlaceholder(
        previousGitDiff,
        ["threadGitDiff", "thread-1", "combined", "combined", null],
        "thread-1",
      ),
    ).toBe(previousGitDiff);
  });

  it("drops previous data when switching to a different thread", () => {
    const previousGitDiff = makeGitDiffResponse();

    expect(
      resolveThreadGitDiffPlaceholder(
        previousGitDiff,
        ["threadGitDiff", "thread-1", "combined", "combined", null],
        "thread-2",
      ),
    ).toBeUndefined();
  });
});
