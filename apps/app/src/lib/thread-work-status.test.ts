import { describe, expect, it } from "vitest";
import type { ThreadWorkStatus } from "@bb/core";
import {
  getThreadGitStatusDisplay,
  threadWorkStatusDescription,
  threadWorkStatusVariant,
  threadWorktreeCleanLabel,
} from "./thread-work-status";

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

describe("thread-work-status", () => {
  it("uses destructive deleted variant for active threads", () => {
    expect(threadWorkStatusVariant(makeStatus("deleted"))).toBe("destructive");
  });

  it("uses neutral deleted variant for archived threads", () => {
    expect(
      threadWorkStatusVariant(makeStatus("deleted"), { isArchivedThread: true }),
    ).toBe("outline");
  });

  it("shows up-to-date clean label when branch is clean and synchronized", () => {
    expect(threadWorktreeCleanLabel(makeStatus("clean"))).toBe("Clean, Up to date");
  });

  it("shows clean label when branch is clean but behind merge base", () => {
    expect(
      threadWorktreeCleanLabel({
        ...makeStatus("clean"),
        behindCount: 4,
      }),
    ).toBe("Clean");
  });

  it("shows untracked label for non-git workspaces", () => {
    expect(threadWorktreeCleanLabel(makeStatus("untracked"))).toBe("Untracked");
    expect(threadWorkStatusVariant(makeStatus("untracked"))).toBe("outline");
  });

  it("describes dirty workspaces with a short explanation", () => {
    expect(threadWorkStatusDescription(makeStatus("dirty_uncommitted"))).toBe(
      "You have local changes that have not been committed yet.",
    );
  });

  it("describes synchronized clean workspaces as having no local changes", () => {
    expect(threadWorkStatusDescription(makeStatus("clean"))).toBe(
      "No local changes or unmerged commits.",
    );
  });

  it("describes clean branches that are behind their merge base", () => {
    expect(
      threadWorkStatusDescription({
        ...makeStatus("clean"),
        behindCount: 2,
      }),
    ).toBe(
      "No local file changes, but this branch is behind its merge base.",
    );
  });

  it("reports behind branches as an explicit git status display", () => {
    expect(
      getThreadGitStatusDisplay(
        {
          ...makeStatus("clean"),
          behindCount: 3,
        },
        {
          mergeBaseBranch: "main",
          showBranchComparison: true,
        },
      ),
    ).toEqual({
      label: "Behind",
      summary: "3 behind main",
    });
  });

  it("reports diverged branches as an explicit git status display", () => {
    expect(
      getThreadGitStatusDisplay(
        {
          ...makeStatus("clean"),
          aheadCount: 2,
          behindCount: 1,
        },
        {
          mergeBaseBranch: "main",
          showBranchComparison: true,
        },
      ),
    ).toEqual({
      label: "Diverged",
      summary: "2 ahead, 1 behind relative to main",
    });
  });

  it("reports ahead branches as an explicit git status display", () => {
    expect(
      getThreadGitStatusDisplay(
        {
          ...makeStatus("committed_unmerged"),
          aheadCount: 2,
        },
        {
          mergeBaseBranch: "main",
          showBranchComparison: true,
        },
      ),
    ).toEqual({
      label: "Ahead",
      summary: "2 ahead of main",
    });
  });

  it("reports dirty work with a change summary", () => {
    expect(
      getThreadGitStatusDisplay({
        ...makeStatus("dirty_uncommitted"),
        workspaceChangedFiles: 3,
        workspaceInsertions: 8,
        workspaceDeletions: 2,
      }),
    ).toEqual({
      label: "Dirty",
      summary: "3 files, +8 -2",
    });
  });
});
