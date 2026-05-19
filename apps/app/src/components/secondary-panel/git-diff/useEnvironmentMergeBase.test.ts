import type { Environment, WorkspaceStatus } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  resolveEffectiveMergeBaseBranch,
  resolvePersistedMergeBaseBranch,
  shouldSyncSelectedMergeBaseBranch,
} from "./useEnvironmentMergeBase";

type EnvironmentOverrides = Partial<Environment>;
type WorkspaceStatusOverrides = Partial<WorkspaceStatus>;

function makeEnvironment(overrides: EnvironmentOverrides = {}): Environment {
  return {
    baseBranch: null,
    branchName: "bb/thread",
    cleanupMode: null,
    cleanupRequestedAt: null,
    createdAt: 1,
    defaultBranch: "main",
    hostId: "host-1",
    id: "env-1",
    isGitRepo: true,
    isWorktree: true,
    managed: true,
    mergeBaseBranch: null,
    path: "/tmp/workspace",
    projectId: "project-1",
    status: "ready",
    updatedAt: 1,
    workspaceProvisionType: "managed-worktree",
    ...overrides,
  };
}

function makeWorkspaceStatus(
  overrides: WorkspaceStatusOverrides = {},
): WorkspaceStatus {
  return {
    branch: {
      currentBranch: "bb/thread",
      defaultBranch: "main",
    },
    mergeBase: null,
    workingTree: {
      deletions: 0,
      files: [],
      hasUncommittedChanges: false,
      insertions: 0,
      state: "clean",
    },
    ...overrides,
  };
}

describe("shouldSyncSelectedMergeBaseBranch", () => {
  it("syncs when the environment changes", () => {
    expect(
      shouldSyncSelectedMergeBaseBranch({
        previousStateKey: "env-1",
        nextStateKey: "env-2",
        persistedMergeBaseBranch: "release",
        selectedMergeBaseBranch: "main",
        updatePending: false,
      }),
    ).toBe(true);
  });

  it("syncs when the persisted merge base changes for the same environment", () => {
    expect(
      shouldSyncSelectedMergeBaseBranch({
        previousStateKey: "env-1",
        nextStateKey: "env-1",
        persistedMergeBaseBranch: "release",
        selectedMergeBaseBranch: "main",
        updatePending: false,
      }),
    ).toBe(true);
  });

  it("does not overwrite the local selection while the current environment update is pending", () => {
    expect(
      shouldSyncSelectedMergeBaseBranch({
        previousStateKey: "env-1",
        nextStateKey: "env-1",
        persistedMergeBaseBranch: null,
        selectedMergeBaseBranch: "release",
        updatePending: true,
      }),
    ).toBe(false);
  });
});

describe("resolveEffectiveMergeBaseBranch", () => {
  it("prefers the selected branch", () => {
    expect(
      resolveEffectiveMergeBaseBranch({
        environment: makeEnvironment({
          baseBranch: "release",
          mergeBaseBranch: "develop",
        }),
        selectedMergeBaseBranch: "main",
        workspaceStatus: makeWorkspaceStatus(),
      }),
    ).toBe("main");
  });

  it("uses the persisted merge-base override before the provisioned worktree base", () => {
    expect(
      resolveEffectiveMergeBaseBranch({
        environment: makeEnvironment({
          baseBranch: "release",
          mergeBaseBranch: "develop",
        }),
        workspaceStatus: makeWorkspaceStatus(),
      }),
    ).toBe("develop");
  });

  it("uses a managed worktree's base branch before the repository default", () => {
    expect(
      resolveEffectiveMergeBaseBranch({
        environment: makeEnvironment({ baseBranch: "release" }),
        workspaceStatus: makeWorkspaceStatus({
          branch: {
            currentBranch: "bb/thread",
            defaultBranch: "main",
          },
        }),
      }),
    ).toBe("release");
  });

  it("falls back to the live workspace default branch", () => {
    expect(
      resolveEffectiveMergeBaseBranch({
        environment: makeEnvironment({ defaultBranch: "master" }),
        workspaceStatus: makeWorkspaceStatus({
          branch: {
            currentBranch: "bb/thread",
            defaultBranch: "main",
          },
        }),
      }),
    ).toBe("main");
  });
});

describe("resolvePersistedMergeBaseBranch", () => {
  it("clears the persisted override when selecting the provisioned worktree base", () => {
    expect(
      resolvePersistedMergeBaseBranch({
        branch: "release",
        environment: makeEnvironment({ baseBranch: "release" }),
        workspaceStatus: makeWorkspaceStatus(),
      }),
    ).toBeNull();
  });

  it("persists the repository default branch when the worktree was based on another branch", () => {
    expect(
      resolvePersistedMergeBaseBranch({
        branch: "main",
        environment: makeEnvironment({ baseBranch: "release" }),
        workspaceStatus: makeWorkspaceStatus(),
      }),
    ).toBe("main");
  });

  it("clears the persisted override when selecting the repository default for a default-based worktree", () => {
    expect(
      resolvePersistedMergeBaseBranch({
        branch: "main",
        environment: makeEnvironment(),
        workspaceStatus: makeWorkspaceStatus(),
      }),
    ).toBeNull();
  });
});
