import { describe, expect, it } from "vitest";
import type {
  Thread,
  ThreadGitDiffResponse,
  ThreadWorkStatus,
} from "@bb/domain";
import type {
  ThreadTimelineResponse,
} from "@bb/server-contract";
import {
  appendOptimisticUserRowToTimeline,
  buildOptimisticUserThreadRow,
  resolveThreadPlaceholder,
  resolveThreadGitDiffPlaceholder,
  resolveThreadTimelinePlaceholder,
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
      providerId: "codex",
      type: "standard",
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
      providerId: "codex",
      type: "standard",
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
      contextWindowUsage: null,
    };

    expect(
      resolveThreadTimelinePlaceholder(
        previousTimeline,
        ["threadTimeline", "thread-1", null],
        "thread-1",
      ),
    ).toBe(previousTimeline);
  });

  it("drops previous timeline rows when switching to a different thread", () => {
    const previousTimeline: ThreadTimelineResponse = {
      rows: [],
      contextWindowUsage: null,
    };

    expect(
      resolveThreadTimelinePlaceholder(
        previousTimeline,
        ["threadTimeline", "thread-1", null],
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

describe("buildOptimisticUserThreadRow", () => {
  it("summarizes prompt text and attachments into a user row", () => {
    expect(
      buildOptimisticUserThreadRow(
        "thread-1",
        [
          { type: "text", text: "Investigate this" },
          { type: "localImage", path: "/tmp/screenshot.png" },
          { type: "localFile", path: "/tmp/log.txt" },
        ],
        123,
      ),
    ).toEqual({
      kind: "message",
      id: "optimistic-user-123",
      message: {
        id: "optimistic-user-123",
        kind: "user",
        threadId: "thread-1",
        text: "Investigate this",
        attachments: {
          webImages: 0,
          localImages: 1,
          localFiles: 1,
          localImagePaths: ["/tmp/screenshot.png"],
          localFilePaths: ["/tmp/log.txt"],
        },
        sourceSeqStart: Number.MAX_SAFE_INTEGER,
        sourceSeqEnd: Number.MAX_SAFE_INTEGER,
        createdAt: 123,
      },
    });
  });
});

describe("appendOptimisticUserRowToTimeline", () => {
  it("appends an optimistic user row while preserving context window usage", () => {
    const timeline: ThreadTimelineResponse = {
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
      contextWindowUsage: {
        totalTokens: 10,
        modelContextWindow: 100,
      },
    };

    expect(
      appendOptimisticUserRowToTimeline(
        timeline,
        "thread-1",
        [{ type: "text", text: "Follow up" }],
        456,
      ),
    ).toEqual({
      rows: [
        timeline.rows[0],
        {
          kind: "message",
          id: "optimistic-user-456",
          message: {
            id: "optimistic-user-456",
            kind: "user",
            threadId: "thread-1",
            text: "Follow up",
            sourceSeqStart: Number.MAX_SAFE_INTEGER,
            sourceSeqEnd: Number.MAX_SAFE_INTEGER,
            createdAt: 456,
          },
        },
      ],
      contextWindowUsage: timeline.contextWindowUsage,
    });
  });
});
