import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchCommand } from "../../src/command-dispatch.js";
import {
  cleanupTempDirs,
  createHarness,
  makeTempDir,
  runGitCommand,
} from "./dispatch-helpers.js";

afterEach(cleanupTempDirs);

async function initBranchRepo(): Promise<string> {
  const repoPath = await makeTempDir("bb-host-branches-repo-");
  await runGitCommand(["init", "-b", "develop"], { cwd: repoPath });
  await runGitCommand(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGitCommand(["config", "user.email", "bb@example.com"], {
    cwd: repoPath,
  });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await runGitCommand(["add", "."], { cwd: repoPath });
  await runGitCommand(["commit", "-m", "Initial commit"], { cwd: repoPath });
  await runGitCommand(["branch", "main"], { cwd: repoPath });
  await runGitCommand(["branch", "release/1.2"], { cwd: repoPath });
  return repoPath;
}

describe("host.list_branches dispatch", () => {
  it("lists branches for a git repo and pins the default branch first", async () => {
    const repoPath = await initBranchRepo();
    const harness = createHarness();

    const result = await dispatchCommand(
      { type: "host.list_branches", path: repoPath },
      harness.dispatchOptions(),
    );

    expect(result.current).toBe("develop");
    expect(result.defaultBranch).toBe("main");
    expect(result.branches[0]).toBe("main");
    expect(result.branches).toHaveLength(3);
    expect(result.branches).toEqual(
      expect.arrayContaining(["main", "develop", "release/1.2"]),
    );
  });

  it("returns an empty list for non-git directories", async () => {
    const dirPath = await makeTempDir("bb-host-branches-nongit-");
    const harness = createHarness();

    const result = await dispatchCommand(
      { type: "host.list_branches", path: dirPath },
      harness.dispatchOptions(),
    );

    expect(result).toEqual({ branches: [], current: null, defaultBranch: null });
  });

  it("returns an empty list for missing paths", async () => {
    const parentPath = await makeTempDir("bb-host-branches-missing-parent-");
    const harness = createHarness();

    const result = await dispatchCommand(
      { type: "host.list_branches", path: path.join(parentPath, "missing") },
      harness.dispatchOptions(),
    );

    expect(result).toEqual({ branches: [], current: null, defaultBranch: null });
  });
});
