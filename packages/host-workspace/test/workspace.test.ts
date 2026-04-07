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
  it("reports clean, dirty, untracked-only, and mixed workspace states", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    expect((await workspace.getStatus()).workingTree.state).toBe("clean");

    await fs.writeFile(path.join(repoPath, "README.md"), "dirty\n", "utf8");
    expect((await workspace.getStatus()).workingTree.state).toBe("dirty_uncommitted");

    await workspace.reset();
    await fs.writeFile(path.join(repoPath, "notes.txt"), "note\n", "utf8");
    const untrackedStatus = await workspace.getStatus();
    expect(untrackedStatus.workingTree.state).toBe("untracked");
    expect(untrackedStatus.workingTree.changedFiles).toBe(1);

    await fs.writeFile(path.join(repoPath, "README.md"), "dirty with note\n", "utf8");
    const mixedStatus = await workspace.getStatus();
    expect(mixedStatus.workingTree.state).toBe("dirty_uncommitted");
    expect(mixedStatus.workingTree.changedFiles).toBe(2);
  });

  it("changes the local state fingerprint when local checkout state changes", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    const initialFingerprint = await workspace.getLocalStateFingerprint();

    await fs.writeFile(path.join(repoPath, "README.md"), "dirty\n", "utf8");
    const dirtyFingerprint = await workspace.getLocalStateFingerprint();
    expect(dirtyFingerprint).not.toBe(initialFingerprint);

    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    const branchFingerprint = await workspace.getLocalStateFingerprint();
    expect(branchFingerprint).not.toBe(dirtyFingerprint);
  });

  it("changes the shared git refs fingerprint only when refs change", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    const initialFingerprint = await workspace.getSharedGitRefsFingerprint();

    await fs.writeFile(path.join(repoPath, "README.md"), "dirty\n", "utf8");
    const dirtyFingerprint = await workspace.getSharedGitRefsFingerprint();
    expect(dirtyFingerprint).toBe(initialFingerprint);

    await runGit(["branch", "feature"], { cwd: repoPath });
    const branchFingerprint = await workspace.getSharedGitRefsFingerprint();
    expect(branchFingerprint).not.toBe(initialFingerprint);
  });

  it("returns grouped status details only when merge-base data is requested", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature commit"], { cwd: repoPath });

    const workspace = new Workspace(repoPath);
    const localOnlyStatus = await workspace.getStatus();
    expect(localOnlyStatus.mergeBase).toBeNull();
    expect(localOnlyStatus.workingTree.state).toBe("clean");

    const status = await workspace.getStatus({ mergeBaseBranch: "main" });
    expect(status.branch.currentBranch).toBe("feature");
    expect(status.branch.defaultBranch).toBe("main");
    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      aheadCount: 1,
      behindCount: 0,
      hasCommittedUnmergedChanges: true,
    });
    expect(status.mergeBase?.commits[0]?.subject).toBe("Feature commit");
  });

  it("reports untracked files plus committed unmerged changes as dirty_and_committed_unmerged", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature commit"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "notes.txt"), "untracked pending\n", "utf8");

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.workingTree.state).toBe("dirty_and_committed_unmerged");
    expect(status.workingTree.changedFiles).toBe(1);
    expect(status.workingTree.files).toEqual([
      {
        path: "notes.txt",
        status: "??",
      },
    ]);
    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: true,
      aheadCount: 1,
      behindCount: 0,
    });
  });

  it("returns diff content for each supported target", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature commit"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature plus pending\n", "utf8");
    await fs.writeFile(path.join(repoPath, "notes.txt"), "untracked pending\n", "utf8");

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });
    const commitSha = status.mergeBase?.commits[0]?.sha;
    expect(commitSha).toBeDefined();

    const uncommitted = await workspace.getDiff({
      target: { type: "uncommitted" },
    });
    expect(uncommitted.diff).toContain("feature plus pending");
    expect(uncommitted.diff).toContain("untracked pending");
    expect(uncommitted.files).toContain("README.md");
    expect(uncommitted.files).toContain("notes.txt");
    expect(uncommitted.shortstat).toContain("2 files changed");

    const branchCommitted = await workspace.getDiff({
      target: { type: "branch_committed", mergeBaseBranch: "main" },
    });
    expect(branchCommitted.diff).toContain("+feature");

    const all = await workspace.getDiff({
      target: { type: "all", mergeBaseBranch: "main" },
    });
    expect(all.diff).toContain("feature plus pending");
    expect(all.diff).toContain("untracked pending");
    expect(all.files).toContain("README.md");
    expect(all.files).toContain("notes.txt");
    expect(all.shortstat).toContain("2 files changed");

    const commitOnly = await workspace.getDiff({
      target: { type: "commit", sha: commitSha! },
    });
    expect(commitOnly.diff).toContain("+feature");
  });

  it("includes untracked files across multiple diff batches", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        await fs.writeFile(
          path.join(repoPath, `note-${index}.txt`),
          `untracked ${index}\n`,
          "utf8",
        );
      }),
    );

    const diff = await workspace.getDiff({
      target: { type: "uncommitted" },
    });

    expect(diff.diff).toContain("untracked 11");
    expect(diff.files).toContain("note-11.txt");
    expect(diff.shortstat).toContain("12 files changed");
  });

  it("commits staged work and resets dirty changes", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    await fs.writeFile(path.join(repoPath, "README.md"), "commit me\n", "utf8");
    const commit = await workspace.commit({
      message: "Commit from workspace",
      noVerify: false,
    });
    const head = (
      await runGit(["rev-parse", "HEAD"], { cwd: repoPath })
    ).stdout.trim();
    expect(commit.commitSha).toBe(head);

    await fs.writeFile(path.join(repoPath, "README.md"), "modified again\n", "utf8");
    await fs.writeFile(path.join(repoPath, "temp.txt"), "temporary\n", "utf8");
    await workspace.reset();

    expect((await workspace.getStatus()).workingTree.state).toBe("clean");
    await expect(fs.stat(path.join(repoPath, "temp.txt"))).rejects.toThrow();
  });

  it("supports checkout, detach, stash, and stashPop", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "stash me\n", "utf8");

    const workspace = new Workspace(repoPath);
    const stashRef = await workspace.stash("save changes");
    expect(stashRef).toMatch(/^stash@\{/u);
    expect((await workspace.getStatus()).workingTree.state).toBe("clean");

    await workspace.detachHead();
    expect(await workspace.currentBranch).toBeUndefined();

    await workspace.checkoutBranch("feature");
    expect(await workspace.currentBranch).toBe("feature");

    await workspace.stashPop(stashRef ?? undefined);
    expect((await workspace.getStatus()).workingTree.state).toBe("dirty_uncommitted");
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
      commitMessage: "feat: squash merge feature into main",
    });

    const targetBranchSubject = (
      await runGit(["log", "-1", "--pretty=%s", "main"], { cwd: repoPath })
    ).stdout.trim();
    expect(result.merged).toBe(true);
    expect(targetBranchSubject).toBe("feat: squash merge feature into main");
  });

  it("rejects git mutations for non-git directories", async () => {
    const folder = await makeTempDir("bb-workspace-nongit-");
    const workspace = new Workspace(folder);

    expect(await workspace.isGitRepo).toBe(false);
    expect(await workspace.currentBranch).toBeUndefined();
    await expect(
      workspace.commit({ message: "nope", noVerify: false }),
    ).rejects.toThrow(/not a git repository/u);
    await expect(workspace.getStatus()).rejects.toThrow(WorkspaceError);
  });

  it("lists tracked and untracked files in git repositories", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, "notes.txt"), "pending\n", "utf8");

    const workspace = new Workspace(repoPath);
    const files = await workspace.listFiles();

    expect(files).toEqual(["README.md", "notes.txt"]);
  });

  it("lists files recursively for non-git directories", async () => {
    const folder = await makeTempDir("bb-workspace-files-");
    await fs.mkdir(path.join(folder, "nested"), { recursive: true });
    await fs.writeFile(path.join(folder, "nested", "notes.txt"), "hello\n", "utf8");
    await fs.writeFile(path.join(folder, ".hidden.txt"), "skip\n", "utf8");
    await fs.mkdir(path.join(folder, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(folder, "node_modules", "pkg.txt"), "skip\n", "utf8");

    const workspace = new Workspace(folder);
    const files = await workspace.listFiles();

    expect(files).toEqual(["nested/notes.txt"]);
  });

  it("returns null when HEAD is unavailable in an empty repository", async () => {
    const repoPath = await makeTempDir("bb-workspace-empty-repo-");
    await runGit(["init", "-b", "main"], { cwd: repoPath });
    await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
    await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });

    const workspace = new Workspace(repoPath);

    expect(await workspace.getHeadSha()).toBeNull();
  });
});
