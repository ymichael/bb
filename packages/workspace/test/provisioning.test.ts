import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Workspace,
  createClone,
  createWorktree,
  removeDirectory,
  removeWorktree,
  runSetupScript,
} from "../src/index.js";
import { runGit } from "../src/git.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function initRepoWithOptionalSetup(
  setupScript?: string,
): Promise<string> {
  const repoPath = await makeTempDir("bb-provisioning-repo-");
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  if (setupScript) {
    await fs.writeFile(
      path.join(repoPath, ".bb-env-setup.sh"),
      setupScript,
      "utf8",
    );
  }
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  return repoPath;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("workspace provisioning", () => {
  it("creates worktrees and is idempotent for valid targets", async () => {
    const sourceRepo = await initRepoWithOptionalSetup();
    const parentDir = await makeTempDir("bb-worktree-parent-");
    const targetPath = path.join(parentDir, "feature");

    const first = await createWorktree({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "feature",
    });
    const second = await createWorktree({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "feature",
    });

    expect(first.path).toBe(targetPath);
    expect(second.path).toBe(targetPath);
    expect(await new Workspace(targetPath).currentBranch).toBe("feature");
  });

  it("rolls back failed worktree setup scripts", async () => {
    const sourceRepo = await initRepoWithOptionalSetup(
      "echo failing\nexit 1\n",
    );
    const parentDir = await makeTempDir("bb-worktree-fail-parent-");
    const targetPath = path.join(parentDir, "broken");

    await expect(
      createWorktree({
        sourcePath: sourceRepo,
        targetPath,
        branchName: "broken",
      }),
    ).rejects.toThrow(/Setup script failed/u);

    await expect(fs.stat(targetPath)).rejects.toThrow();
  });

  it("creates clones and checks out the requested branch", async () => {
    const sourceRepo = await initRepoWithOptionalSetup();
    const parentDir = await makeTempDir("bb-clone-parent-");
    const targetPath = path.join(parentDir, "clone");

    await createClone({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "clone-branch",
    });

    expect(await new Workspace(targetPath).currentBranch).toBe("clone-branch");
  });

  it("streams setup script output and respects timeouts", async () => {
    const workspacePath = await makeTempDir("bb-setup-script-");
    await fs.writeFile(
      path.join(workspacePath, ".bb-env-setup.sh"),
      "echo first\necho second\n",
      "utf8",
    );

    const entries: string[] = [];
    const result = await runSetupScript({
      workspacePath,
      onProgress: (entry) => entries.push(`${entry.type}:${entry.text}`),
    });
    expect(result.ran).toBe(true);
    expect(result.output).toContain("first");
    expect(entries.some((entry) => entry.includes("first"))).toBe(true);

    await fs.writeFile(
      path.join(workspacePath, ".bb-env-setup.sh"),
      "sleep 2\n",
      "utf8",
    );
    await expect(
      runSetupScript({
        workspacePath,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/u);
  });

  it("returns a no-op when the setup script is missing", async () => {
    const workspacePath = await makeTempDir("bb-setup-noop-");

    await expect(runSetupScript({ workspacePath })).resolves.toEqual({ ran: false });
  });

  it("removes worktrees and plain directories", async () => {
    const sourceRepo = await initRepoWithOptionalSetup();
    const parentDir = await makeTempDir("bb-remove-parent-");
    const targetPath = path.join(parentDir, "feature");

    await createWorktree({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "feature",
    });
    await fs.writeFile(path.join(targetPath, "local.txt"), "dirty\n", "utf8");
    await removeWorktree({ path: targetPath, force: true });
    await expect(fs.stat(targetPath)).rejects.toThrow();
    const worktrees = await runGit(["worktree", "list", "--porcelain"], {
      cwd: sourceRepo,
    });
    expect(worktrees.stdout).not.toContain(targetPath);

    const directoryPath = await makeTempDir("bb-remove-dir-");
    await fs.writeFile(path.join(directoryPath, "file.txt"), "data\n", "utf8");
    await removeDirectory({ path: directoryPath });
    await expect(fs.stat(directoryPath)).rejects.toThrow();
  });
});
