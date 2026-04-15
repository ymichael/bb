import { describe, expect, it } from "vitest";
import type { WorkspaceStatus } from "@bb/domain";
import { HttpError } from "./api";
import {
  getGitStatusDisplay,
  workspaceStatusDescription,
} from "./workspace-status";

interface MakeStatusOptions {
  aheadCount?: number;
  behindCount?: number;
  changedFiles?: number;
  deletions?: number;
  insertions?: number;
  state: WorkspaceStatus["workingTree"]["state"];
}

function makeStatus(options: MakeStatusOptions): WorkspaceStatus {
  const aheadCount = options.aheadCount ?? 0;
  const behindCount = options.behindCount ?? 0;
  const hasUncommittedChanges =
    options.state === "untracked" ||
    options.state === "dirty_uncommitted" ||
    options.state === "dirty_and_committed_unmerged";
  return {
    workingTree: {
      hasUncommittedChanges,
      state: options.state,
      changedFiles: options.changedFiles ?? 0,
      insertions: options.insertions ?? 0,
      deletions: options.deletions ?? 0,
      files: [],
    },
    branch: {
      currentBranch: "feature",
      defaultBranch: "main",
    },
    mergeBase: {
      mergeBaseBranch: "main",
      baseRef: "origin/main",
      aheadCount,
      behindCount,
      hasCommittedUnmergedChanges: aheadCount > 0,
      commits: [],
    },
  };
}

describe("workspace-status", () => {
  it("shows untracked label and copy for workspaces with only untracked files", () => {
    expect(workspaceStatusDescription(makeStatus({ state: "untracked" }))).toBe(
      "Workspace has untracked files that have not been committed yet.",
    );
    expect(getGitStatusDisplay(makeStatus({ changedFiles: 1, state: "untracked" }))).toEqual({
      label: "Untracked",
      summary: "1 file",
    });
  });

  it("describes dirty workspaces with a short explanation", () => {
    expect(workspaceStatusDescription(makeStatus({ state: "dirty_uncommitted" }))).toBe(
      "You have local changes that have not been committed yet.",
    );
  });

  it("describes synchronized clean workspaces as having no local changes", () => {
    expect(workspaceStatusDescription(makeStatus({ state: "clean" }))).toBe(
      "No local changes or unmerged commits.",
    );
  });

  it("describes clean branches that are behind their merge base", () => {
    expect(
      workspaceStatusDescription(makeStatus({ behindCount: 2, state: "clean" })),
    ).toBe(
      "No local file changes, but this branch is behind its merge base.",
    );
  });

  it("includes branch comparison in untracked status summaries", () => {
    expect(
      workspaceStatusDescription(makeStatus({
        behindCount: 2,
        changedFiles: 1,
        state: "untracked",
      })),
    ).toBe(
      "Workspace has untracked files, and this branch is behind its merge base.",
    );
    expect(
      getGitStatusDisplay(
        makeStatus({
          behindCount: 2,
          changedFiles: 1,
          state: "untracked",
        }),
        {
          mergeBaseBranch: "main",
          showBranchComparison: true,
        },
      ),
    ).toEqual({
      label: "Untracked",
      summary: "1 file • 2 behind main",
    });
  });

  it("reports behind branches as an explicit git status display", () => {
    expect(
      getGitStatusDisplay(
        makeStatus({ behindCount: 3, state: "clean" }),
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
        makeStatus({
          aheadCount: 2,
          behindCount: 1,
          state: "committed_unmerged",
        }),
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
        makeStatus({ aheadCount: 2, state: "committed_unmerged" }),
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
      getGitStatusDisplay(
        makeStatus({
          changedFiles: 3,
          deletions: 2,
          insertions: 8,
          state: "dirty_uncommitted",
        }),
      ),
    ).toEqual({
      label: "Dirty",
      summary: "3 files, +8 -2",
    });
  });

  it("reports dirty committed work with file and branch summaries", () => {
    expect(
      getGitStatusDisplay(
        makeStatus({
          aheadCount: 2,
          changedFiles: 3,
          deletions: 2,
          insertions: 8,
          state: "dirty_and_committed_unmerged",
        }),
        {
          mergeBaseBranch: "main",
          showBranchComparison: true,
        },
      ),
    ).toEqual({
      label: "Dirty",
      summary: "3 files, +8 -2 • 2 ahead of main",
    });
  });

  it("reports unavailable workspace status explicitly", () => {
    expect(getGitStatusDisplay(undefined)).toEqual({
      label: "Unknown",
      summary: "Workspace status unavailable.",
    });
    expect(workspaceStatusDescription(undefined)).toBe(
      "Workspace status is unavailable.",
    );
  });

  it("reports a deleted workspace when the path is gone", () => {
    const error = new HttpError({
      status: 502,
      message: "Managed workspace path does not exist",
      code: "path_not_found",
    });
    expect(getGitStatusDisplay(undefined, { error })).toEqual({
      label: "Deleted",
      summary: "Workspace deleted.",
    });
  });
});
