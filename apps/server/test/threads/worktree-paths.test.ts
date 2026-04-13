import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import {
  deriveRepoDirName,
  resolveManagedTargetPath,
} from "../../src/services/threads/worktree-paths.js";

describe("deriveRepoDirName", () => {
  it.each([
    ["local absolute path", "/Users/someone/code/my-repo", "my-repo"],
    ["local path with trailing slash", "/Users/someone/code/my-repo/", "my-repo"],
    ["https URL", "https://github.com/octocat/Hello-World.git", "Hello-World"],
    ["ssh URL", "ssh://git@github.com/octocat/Hello-World.git", "Hello-World"],
    ["scp-style", "git@github.com:octocat/Hello-World.git", "Hello-World"],
    ["scp-style without .git", "git@github.com:octocat/Hello-World", "Hello-World"],
    ["dotted name", "/Users/me/code/my.repo", "my.repo"],
  ])("derives %s", (_label, input, expected) => {
    expect(deriveRepoDirName(input)).toBe(expected);
  });

  it.each([
    ["root-only path", "/"],
    ["empty string", ""],
    ["bare .git", "/Users/me/code/.git"],
    ["parent traversal", "/Users/me/code/.."],
    ["current dir", "/Users/me/code/."],
    ["leading dash (could be interpreted as flag)", "/tmp/-dangerous"],
    ["whitespace in name", "/tmp/my repo"],
    ["url with query parameter encoded into basename", "https://host/foo/bar.git;param=x"],
  ])("rejects %s", (_label, input) => {
    expect(() => deriveRepoDirName(input)).toThrowError(ApiError);
  });
});

describe("resolveManagedTargetPath", () => {
  it("composes dataDir + environmentId + derived repo name", () => {
    expect(
      resolveManagedTargetPath({
        dataDir: "/Users/someone/.bb",
        environmentId: "env_456",
        sourcePath: "/Users/someone/code/my-repo",
      }),
    ).toBe("/Users/someone/.bb/worktrees/env_456/my-repo");
  });

  it("uses the repo basename of a remote clone url", () => {
    expect(
      resolveManagedTargetPath({
        dataDir: "/tmp/bb-data",
        environmentId: "env_456",
        sourcePath: "https://github.com/octocat/Hello-World.git",
      }),
    ).toBe("/tmp/bb-data/worktrees/env_456/Hello-World");
  });
});
