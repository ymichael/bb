import type { Environment } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { requireEnvironmentMergeBaseBranch } from "../../helpers/api.js";

type EnvironmentOverrides = Partial<Environment>;

function makeEnvironment(overrides: EnvironmentOverrides = {}): Environment {
  return {
    baseBranch: null,
    branchName: "bb/thread",
    cleanupMode: null,
    cleanupRequestedAt: null,
    createdAt: 1,
    defaultBranch: "main",
    hostId: "host-1",
    id: "env-test",
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

describe("requireEnvironmentMergeBaseBranch", () => {
  it("prefers an explicit merge-base override", () => {
    expect(
      requireEnvironmentMergeBaseBranch(
        makeEnvironment({
          baseBranch: "release",
          mergeBaseBranch: "develop",
        }),
      ),
    ).toBe("develop");
  });

  it("uses the environment base branch before the repository default", () => {
    expect(
      requireEnvironmentMergeBaseBranch(
        makeEnvironment({
          baseBranch: "release",
          defaultBranch: "main",
          mergeBaseBranch: null,
        }),
      ),
    ).toBe("release");
  });

  it("throws when the environment has no merge-base candidate", () => {
    expect(() =>
      requireEnvironmentMergeBaseBranch(
        makeEnvironment({
          baseBranch: null,
          defaultBranch: null,
          mergeBaseBranch: null,
        }),
      ),
    ).toThrow("Environment env-test has no merge base branch");
  });
});
