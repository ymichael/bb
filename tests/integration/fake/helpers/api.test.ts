import { describe, expect, it } from "vitest";
import { requireEnvironmentMergeBaseBranch } from "../../helpers/api.js";
import { makeEnvironment } from "@bb/test-helpers/domain-fixtures";

describe("requireEnvironmentMergeBaseBranch", () => {
  it("prefers an explicit merge-base override", () => {
    expect(
      requireEnvironmentMergeBaseBranch(
        makeEnvironment({
          id: "env-test",
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
          id: "env-test",
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
          id: "env-test",
          baseBranch: null,
          defaultBranch: null,
          mergeBaseBranch: null,
        }),
      ),
    ).toThrow("Environment env-test has no merge base branch");
  });
});
