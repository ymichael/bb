import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ENV_SETUP_SCRIPT_NAME,
  LEGACY_POSIX_ENV_SETUP_SCRIPT_NAME,
} from "@bb/domain";
import { Workspace } from "../src/workspace.js";
import {
  createClone,
  createWorktree,
  removeDirectory,
  removeWorktree,
  runSetupScript,
} from "../src/provisioning.js";
import { runGit } from "../src/git.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function initRepoWithOptionalSetup(
  setupScript?: string,
  scriptName: string = DEFAULT_ENV_SETUP_SCRIPT_NAME,
): Promise<string> {
  const repoPath = await makeTempDir("bb-provisioning-repo-");
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  if (setupScript) {
    await fs.writeFile(
      path.join(repoPath, scriptName),
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
      scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
      timeoutMs: 900000,
    });
    const second = await createWorktree({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "feature",
      scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
      timeoutMs: 900000,
    });

    expect(first.path).toBe(targetPath);
    expect(second.path).toBe(targetPath);
    expect(await new Workspace(targetPath).currentBranch).toBe("feature");
  });

  it("rolls back failed worktree setup scripts", async () => {
    const sourceRepo = await initRepoWithOptionalSetup(
      'throw new Error("failing");\n',
    );
    const parentDir = await makeTempDir("bb-worktree-fail-parent-");
    const targetPath = path.join(parentDir, "broken");

    await expect(
      createWorktree({
        sourcePath: sourceRepo,
        targetPath,
        branchName: "broken",
        scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
        timeoutMs: 900000,
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
      scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
      timeoutMs: 900000,
    });

    expect(await new Workspace(targetPath).currentBranch).toBe("clone-branch");
  });

  it("rolls back failed clone setup scripts", async () => {
    const sourceRepo = await initRepoWithOptionalSetup(
      'throw new Error("failing");\n',
    );
    const parentDir = await makeTempDir("bb-clone-fail-parent-");
    const targetPath = path.join(parentDir, "broken-clone");

    await expect(
      createClone({
        sourcePath: sourceRepo,
        targetPath,
        branchName: "broken-clone",
        scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
        timeoutMs: 900000,
      }),
    ).rejects.toThrow(/Setup script failed/u);

    await expect(fs.stat(targetPath)).rejects.toThrow();
  });

  it("creates nested clone targets when parent directories do not exist", async () => {
    const sourceRepo = await initRepoWithOptionalSetup();
    const parentDir = await makeTempDir("bb-clone-nested-parent-");
    const targetPath = path.join(parentDir, ".bb-worktrees", "proj_123", "thr_456");

    await createClone({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "clone-branch",
      scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
      timeoutMs: 900000,
    });

    expect(await new Workspace(targetPath).currentBranch).toBe("clone-branch");
  });

  it("creates nested worktree targets when parent directories do not exist", async () => {
    const sourceRepo = await initRepoWithOptionalSetup();
    const parentDir = await makeTempDir("bb-worktree-nested-parent-");
    const targetPath = path.join(parentDir, ".bb-worktrees", "proj_123", "thr_456");

    await createWorktree({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "feature",
      scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
      timeoutMs: 900000,
    });

    expect(await new Workspace(targetPath).currentBranch).toBe("feature");
  });

  it("passes explicit env overrides to git commands", async () => {
    const sourceRepo = await initRepoWithOptionalSetup();

    const result = await runGit(["var", "GIT_AUTHOR_IDENT"], {
      cwd: sourceRepo,
      env: {
        GIT_AUTHOR_EMAIL: "env@example.com",
        GIT_AUTHOR_NAME: "Env Author",
      },
    });

    expect(result.stdout).toContain("Env Author <env@example.com>");
  });

  it("streams setup script output and respects timeouts", async () => {
    const workspacePath = await makeTempDir("bb-setup-script-");
    await fs.writeFile(
      path.join(workspacePath, DEFAULT_ENV_SETUP_SCRIPT_NAME),
      'console.log("first");\nconsole.log("second");\n',
      "utf8",
    );

    const entries: string[] = [];
    const result = await runSetupScript({
      workspacePath,
      scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
      timeoutMs: 900000,
      onProgress: (entry) => entries.push(`${entry.type}:${entry.text}`),
    });
    expect(result.ran).toBe(true);
    expect(result.output).toContain("first");
    expect(entries.some((entry) => entry.includes("first"))).toBe(true);

    await fs.writeFile(
      path.join(workspacePath, DEFAULT_ENV_SETUP_SCRIPT_NAME),
      'await new Promise((resolve) => setTimeout(resolve, 2_000));\n',
      "utf8",
    );
    await expect(
      runSetupScript({
        workspacePath,
        scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/u);
  });

  it("falls back to the legacy POSIX setup script when the new default is missing", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workspacePath = await makeTempDir("bb-setup-script-legacy-");
    await fs.writeFile(
      path.join(workspacePath, LEGACY_POSIX_ENV_SETUP_SCRIPT_NAME),
      "echo legacy-setup\n",
      "utf8",
    );

    const result = await runSetupScript({
      workspacePath,
      scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
      timeoutMs: 900000,
    });

    expect(result.ran).toBe(true);
    expect(result.output).toContain("legacy-setup");
  });

  it("returns a no-op when the setup script is missing", async () => {
    const workspacePath = await makeTempDir("bb-setup-noop-");

    await expect(runSetupScript({ workspacePath, scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME, timeoutMs: 900000 })).resolves.toEqual({ ran: false });
  });

  it("removes worktrees and plain directories", async () => {
    const sourceRepo = await initRepoWithOptionalSetup();
    const parentDir = await makeTempDir("bb-remove-parent-");
    const targetPath = path.join(parentDir, "feature");

    await createWorktree({
      sourcePath: sourceRepo,
      targetPath,
      branchName: "feature",
      scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
      timeoutMs: 900000,
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
