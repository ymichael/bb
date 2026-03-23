import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Workspace,
  WorkspaceError,
  exportWorkspace,
  importWorkspace,
} from "../src/index.js";
import { runGit } from "../src/git.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function initRepo(): Promise<string> {
  const repoPath = await makeTempDir("bb-workspace-repo-");
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await runGit(["add", "README.md"], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  return repoPath;
}

async function initBareRemoteFrom(repoPath: string): Promise<string> {
  const remotePath = await makeTempDir("bb-workspace-remote-");
  const barePath = `${remotePath}.git`;
  await runGit(["clone", "--bare", repoPath, barePath], {
    cwd: path.dirname(repoPath),
  });
  await runGit(["remote", "add", "origin", barePath], { cwd: repoPath });
  await runGit(["push", "-u", "origin", "main"], { cwd: repoPath });
  return barePath;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("Workspace", () => {
  it("reports clean, dirty, and untracked workspace states", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    expect((await workspace.getStatus()).state).toBe("clean");

    await fs.writeFile(path.join(repoPath, "README.md"), "dirty\n", "utf8");
    expect((await workspace.getStatus()).state).toBe("dirty_uncommitted");

    await workspace.reset();
    await fs.writeFile(path.join(repoPath, "notes.txt"), "note\n", "utf8");
    const untrackedStatus = await workspace.getStatus();
    expect(untrackedStatus.state).toBe("untracked");
    expect(untrackedStatus.changedFiles).toBe(1);
  });

  it("returns combined and commit diff views against a merge-base branch", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature commit"], { cwd: repoPath });

    const workspace = new Workspace(repoPath);
    const combined = await workspace.getDiff({ mergeBaseBranch: "main" });
    expect(combined.mode).toBe("worktree_commits");
    expect(combined.commits[0]?.subject).toBe("Feature commit");
    expect(combined.diff).toContain("+feature");

    const commitOnly = await workspace.getDiff({
      mergeBaseBranch: "main",
      selection: { type: "commit", sha: combined.commits[0]!.sha },
    });
    expect(commitOnly.selection.type).toBe("commit");
    expect(commitOnly.diff).toContain("+feature");
  });

  it("commits staged work and resets dirty changes", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    await fs.writeFile(path.join(repoPath, "README.md"), "commit me\n", "utf8");
    const commit = await workspace.commit({
      message: "Commit from workspace",
      includeUnstaged: true,
    });
    const head = (
      await runGit(["rev-parse", "HEAD"], { cwd: repoPath })
    ).stdout.trim();
    expect(commit.commitSha).toBe(head);

    await fs.writeFile(path.join(repoPath, "README.md"), "modified again\n", "utf8");
    await fs.writeFile(path.join(repoPath, "temp.txt"), "temporary\n", "utf8");
    await workspace.reset();

    expect((await workspace.getStatus()).state).toBe("clean");
    await expect(fs.stat(path.join(repoPath, "temp.txt"))).rejects.toThrow();
  });

  it("supports checkout, detach, stash, and stashPop", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "stash me\n", "utf8");

    const workspace = new Workspace(repoPath);
    const stashRef = await workspace.stash("save changes");
    expect(stashRef).toMatch(/^stash@\{/u);
    expect((await workspace.getStatus()).state).toBe("clean");

    await workspace.detachHead();
    expect(await workspace.currentBranch).toBeUndefined();

    await workspace.checkoutBranch("feature");
    expect(await workspace.currentBranch).toBe("feature");

    await workspace.stashPop(stashRef ?? undefined);
    expect((await workspace.getStatus()).state).toBe("dirty_uncommitted");
  });

  it("creates checkpoints and pushes them to a local bare remote", async () => {
    const repoPath = await initRepo();
    const bareRemote = await initBareRemoteFrom(repoPath);
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "checkpoint\n", "utf8");

    const workspace = new Workspace(repoPath);
    const checkpoint = await workspace.checkpoint({
      commitMessage: "Checkpoint feature",
      remoteName: "origin",
    });

    const remoteHead = (
      await runGit(["--git-dir", bareRemote, "rev-parse", "refs/heads/feature"], {
        cwd: path.dirname(repoPath),
      })
    ).stdout.trim();
    expect(remoteHead).toBe(checkpoint.commitSha);
  });

  it("squash merges into the target branch using a temporary worktree", async () => {
    const repoPath = await initRepo();
    await initBareRemoteFrom(repoPath);
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "squash\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature work"], { cwd: repoPath });
    await runGit(["branch", "-D", "main"], { cwd: repoPath });

    const workspace = new Workspace(repoPath);
    const result = await workspace.squashMergeInto({
      targetBranch: "main",
      commitMessage: "Squash feature",
    });

    const subject = (
      await runGit(["log", "-1", "--pretty=%s", "main"], { cwd: repoPath })
    ).stdout.trim();
    expect(result.merged).toBe(true);
    expect(subject).toBe("Squash feature");
  });

  it("exports detached workspaces and imports branches while preserving dirty state", async () => {
    const sourceRepo = await initRepo();
    await initBareRemoteFrom(sourceRepo);
    await runGit(["checkout", "-b", "feature"], { cwd: sourceRepo });
    await fs.writeFile(path.join(sourceRepo, "README.md"), "feature branch\n", "utf8");
    await runGit(["add", "README.md"], { cwd: sourceRepo });
    await runGit(["commit", "-m", "Feature branch"], { cwd: sourceRepo });

    const sourceWorkspace = new Workspace(sourceRepo);
    const detachedExport = await exportWorkspace(sourceWorkspace);
    expect(detachedExport.branch).toBe("feature");
    expect(await sourceWorkspace.currentBranch).toBeUndefined();

    await sourceWorkspace.checkoutBranch("feature");
    const remoteExport = await exportWorkspace(sourceWorkspace, {
      pushToRemote: "origin",
    });

    const primaryParent = await makeTempDir("bb-workspace-clone-parent-");
    await runGit(["clone", sourceRepo, "primary"], { cwd: primaryParent });
    const primaryRepo = path.join(primaryParent, "primary");
    await runGit(["config", "user.name", "BB Tests"], { cwd: primaryRepo });
    await runGit(["config", "user.email", "bb@example.com"], { cwd: primaryRepo });
    await runGit(["checkout", "main"], { cwd: primaryRepo });
    await fs.writeFile(path.join(primaryRepo, "local.txt"), "dirty local\n", "utf8");

    const primary = new Workspace(primaryRepo);
    const imported = await importWorkspace(primary, remoteExport);
    expect(imported.previousBranch).toBe("main");
    expect(imported.stashRef).toMatch(/^stash@\{/u);
    expect(await primary.currentBranch).toBe("feature");

    await importWorkspace(primary, {
      type: "branch",
      branch: imported.previousBranch ?? "main",
    });
    if (imported.stashRef) {
      await primary.stashPop(imported.stashRef);
    }

    const restored = await fs.readFile(path.join(primaryRepo, "local.txt"), "utf8");
    expect(restored).toContain("dirty local");
    expect(await primary.currentBranch).toBe("main");
  });

  it("rejects git mutations for non-git directories", async () => {
    const folder = await makeTempDir("bb-workspace-nongit-");
    const workspace = new Workspace(folder);

    expect(await workspace.isGitRepo).toBe(false);
    expect(await workspace.currentBranch).toBeUndefined();
    await expect(
      workspace.commit({ message: "nope", includeUnstaged: true }),
    ).rejects.toThrow(/not a git repository/u);
    await expect(workspace.getStatus()).rejects.toThrow(WorkspaceError);
  });
});
