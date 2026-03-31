import { describe, expect, it } from "vitest"
import type {
  WorkspaceStatus,
} from "@bb/domain"
import { HttpError } from "./api"
import {
  isArchiveForceRequiredError,
  requiresArchiveConfirmation,
} from "./thread-archive"

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
  }
}

function makeEnvironment(
  managed: boolean,
) {
  return { managed }
}

describe("thread-archive", () => {
  it("does not warn for dirty direct workspaces", () => {
    expect(
      requiresArchiveConfirmation(
        makeStatus("dirty_uncommitted"),
        makeEnvironment(false),
      ),
    ).toBe(false)
  })

  it("warns for dirty isolated workspaces", () => {
    expect(
      requiresArchiveConfirmation(
        makeStatus("dirty_and_committed_unmerged"),
        makeEnvironment(true),
      ),
    ).toBe(true)
  })

  it("does not warn for clean or deleted isolated workspaces", () => {
    expect(
      requiresArchiveConfirmation(
        makeStatus("clean"),
        makeEnvironment(true),
      ),
    ).toBe(false)
    expect(
      requiresArchiveConfirmation(
        makeStatus("deleted"),
        makeEnvironment(true),
      ),
    ).toBe(false)
  })

  it("recognizes force-required archive conflicts", () => {
    expect(
      isArchiveForceRequiredError(
        new HttpError({
          status: 409,
          message: "Thread workspace has uncommitted or unmerged work",
          code: "worktree_not_clean",
        }),
      ),
    ).toBe(true)
    expect(
      isArchiveForceRequiredError(
        new HttpError({
          status: 500,
          message: "Internal error",
          code: "internal_error",
        }),
      ),
    ).toBe(false)
  })
})
