import { describe, expect, it } from "vitest";
import type { WorkspaceStatus } from "@bb/domain";
import {
  getGitStatusDisplay,
  workspaceStatusDescription,
  workspaceStatusVariant,
  threadWorktreeCleanLabel,
} from "./workspace-status";

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

describe("workspace-status", () => {
  it("uses destructive deleted variant for active threads", () => {
    expect(workspaceStatusVariant(makeStatus("deleted"))).toBe("destructive");
  });

  it("uses neutral deleted variant for archived threads", () => {
    expect(
      workspaceStatusVariant(makeStatus("deleted"), { isArchivedThread: true }),
    ).toBe("outline");
  });

  it("shows up-to-date clean label when branch is clean and synchronized", () => {
    expect(threadWorktreeCleanLabel(makeStatus("clean"))).toBe("Clean, Up to date");
  });

  it("shows clean label when branch is clean but behind merge base", () => {
    expect(
      threadWorktreeCleanLabel({
        ...makeStatus("clean"),
        mergeBase: {
          ...makeStatus("clean").mergeBase!,
          behindCount: 4,
        },
      }),
    ).toBe("Clean");
  });

  it("shows untracked label for non-git workspaces", () => {
    expect(threadWorktreeCleanLabel(makeStatus("untracked"))).toBe("Untracked");
    expect(workspaceStatusVariant(makeStatus("untracked"))).toBe("outline");
  });

  it("describes dirty workspaces with a short explanation", () => {
    expect(workspaceStatusDescription(makeStatus("dirty_uncommitted"))).toBe(
      "You have local changes that have not been committed yet.",
    );
  });

  it("describes synchronized clean workspaces as having no local changes", () => {
    expect(workspaceStatusDescription(makeStatus("clean"))).toBe(
      "No local changes or unmerged commits.",
    );
  });

  it("describes clean branches that are behind their merge base", () => {
    expect(
      workspaceStatusDescription({
        ...makeStatus("clean"),
        mergeBase: {
          ...makeStatus("clean").mergeBase!,
          behindCount: 2,
        },
      }),
    ).toBe(
      "No local file changes, but this branch is behind its merge base.",
    );
  });

  it("reports behind branches as an explicit git status display", () => {
    expect(
      getGitStatusDisplay(
        {
          ...makeStatus("clean"),
          mergeBase: {
            ...makeStatus("clean").mergeBase!,
            behindCount: 3,
          },
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
      getGitStatusDisplay(
        {
          ...makeStatus("clean"),
          mergeBase: {
            ...makeStatus("clean").mergeBase!,
            aheadCount: 2,
            behindCount: 1,
          },
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
      getGitStatusDisplay(
        {
          ...makeStatus("committed_unmerged"),
          mergeBase: {
            ...makeStatus("committed_unmerged").mergeBase!,
            aheadCount: 2,
            hasCommittedUnmergedChanges: true,
          },
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
      getGitStatusDisplay({
        ...makeStatus("dirty_uncommitted"),
        workingTree: {
          ...makeStatus("dirty_uncommitted").workingTree,
          changedFiles: 3,
          insertions: 8,
          deletions: 2,
        },
      }),
    ).toEqual({
      label: "Dirty",
      summary: "3 files, +8 -2",
    });
  });
});
