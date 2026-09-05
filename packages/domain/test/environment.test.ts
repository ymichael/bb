import { describe, expect, it } from "vitest";
import { resolveEnvironmentMergeBaseBranch } from "../src/environment.js";

describe("resolveEnvironmentMergeBaseBranch", () => {
  it("prefers an explicit merge-base override", () => {
    expect(
      resolveEnvironmentMergeBaseBranch({
        baseBranch: "release",
        defaultBranch: "main",
        mergeBaseBranch: "develop",
      }),
    ).toBe("develop");
  });

  it("uses the worktree base branch before the repository default branch", () => {
    expect(
      resolveEnvironmentMergeBaseBranch({
        baseBranch: "release",
        defaultBranch: "main",
        mergeBaseBranch: null,
      }),
    ).toBe("release");
  });

  it("falls back to the repository default branch", () => {
    expect(
      resolveEnvironmentMergeBaseBranch({
        baseBranch: null,
        defaultBranch: "main",
        mergeBaseBranch: null,
      }),
    ).toBe("main");
  });
});
