import { describe, expect, it } from "vitest"
import type {
  SystemEnvironmentInfo,
  ThreadWorkStatus,
} from "@beanbag/agent-core"
import { requiresArchiveConfirmation } from "./thread-archive"

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
  }
}

function makeEnvironment(
  isolatedWorkspace: boolean,
): SystemEnvironmentInfo {
  return {
    id: isolatedWorkspace ? "worktree" : "local",
    displayName: isolatedWorkspace ? "Git Worktree Workspace" : "Direct Workspace",
    capabilities: {
      host_filesystem: true,
      isolated_workspace: isolatedWorkspace,
      promote_primary_checkout: isolatedWorkspace,
      demote_primary_checkout: isolatedWorkspace,
      squash_merge: isolatedWorkspace,
    },
  }
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
})
