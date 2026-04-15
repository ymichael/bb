import type {
  WorkspaceMergeBase,
  WorkspaceStatus,
  WorkspaceWorkingTree,
} from "@bb/domain";

export function makeWorkspaceWorkingTree(
  overrides: Partial<WorkspaceWorkingTree> = {},
): WorkspaceWorkingTree {
  return {
    hasUncommittedChanges: false,
    state: "clean",
    insertions: 0,
    deletions: 0,
    files: [],
    ...overrides,
  };
}

export function makeWorkspaceMergeBase(
  overrides: Partial<WorkspaceMergeBase> = {},
): WorkspaceMergeBase {
  return {
    mergeBaseBranch: "main",
    baseRef: "main",
    aheadCount: 0,
    behindCount: 0,
    hasCommittedUnmergedChanges: false,
    commits: [],
    files: [],
    insertions: 0,
    deletions: 0,
    ...overrides,
  };
}

export function makeWorkspaceStatus(
  overrides: Partial<WorkspaceStatus> = {},
): WorkspaceStatus {
  return {
    workingTree: makeWorkspaceWorkingTree(),
    branch: { currentBranch: "main", defaultBranch: "main" },
    mergeBase: null,
    ...overrides,
  };
}
