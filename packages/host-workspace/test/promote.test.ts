import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ENV_SETUP_SCRIPT_NAME } from "@bb/domain";
import { Workspace } from "../src/workspace.js";
import { createWorktree } from "../src/provisioning.js";
import { promoteWorkspace, demoteWorkspace } from "../src/promote.js";
import { runGit, WorkspaceError } from "../src/git.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function initRepo(): Promise<string> {
  const repoPath = await makeTempDir("bb-workspace-promote-repo-");
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await runGit(["add", "README.md"], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  return repoPath;
}

async function createPrimaryAndWorktree(): Promise<{
  primaryRepo: string;
  worktreePath: string;
}> {
  const primaryRepo = await initRepo();
  const worktreeParent = await makeTempDir("bb-workspace-promote-worktree-parent-");
  const worktreePath = path.join(worktreeParent, "env");
  await createWorktree({
    sourcePath: primaryRepo,
    targetPath: worktreePath,
    branchName: "bb/env-test",
    scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
    timeoutMs: 900000,
  });
  await fs.writeFile(path.join(worktreePath, "feature.txt"), "feature work\n", "utf8");
  await runGit(["add", "."], { cwd: worktreePath });
  await runGit(["commit", "-m", "Feature work"], { cwd: worktreePath });
  return { primaryRepo, worktreePath };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("promoteWorkspace", () => {
  it("promotes: primary is on env branch and source is detached", async () => {
    const { primaryRepo, worktreePath } = await createPrimaryAndWorktree();
    const source = new Workspace(worktreePath);
    const primary = new Workspace(primaryRepo);

    await promoteWorkspace(source, primary);

    expect(await primary.currentBranch).toBe("bb/env-test");
    expect(await source.currentBranch).toBeUndefined();
  });

  it("fails if source is dirty", async () => {
    const { primaryRepo, worktreePath } = await createPrimaryAndWorktree();
    await fs.writeFile(path.join(worktreePath, "feature.txt"), "dirty\n", "utf8");

    const source = new Workspace(worktreePath);
    const primary = new Workspace(primaryRepo);

    await expect(promoteWorkspace(source, primary)).rejects.toThrow(
      /uncommitted changes/u,
    );
    // Source should still be on its branch (not detached)
    expect(await source.currentBranch).toBe("bb/env-test");
  });

  it("fails if primary is dirty", async () => {
    const { primaryRepo, worktreePath } = await createPrimaryAndWorktree();
    await fs.writeFile(path.join(primaryRepo, "README.md"), "dirty primary\n", "utf8");

    const source = new Workspace(worktreePath);
    const primary = new Workspace(primaryRepo);

    await expect(promoteWorkspace(source, primary)).rejects.toThrow(
      /uncommitted changes/u,
    );
    // Primary should still be on main
    expect(await primary.currentBranch).toBe("main");
  });

  it("is idempotent when already promoted", async () => {
    const { primaryRepo, worktreePath } = await createPrimaryAndWorktree();
    const source = new Workspace(worktreePath);
    const primary = new Workspace(primaryRepo);

    await promoteWorkspace(source, primary);

    // Source is now detached, so a second promote should fail gracefully
    // because source has no branch
    await expect(promoteWorkspace(source, primary)).rejects.toThrow(
      /no branch/u,
    );
  });
});

describe("demoteWorkspace", () => {
  it("restores primary to default branch and reattaches source", async () => {
    const { primaryRepo, worktreePath } = await createPrimaryAndWorktree();
    const source = new Workspace(worktreePath);
    const primary = new Workspace(primaryRepo);

    await promoteWorkspace(source, primary);

    expect(await primary.currentBranch).toBe("bb/env-test");
    expect(await source.currentBranch).toBeUndefined();

    await demoteWorkspace({ source, primary, defaultBranch: "main", envBranch: "bb/env-test" });

    expect(await primary.currentBranch).toBe("main");
    expect(await source.currentBranch).toBe("bb/env-test");
  });

  it("fails if primary is dirty", async () => {
    const { primaryRepo, worktreePath } = await createPrimaryAndWorktree();
    const source = new Workspace(worktreePath);
    const primary = new Workspace(primaryRepo);

    await promoteWorkspace(source, primary);
    await fs.writeFile(path.join(primaryRepo, "README.md"), "dirty demote\n", "utf8");

    await expect(
      demoteWorkspace({ source, primary, defaultBranch: "main", envBranch: "bb/env-test" }),
    ).rejects.toThrow(/uncommitted changes/u);

    // Primary should still be on the env branch
    expect(await primary.currentBranch).toBe("bb/env-test");
  });
});
