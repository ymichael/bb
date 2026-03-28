import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace.js";
import { WorkspaceError } from "../src/git.js";
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
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });
    expect(status.mergeBaseBranch).toBe("main");
    expect(status.aheadCount).toBe(1);
    expect(status.behindCount).toBe(0);

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
    await fs.writeFile(path.join(repoPath, "README.md"), "squash plus local changes\n", "utf8");
    await runGit(["branch", "-D", "main"], { cwd: repoPath });

    const workspace = new Workspace(repoPath);
    const result = await workspace.squashMergeInto({
      targetBranch: "main",
    });

    const sourceBranchSubject = (
      await runGit(["log", "-1", "--pretty=%s", "feature"], { cwd: repoPath })
    ).stdout.trim();
    const targetBranchSubject = (
      await runGit(["log", "-1", "--pretty=%s", "main"], { cwd: repoPath })
    ).stdout.trim();
    const mergedReadme = await fs.readFile(path.join(repoPath, "README.md"), "utf8");
    expect(result.merged).toBe(true);
    expect(sourceBranchSubject).toBe("bb squash merge prep");
    expect(targetBranchSubject).toBe("bb squash merge");
    expect(mergedReadme).toBe("squash plus local changes\n");
  });

  it("rejects git mutations for non-git directories", async () => {
    const folder = await makeTempDir("bb-workspace-nongit-");
    const workspace = new Workspace(folder);

    expect(await workspace.isGitRepo).toBe(false);
    expect(await workspace.currentBranch).toBeUndefined();
    await expect(
      workspace.commit({ message: "nope" }),
    ).rejects.toThrow(/not a git repository/u);
    await expect(workspace.getStatus()).rejects.toThrow(WorkspaceError);
  });
});
