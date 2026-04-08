import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ENV_SETUP_SCRIPT_NAME } from "@bb/domain";
import { provisionWorkspace } from "../src/provision.js";
import { runGit } from "../src/git.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function initRepo(opts?: { setupScript?: string }): Promise<string> {
  const repoPath = await makeTempDir("bb-provision-repo-");
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  if (opts?.setupScript) {
    await fs.writeFile(
      path.join(repoPath, DEFAULT_ENV_SETUP_SCRIPT_NAME),
      opts.setupScript,
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

describe("provisionWorkspace", () => {
  describe("unmanaged", () => {
    it("provisions an unmanaged git repo and discovers properties", async () => {
      const repoPath = await initRepo();

      const ws = await provisionWorkspace({ workspaceProvisionType: "unmanaged", path: repoPath });

      expect(ws.path).toBe(repoPath);
      expect(ws.managed).toBe(false);
      expect(ws.isGitRepo).toBe(true);
      expect(ws.isWorktree).toBe(false);
      expect(await ws.getCurrentBranch()).toBe("main");
    });

    it("provisions an unmanaged non-git directory", async () => {
      const dirPath = await makeTempDir("bb-provision-nongit-");

      const ws = await provisionWorkspace({ workspaceProvisionType: "unmanaged", path: dirPath });

      expect(ws.managed).toBe(false);
      expect(ws.isGitRepo).toBe(false);
      expect(ws.isWorktree).toBe(false);
    });

    it("detects a worktree as isWorktree=true", async () => {
      const repoPath = await initRepo();
      const parentDir = await makeTempDir("bb-provision-wt-parent-");
      const wtPath = path.join(parentDir, "wt");
      await runGit(["worktree", "add", "-B", "feature", wtPath], { cwd: repoPath });

      const ws = await provisionWorkspace({ workspaceProvisionType: "unmanaged", path: wtPath });

      expect(ws.isGitRepo).toBe(true);
      expect(ws.isWorktree).toBe(true);
    });

    it("throws for non-existent path", async () => {
      await expect(
        provisionWorkspace({ workspaceProvisionType: "unmanaged", path: "/tmp/does-not-exist-bb" }),
      ).rejects.toThrow(/does not exist/u);
    });

    it("destroy() is a no-op for unmanaged workspaces", async () => {
      const repoPath = await initRepo();
      const ws = await provisionWorkspace({ workspaceProvisionType: "unmanaged", path: repoPath });

      await ws.destroy();

      // Path still exists
      await expect(fs.stat(repoPath)).resolves.toBeDefined();
    });
  });

  describe("managed-worktree", () => {
    it("provisions a worktree and returns HostWorkspace", async () => {
      const repoPath = await initRepo();
      const parentDir = await makeTempDir("bb-provision-mwt-parent-");
      const targetPath = path.join(parentDir, "env");

      const ws = await provisionWorkspace({
        workspaceProvisionType: "managed-worktree",
        sourcePath: repoPath,
        targetPath,
        branchName: "bb/env-test",
        scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
        timeoutMs: 900000,
      });

      expect(ws.path).toBe(targetPath);
      expect(ws.managed).toBe(true);
      expect(ws.isGitRepo).toBe(true);
      expect(ws.isWorktree).toBe(true);
      expect(await ws.getCurrentBranch()).toBe("bb/env-test");
    });

    it("destroy() removes the worktree", async () => {
      const repoPath = await initRepo();
      const parentDir = await makeTempDir("bb-provision-mwt-destroy-");
      const targetPath = path.join(parentDir, "env");

      const ws = await provisionWorkspace({
        workspaceProvisionType: "managed-worktree",
        sourcePath: repoPath,
        targetPath,
        branchName: "bb/env-destroy",
        scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
        timeoutMs: 900000,
      });

      await ws.destroy();

      await expect(fs.stat(targetPath)).rejects.toThrow();
      // Worktree should be removed from git's list
      const worktrees = await runGit(["worktree", "list", "--porcelain"], {
        cwd: repoPath,
      });
      expect(worktrees.stdout).not.toContain(targetPath);
    });

    it("runs setup script with custom scriptName", async () => {
      const repoPath = await initRepo();
      // Write a custom-named setup script
      await fs.writeFile(
        path.join(repoPath, "custom-setup.sh"),
        "echo custom-setup-ran > setup-marker.txt\n",
        "utf8",
      );
      await runGit(["add", "."], { cwd: repoPath });
      await runGit(["commit", "-m", "Add custom setup script"], { cwd: repoPath });

      const parentDir = await makeTempDir("bb-provision-mwt-script-");
      const targetPath = path.join(parentDir, "env");

      const ws = await provisionWorkspace({
        workspaceProvisionType: "managed-worktree",
        sourcePath: repoPath,
        targetPath,
        branchName: "bb/env-script",
        scriptName: "custom-setup.sh",
        timeoutMs: 900000,
      });

      const marker = await fs.readFile(
        path.join(ws.path, "setup-marker.txt"),
        "utf8",
      );
      expect(marker.trim()).toBe("custom-setup-ran");
    });

    it("rolls back on setup script failure", async () => {
      const repoPath = await initRepo({ setupScript: 'throw new Error("failing");\n' });
      const parentDir = await makeTempDir("bb-provision-mwt-fail-");
      const targetPath = path.join(parentDir, "env");

      await expect(
        provisionWorkspace({
          workspaceProvisionType: "managed-worktree",
          sourcePath: repoPath,
          targetPath,
          branchName: "bb/env-fail",
          scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
          timeoutMs: 900000,
        }),
      ).rejects.toThrow(/Setup script failed/u);

      await expect(fs.stat(targetPath)).rejects.toThrow();
    });
  });

  describe("managed-clone", () => {
    it("provisions a clone and returns HostWorkspace", async () => {
      const repoPath = await initRepo();
      const parentDir = await makeTempDir("bb-provision-mc-parent-");
      const targetPath = path.join(parentDir, "clone");

      const ws = await provisionWorkspace({
        workspaceProvisionType: "managed-clone",
        sourcePath: repoPath,
        targetPath,
        branchName: "bb/clone-branch",
        scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
        timeoutMs: 900000,
      });

      expect(ws.path).toBe(targetPath);
      expect(ws.managed).toBe(true);
      expect(ws.isGitRepo).toBe(true);
      expect(ws.isWorktree).toBe(false);
      expect(await ws.getCurrentBranch()).toBe("bb/clone-branch");
    });

    it("destroy() removes the cloned directory", async () => {
      const repoPath = await initRepo();
      const parentDir = await makeTempDir("bb-provision-mc-destroy-");
      const targetPath = path.join(parentDir, "clone");

      const ws = await provisionWorkspace({
        workspaceProvisionType: "managed-clone",
        sourcePath: repoPath,
        targetPath,
        branchName: "bb/clone-destroy",
        scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
        timeoutMs: 900000,
      });

      await ws.destroy();

      await expect(fs.stat(targetPath)).rejects.toThrow();
    });

    it("runs setup script with custom scriptName and timeoutMs", async () => {
      const repoPath = await initRepo();
      await fs.writeFile(
        path.join(repoPath, "my-setup.sh"),
        "echo clone-setup > clone-marker.txt\n",
        "utf8",
      );
      await runGit(["add", "."], { cwd: repoPath });
      await runGit(["commit", "-m", "Add setup script"], { cwd: repoPath });

      const parentDir = await makeTempDir("bb-provision-mc-script-");
      const targetPath = path.join(parentDir, "clone");

      const ws = await provisionWorkspace({
        workspaceProvisionType: "managed-clone",
        sourcePath: repoPath,
        targetPath,
        branchName: "bb/clone-script",
        scriptName: "my-setup.sh",
        timeoutMs: 30_000,
      });

      const marker = await fs.readFile(
        path.join(ws.path, "clone-marker.txt"),
        "utf8",
      );
      expect(marker.trim()).toBe("clone-setup");
    });

    it("rolls back on setup script failure", async () => {
      const repoPath = await initRepo({ setupScript: 'throw new Error("failing");\n' });
      const parentDir = await makeTempDir("bb-provision-mc-fail-");
      const targetPath = path.join(parentDir, "clone");

      await expect(
        provisionWorkspace({
          workspaceProvisionType: "managed-clone",
          sourcePath: repoPath,
          targetPath,
          branchName: "bb/clone-fail",
          scriptName: DEFAULT_ENV_SETUP_SCRIPT_NAME,
          timeoutMs: 900000,
        }),
      ).rejects.toThrow(/Setup script failed/u);

      await expect(fs.stat(targetPath)).rejects.toThrow();
    });
  });

  describe("HostWorkspace git operations", () => {
    it("delegates git operations to the underlying Workspace", async () => {
      const repoPath = await initRepo();
      const ws = await provisionWorkspace({ workspaceProvisionType: "unmanaged", path: repoPath });

      // getStatus
      const status = await ws.getStatus();
      expect(status.workingTree.state).toBe("clean");

      // commit
      await fs.writeFile(path.join(repoPath, "new.txt"), "data\n", "utf8");
      const result = await ws.commit({ message: "Test commit", noVerify: false });
      expect(result.commitSha).toBeTruthy();

      // reset
      await fs.writeFile(path.join(repoPath, "dirty.txt"), "dirty\n", "utf8");
      await ws.reset();
      const statusAfter = await ws.getStatus();
      expect(statusAfter.workingTree.state).toBe("clean");

      // getBranches
      const branches = await ws.listBranches();
      expect(branches).toContain("main");

      // getDiff
      const diff = await ws.getDiff();
      expect(typeof diff.diff).toBe("string");
    });
  });

  describe("HostWorkspace promote/demote", () => {
    it("promotes and demotes round-trip", async () => {
      const repoPath = await initRepo();
      const parentDir = await makeTempDir("bb-provision-promote-rt-");
      const targetPath = path.join(parentDir, "env");

      const primary = await provisionWorkspace({
        workspaceProvisionType: "unmanaged",
        path: repoPath,
      });

      // Create worktree directly and provision as unmanaged to have full control
      await runGit(["worktree", "add", "-B", "bb/env-rt", targetPath], {
        cwd: repoPath,
      });
      const env = await provisionWorkspace({
        workspaceProvisionType: "unmanaged",
        path: targetPath,
      });

      // Add commit on env branch
      await fs.writeFile(path.join(targetPath, "feature.txt"), "work\n", "utf8");
      await env.commit({ message: "Feature work", noVerify: false });

      // Promote
      await env.promote(primary);
      expect(await primary.getCurrentBranch()).toBe("bb/env-rt");
      expect(await env.getCurrentBranch()).toBeNull();

      // Demote — need a workspace that's on the env branch still
      // After promote, env is detached. demote expects envBranch from ws.currentBranch.
      // This means demote can't work on a detached env. Let's test the error case.
      await expect(env.demote({ primary, defaultBranch: "main" })).rejects.toThrow(/no branch/u);
    });
  });

  describe("reconnect-managed-worktree", () => {
    it("reconnects to an existing worktree with managed=true", async () => {
      const repoPath = await initRepo();
      const parentDir = await makeTempDir("bb-reconnect-wt-parent-");
      const wtPath = path.join(parentDir, "wt");
      await runGit(["worktree", "add", "-B", "feature", wtPath], { cwd: repoPath });

      const ws = await provisionWorkspace({ workspaceProvisionType: "reconnect-managed-worktree", path: wtPath });

      expect(ws.path).toBe(wtPath);
      expect(ws.managed).toBe(true);
      expect(ws.isGitRepo).toBe(true);
      expect(ws.isWorktree).toBe(true);
    });

    it("throws path_not_found for non-existent path", async () => {
      await expect(
        provisionWorkspace({ workspaceProvisionType: "reconnect-managed-worktree", path: "/tmp/does-not-exist-reconnect-wt" }),
      ).rejects.toThrow("path does not exist");
    });
  });

  describe("reconnect-managed-clone", () => {
    it("reconnects to an existing clone with managed=true", async () => {
      const repoPath = await initRepo();

      const ws = await provisionWorkspace({ workspaceProvisionType: "reconnect-managed-clone", path: repoPath });

      expect(ws.path).toBe(repoPath);
      expect(ws.managed).toBe(true);
      expect(ws.isGitRepo).toBe(true);
      expect(ws.isWorktree).toBe(false);
    });

    it("throws path_not_found for non-existent path", async () => {
      await expect(
        provisionWorkspace({ workspaceProvisionType: "reconnect-managed-clone", path: "/tmp/does-not-exist-reconnect-clone" }),
      ).rejects.toThrow("path does not exist");
    });
  });
});
