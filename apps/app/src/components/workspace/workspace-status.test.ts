import { describe, expect, it } from "vitest";
import type { WorkspaceStatus } from "@bb/domain";
import {
  makeWorkspaceMergeBase,
  makeWorkspaceStatus,
  makeWorkspaceWorkingTree,
} from "@bb/test-helpers";
import { BbHttpError } from "@bb/sdk/browser";
import { getGitStatusDisplay } from "./workspace-status";

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
  const fileCount = options.changedFiles ?? 0;
  const files = Array.from({ length: fileCount }, (_, index) => ({
    path: `file-${index}.ts`,
    status: "M" as const,
    insertions: null,
    deletions: null,
  }));
  return makeWorkspaceStatus({
    workingTree: makeWorkspaceWorkingTree({
      hasUncommittedChanges,
      state: options.state,
      insertions: options.insertions ?? 0,
      deletions: options.deletions ?? 0,
      files,
    }),
    checkout: {
      kind: "branch",
      branchName: "feature",
      headSha: null,
    },
    branch: {
      currentBranch: "feature",
      defaultBranch: "main",
    },
    mergeBase: makeWorkspaceMergeBase({
      baseRef: "origin/main",
      aheadCount,
      behindCount,
      hasCommittedUnmergedChanges: aheadCount > 0,
    }),
  });
}

describe("workspace-status", () => {
  it("reports untracked workspaces without echoing working-tree file counts", () => {
    expect(
      getGitStatusDisplay(makeStatus({ changedFiles: 1, state: "untracked" })),
    ).toMatchObject({
      label: "Untracked",
      summary: "",
    });
  });

  it("includes branch comparison in untracked status summaries", () => {
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
    ).toMatchObject({
      label: "Untracked",
      summary: "2 behind main",
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
    ).toMatchObject({
      label: "Diverged",
      summary: "2 ahead, 1 behind relative to main",
    });
  });

  it("reports dirty work without echoing the working-tree diff stats", () => {
    expect(
      getGitStatusDisplay(
        makeStatus({
          changedFiles: 3,
          deletions: 2,
          insertions: 8,
          state: "dirty_uncommitted",
        }),
      ),
    ).toMatchObject({
      label: "Dirty",
      summary: "",
    });
  });

  it("reports dirty committed work with only the branch comparison summary", () => {
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
    ).toMatchObject({
      label: "Dirty",
      summary: "2 ahead of main",
    });
  });

  it("reports unavailable workspace status explicitly", () => {
    expect(getGitStatusDisplay(undefined)).toMatchObject({
      label: "Unknown",
      summary: "Workspace status unavailable.",
    });
  });

  it("reports typed unavailable workspace failures explicitly", () => {
    expect(
      getGitStatusDisplay(undefined, {
        workspaceUnavailable: {
          code: "workspace_type_mismatch",
          workspacePath: "/tmp/current",
          message:
            "Loaded environment env_1 is bound to /tmp/old, not /tmp/current",
        },
      }),
    ).toMatchObject({
      label: "Unknown",
      summary:
        "Loaded environment env_1 is bound to /tmp/old, not /tmp/current",
    });
  });

  it("reports a missing workspace when the path is gone", () => {
    const error = new BbHttpError({
      status: 502,
      message: "Managed workspace path does not exist",
      code: "path_not_found",
      body: {
        code: "path_not_found",
        message: "Managed workspace path does not exist",
      },
    });
    expect(getGitStatusDisplay(undefined, { error })).toMatchObject({
      label: "Unknown",
      summary: "Workspace not found.",
    });
  });

  it("reports lifecycle-aware workspace errors before generic fallbacks", () => {
    const error = new BbHttpError({
      status: 409,
      message: "Environment unavailable",
      code: "environment_not_ready",
      body: {
        code: "environment_not_ready",
        message: "Environment unavailable",
        details: {
          environmentStatus: "destroyed",
          hasPath: false,
        },
      },
    });

    expect(
      getGitStatusDisplay(undefined, {
        error,
        workspaceDeleted: true,
      }),
    ).toMatchObject({
      label: "Unknown",
      summary: "Workspace no longer exists.",
    });
  });
});
