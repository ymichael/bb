import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceChangeStats } from "@bb/domain";
import { createDeferredPromise } from "@bb/test-helpers";
import { Workspace } from "../src/workspace.js";
import { WorkspaceError } from "../src/git.js";
import { runGit } from "../src/git.js";
import {
  withCheckoutMutationLock,
  withCheckoutMutationLocks,
} from "../src/checkout-mutation-lock.js";
import {
  ProcessLocalQueuedLockTimeoutError,
  withProcessLocalQueuedLocks,
} from "../src/process-local-queued-lock.js";

const tempDirs: string[] = [];

type DiffStats = {
  filesCount: number;
  insertions: number;
  deletions: number;
};

function waitForLockContention(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

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

function parseFirstIntegerMatch(text: string, pattern: RegExp): number {
  const value = Number.parseInt(text.match(pattern)?.[1] ?? "0", 10);
  return Number.isFinite(value) ? value : 0;
}

function parseShortstat(shortstat: string): DiffStats {
  return {
    filesCount: parseFirstIntegerMatch(shortstat, /(\d+)\s+files?\s+changed/u),
    insertions: parseFirstIntegerMatch(shortstat, /(\d+)\s+insertions?\(\+\)/u),
    deletions: parseFirstIntegerMatch(shortstat, /(\d+)\s+deletions?\(-\)/u),
  };
}

function tallyWorkspaceStats(stats: WorkspaceChangeStats): DiffStats {
  return {
    filesCount: stats.files.length,
    insertions: stats.insertions,
    deletions: stats.deletions,
  };
}

type PrimaryAndFeatureWorktree = {
  primaryRepo: string;
  worktreePath: string;
};

async function createPrimaryAndFeatureWorktree(): Promise<PrimaryAndFeatureWorktree> {
  const primaryRepo = await initRepo();
  const worktreeParent = await makeTempDir(
    "bb-workspace-squash-worktree-parent-",
  );
  const worktreePath = path.join(worktreeParent, "feature");
  await runGit(["worktree", "add", "-b", "feature", worktreePath, "main"], {
    cwd: primaryRepo,
  });
  await fs.writeFile(path.join(worktreePath, "README.md"), "squash\n", "utf8");
  await runGit(["add", "README.md"], { cwd: worktreePath });
  await runGit(["commit", "-m", "Feature work"], { cwd: worktreePath });
  return { primaryRepo, worktreePath };
}

async function mergeFeatureIntoMainWithSquash(
  primaryRepo: string,
  message: string,
): Promise<void> {
  await runGit(["merge", "--squash", "feature"], { cwd: primaryRepo });
  await runGit(["commit", "--no-verify", "-m", message], {
    cwd: primaryRepo,
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("Workspace", () => {
  it("reports clean, dirty, untracked-only, and mixed workspace states", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    expect((await workspace.getStatus()).workingTree.state).toBe("clean");

    await fs.writeFile(path.join(repoPath, "README.md"), "dirty\n", "utf8");
    expect((await workspace.getStatus()).workingTree.state).toBe(
      "dirty_uncommitted",
    );

    await workspace.reset();
    await fs.writeFile(path.join(repoPath, "notes.txt"), "note\n", "utf8");
    const untrackedStatus = await workspace.getStatus();
    expect(untrackedStatus.workingTree.state).toBe("untracked");
    expect(untrackedStatus.workingTree.files).toEqual([
      {
        path: "notes.txt",
        status: "??",
        insertions: null,
        deletions: null,
      },
    ]);
    expect(untrackedStatus.workingTree.insertions).toBe(0);
    expect(untrackedStatus.workingTree.deletions).toBe(0);
    expect(untrackedStatus.workingTree.lineStatsComplete).toBe(false);

    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "dirty with note\n",
      "utf8",
    );
    const mixedStatus = await workspace.getStatus();
    expect(mixedStatus.workingTree.state).toBe("dirty_uncommitted");
    expect(mixedStatus.workingTree.files).toHaveLength(2);
  });

  it("reports deleted tracked files as dirty file changes", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    await fs.rm(path.join(repoPath, "README.md"));

    const status = await workspace.getStatus();
    expect(status.workingTree.state).toBe("dirty_uncommitted");
    expect(status.workingTree.files).toEqual([
      {
        path: "README.md",
        status: "D",
        insertions: 0,
        deletions: 1,
      },
    ]);
  });

  it("joins per-file numstat to a rename+modify under the new path", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    await runGit(["mv", "README.md", "NOTES.md"], { cwd: repoPath });
    await fs.writeFile(
      path.join(repoPath, "NOTES.md"),
      "hello\nworld\n",
      "utf8",
    );

    const status = await workspace.getStatus();
    expect(status.workingTree.files).toEqual([
      {
        path: "NOTES.md",
        status: "R",
        insertions: 1,
        deletions: 0,
      },
    ]);
    expect(status.workingTree.insertions).toBe(1);
    expect(status.workingTree.deletions).toBe(0);
  });

  it("reports null per-file stats for binary changes and excludes them from totals", async () => {
    const repoPath = await initRepo();
    const binaryPath = path.join(repoPath, "data.bin");
    await fs.writeFile(binaryPath, Buffer.from([0, 1, 2, 3, 0xff, 0xfe]));
    await runGit(["add", "data.bin"], { cwd: repoPath });
    await runGit(["commit", "-m", "Add binary"], { cwd: repoPath });

    await fs.writeFile(binaryPath, Buffer.from([10, 20, 30, 40, 50, 60]));
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "hello\nworld\n",
      "utf8",
    );

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus();

    expect(status.workingTree.files).toEqual([
      {
        path: "README.md",
        status: "M",
        insertions: 1,
        deletions: 0,
      },
      {
        path: "data.bin",
        status: "M",
        insertions: null,
        deletions: null,
      },
    ]);
    expect(status.workingTree.insertions).toBe(1);
    expect(status.workingTree.deletions).toBe(0);
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

  it("fingerprints an untracked path without reading its contents", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);
    const initialFingerprint = await workspace.getLocalStateFingerprint();

    await fs.writeFile(path.join(repoPath, "notes.txt"), "one\n", "utf8");
    const untrackedFingerprint = await workspace.getLocalStateFingerprint();
    expect(untrackedFingerprint).not.toBe(initialFingerprint);

    await fs.writeFile(path.join(repoPath, "notes.txt"), "one\ntwo\n", "utf8");
    expect(await workspace.getLocalStateFingerprint()).toBe(
      untrackedFingerprint,
    );
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
    expect(status.workingTree.state).toBe("committed_unmerged");
    expect(status.branch.currentBranch).toBe("feature");
    expect(status.branch.defaultBranch).toBe("main");
    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      aheadCount: 1,
      behindCount: 0,
      hasCommittedUnmergedChanges: true,
    });
    expect(status.mergeBase?.commits[0]?.subject).toBe("Feature commit");
    expect(status.mergeBase?.files).toEqual([
      { path: "README.md", status: "M", insertions: 1, deletions: 1 },
    ]);
  });

  it("reports untracked files plus committed unmerged changes as dirty_and_committed_unmerged", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature commit"], { cwd: repoPath });
    await fs.writeFile(
      path.join(repoPath, "notes.txt"),
      "untracked pending\n",
      "utf8",
    );

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.workingTree.state).toBe("dirty_and_committed_unmerged");
    expect(status.workingTree.files).toEqual([
      {
        path: "notes.txt",
        status: "??",
        insertions: null,
        deletions: null,
      },
    ]);
    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: true,
      aheadCount: 1,
      behindCount: 0,
    });
    expect(status.mergeBase?.files).toEqual([
      { path: "README.md", status: "M", insertions: 1, deletions: 1 },
    ]);
  });

  it("reports branches that are only behind their merge base as clean", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await runGit(["checkout", "main"], { cwd: repoPath });
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "main update\n",
      "utf8",
    );
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Main update"], { cwd: repoPath });
    await runGit(["checkout", "feature"], { cwd: repoPath });

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.workingTree.state).toBe("clean");
    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: false,
      aheadCount: 0,
      behindCount: 1,
    });
  });

  it("does not report a multi-commit squash-merged branch as ahead of its merge base", async () => {
    const { primaryRepo, worktreePath } =
      await createPrimaryAndFeatureWorktree();
    await fs.writeFile(
      path.join(worktreePath, "feature.txt"),
      "feature extra\n",
      "utf8",
    );
    await runGit(["add", "feature.txt"], { cwd: worktreePath });
    await runGit(["commit", "-m", "Feature extra"], { cwd: worktreePath });

    const workspace = new Workspace(worktreePath);
    await mergeFeatureIntoMainWithSquash(
      primaryRepo,
      "feat: squash merge multi-commit feature into main",
    );

    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: false,
      aheadCount: 0,
    });
    expect(status.mergeBase?.commits).toEqual([]);
    expect(status.mergeBase?.files).toEqual([]);
    expect(status.mergeBase?.insertions).toBe(0);
    expect(status.mergeBase?.deletions).toBe(0);
  });

  it("recognizes squash-merged branch after main advances past the squash commit", async () => {
    const { primaryRepo, worktreePath } =
      await createPrimaryAndFeatureWorktree();
    await fs.writeFile(
      path.join(worktreePath, "feature.txt"),
      "feature extra\n",
      "utf8",
    );
    await runGit(["add", "feature.txt"], { cwd: worktreePath });
    await runGit(["commit", "-m", "Feature extra"], { cwd: worktreePath });

    const workspace = new Workspace(worktreePath);
    await mergeFeatureIntoMainWithSquash(
      primaryRepo,
      "feat: squash merge feature into main",
    );

    await fs.writeFile(
      path.join(primaryRepo, "after-squash.txt"),
      "later\n",
      "utf8",
    );
    await runGit(["add", "after-squash.txt"], { cwd: primaryRepo });
    await runGit(["commit", "-m", "Main work after squash"], {
      cwd: primaryRepo,
    });

    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: false,
      aheadCount: 0,
    });
    expect(status.mergeBase?.behindCount).toBeGreaterThan(0);
  });

  it("treats a branch whose commits cancel out as merged", async () => {
    const { primaryRepo, worktreePath } =
      await createPrimaryAndFeatureWorktree();
    await fs.writeFile(path.join(worktreePath, "README.md"), "hello\n", "utf8");
    await runGit(["add", "README.md"], { cwd: worktreePath });
    await runGit(["commit", "-m", "Revert feature"], { cwd: worktreePath });

    await fs.writeFile(
      path.join(primaryRepo, "main-work.txt"),
      "main\n",
      "utf8",
    );
    await runGit(["add", "main-work.txt"], { cwd: primaryRepo });
    await runGit(["commit", "-m", "Main advance"], { cwd: primaryRepo });

    const workspace = new Workspace(worktreePath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: false,
      aheadCount: 0,
    });
  });

  it("still reports genuine unmerged branch commits as ahead", async () => {
    const { worktreePath } = await createPrimaryAndFeatureWorktree();
    await fs.writeFile(path.join(worktreePath, "extra.txt"), "extra\n", "utf8");
    await runGit(["add", "extra.txt"], { cwd: worktreePath });
    await runGit(["commit", "-m", "Feature extra"], { cwd: worktreePath });

    const workspace = new Workspace(worktreePath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: true,
      aheadCount: 2,
    });
  });

  it("does not report squash-merged branch commits as ahead of their merge base", async () => {
    const { primaryRepo, worktreePath } =
      await createPrimaryAndFeatureWorktree();
    await fs.writeFile(
      path.join(primaryRepo, "notes.txt"),
      "main work\n",
      "utf8",
    );
    await runGit(["add", "notes.txt"], { cwd: primaryRepo });
    await runGit(["commit", "-m", "Main work"], { cwd: primaryRepo });

    const workspace = new Workspace(worktreePath);
    await mergeFeatureIntoMainWithSquash(
      primaryRepo,
      "feat: squash merge feature into main",
    );

    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.workingTree.state).toBe("clean");
    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: false,
      aheadCount: 0,
      behindCount: 1,
    });
    expect(status.mergeBase?.commits).toEqual([]);
  });

  it("reports status for git repositories with no commits yet", async () => {
    const repoPath = await makeTempDir("bb-workspace-unborn-repo-");
    await runGit(["init", "-b", "main"], { cwd: repoPath });
    await fs.writeFile(
      path.join(repoPath, "staged.txt"),
      "staged pending\n",
      "utf8",
    );
    await runGit(["add", "staged.txt"], { cwd: repoPath });
    await fs.writeFile(
      path.join(repoPath, "notes.txt"),
      "untracked pending\n",
      "utf8",
    );

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.workingTree.state).toBe("dirty_uncommitted");
    expect(status.branch.currentBranch).toBe("main");
    expect(status.checkout).toEqual({ kind: "unborn", branchName: "main" });
    expect(status.workingTree.files).toEqual([
      {
        path: "staged.txt",
        status: "A",
        insertions: 1,
        deletions: 0,
      },
      {
        path: "notes.txt",
        status: "??",
        insertions: null,
        deletions: null,
      },
    ]);
    expect(status.workingTree.insertions).toBe(1);
    expect(status.workingTree.deletions).toBe(0);
    expect(status.workingTree.lineStatsComplete).toBe(false);
    expect(status.mergeBase).toEqual({
      mergeBaseBranch: "main",
      baseRef: null,
      aheadCount: 0,
      behindCount: 0,
      hasCommittedUnmergedChanges: false,
      commits: [],
      files: [],
      insertions: 0,
      deletions: 0,
      lineStatsComplete: true,
    });
  });

  it("returns diff content for each supported target", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature commit"], { cwd: repoPath });
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "feature plus pending\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoPath, "notes.txt"),
      "untracked pending\n",
      "utf8",
    );

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

  it("aligns committed-only status stats with all and committed diffs", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature commit"], { cwd: repoPath });

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });
    expect(status.workingTree.files).toEqual([]);
    const mergeBase = status.mergeBase;
    expect(mergeBase).not.toBeNull();
    if (!mergeBase) {
      throw new Error("Expected merge-base status");
    }

    const allChanges = await workspace.getDiff({
      target: { type: "all", mergeBaseBranch: "main" },
    });
    const committedChanges = await workspace.getDiff({
      target: { type: "branch_committed", mergeBaseBranch: "main" },
    });
    const bannerStats = tallyWorkspaceStats(mergeBase);

    expect(bannerStats).toEqual(parseShortstat(allChanges.shortstat));
    expect(bannerStats).toEqual(parseShortstat(committedChanges.shortstat));
  });

  it("marks status line stats incomplete when untracked content is omitted", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "hello\npending\n",
      "utf8",
    );
    await fs.writeFile(path.join(repoPath, "notes.txt"), "note\n", "utf8");

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });
    expect(status.mergeBase?.files ?? []).toEqual([]);

    const allChanges = await workspace.getDiff({
      target: { type: "all", mergeBaseBranch: "main" },
    });
    const uncommittedChanges = await workspace.getDiff({
      target: { type: "uncommitted" },
    });
    const bannerStats = tallyWorkspaceStats(status.workingTree);

    expect(status.workingTree.lineStatsComplete).toBe(false);
    expect(bannerStats).toEqual({
      filesCount: 2,
      insertions: 1,
      deletions: 0,
    });
    expect(parseShortstat(allChanges.shortstat)).toEqual({
      filesCount: 2,
      insertions: 2,
      deletions: 0,
    });
    expect(parseShortstat(uncommittedChanges.shortstat)).toEqual(
      parseShortstat(allChanges.shortstat),
    );
  });

  it("enriches small untracked status snapshots within file and byte budgets", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "hello\npending\n",
      "utf8",
    );
    await fs.writeFile(path.join(repoPath, "notes.txt"), "one\ntwo\n", "utf8");
    const statusBefore = await runGit(["status", "--porcelain=v1"], {
      cwd: repoPath,
    });

    const status = await new Workspace(repoPath).getStatus({
      maxUntrackedLineStatFiles: 10,
      maxUntrackedLineStatBytes: 1024,
    });

    expect(status.workingTree.files).toEqual([
      {
        path: "README.md",
        status: "M",
        insertions: 1,
        deletions: 0,
      },
      {
        path: "notes.txt",
        status: "??",
        insertions: 2,
        deletions: 0,
      },
    ]);
    expect(status.workingTree).toMatchObject({
      insertions: 3,
      deletions: 0,
      lineStatsComplete: true,
    });
    const statusAfter = await runGit(["status", "--porcelain=v1"], {
      cwd: repoPath,
    });
    expect(statusAfter.stdout).toBe(statusBefore.stdout);
  });

  it("keeps tracked deletion stats separate from an untracked replacement at the same path", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(
      path.join(repoPath, "replacement.txt"),
      "one\ntwo\nthree\n",
      "utf8",
    );
    await runGit(["add", "replacement.txt"], { cwd: repoPath });
    await runGit(["commit", "-m", "Add replacement target"], {
      cwd: repoPath,
    });
    await runGit(["rm", "--cached", "replacement.txt"], { cwd: repoPath });

    const status = await new Workspace(repoPath).getStatus({
      maxUntrackedLineStatFiles: 10,
      maxUntrackedLineStatBytes: 1024,
    });

    expect(status.workingTree.files).toEqual([
      {
        path: "replacement.txt",
        status: "D",
        insertions: 0,
        deletions: 3,
      },
      {
        path: "replacement.txt",
        status: "??",
        insertions: 3,
        deletions: 0,
      },
    ]);
    expect(status.workingTree).toMatchObject({
      insertions: 3,
      deletions: 3,
      lineStatsComplete: true,
    });
  });

  it("enriches eligible untracked files when another entry is a nested repository", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, "notes.txt"), "one\ntwo\n", "utf8");
    const nestedRepoPath = path.join(repoPath, "vendor");
    await fs.mkdir(nestedRepoPath);
    await runGit(["init", "-b", "main"], { cwd: nestedRepoPath });
    await fs.writeFile(path.join(nestedRepoPath, "inside.txt"), "inside\n");

    const status = await new Workspace(repoPath).getStatus({
      maxUntrackedLineStatFiles: 10,
      maxUntrackedLineStatBytes: 1024,
    });

    expect(status.workingTree.files).toEqual([
      {
        path: "notes.txt",
        status: "??",
        insertions: 2,
        deletions: 0,
      },
      {
        path: "vendor/",
        status: "??",
        insertions: null,
        deletions: null,
      },
    ]);
    expect(status.workingTree).toMatchObject({
      insertions: 2,
      deletions: 0,
      lineStatsComplete: false,
    });
  });

  it("leaves untracked status stats unknown when either enrichment budget is exceeded", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, "one.txt"), "one\n", "utf8");
    await fs.writeFile(path.join(repoPath, "two.txt"), "two\n", "utf8");
    const workspace = new Workspace(repoPath);

    const overFileBudget = await workspace.getStatus({
      maxUntrackedLineStatFiles: 1,
      maxUntrackedLineStatBytes: 1024,
    });
    const overByteBudget = await workspace.getStatus({
      maxUntrackedLineStatFiles: 10,
      maxUntrackedLineStatBytes: 1,
    });

    for (const status of [overFileBudget, overByteBudget]) {
      expect(status.workingTree.lineStatsComplete).toBe(false);
      expect(
        status.workingTree.files
          .filter((file) => file.status === "??")
          .every((file) => file.insertions === null && file.deletions === null),
      ).toBe(true);
    }
  });

  it("keeps tracked status totals explicitly incomplete in a mixed workspace", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "feature\n", "utf8");
    await runGit(["add", "README.md"], { cwd: repoPath });
    await runGit(["commit", "-m", "Feature commit"], { cwd: repoPath });
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "feature\npending\n",
      "utf8",
    );
    await fs.writeFile(path.join(repoPath, "notes.txt"), "note\n", "utf8");

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus({ mergeBaseBranch: "main" });
    expect(status.workingTree.state).toBe("dirty_and_committed_unmerged");

    const allChanges = await workspace.getDiff({
      target: { type: "all", mergeBaseBranch: "main" },
    });
    const uncommittedChanges = await workspace.getDiff({
      target: { type: "uncommitted" },
    });
    const bannerStats = tallyWorkspaceStats(status.workingTree);

    expect(status.workingTree.lineStatsComplete).toBe(false);
    expect(bannerStats).not.toEqual(
      parseShortstat(uncommittedChanges.shortstat),
    );
    expect(bannerStats).not.toEqual(parseShortstat(allChanges.shortstat));
  });

  it("truncates large git diff output before the process buffer fails", async () => {
    const repoPath = await initRepo();
    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await fs.writeFile(
      path.join(repoPath, "README.md"),
      Array.from({ length: 200 }, (_, index) => `large diff line ${index}`)
        .join("\n")
        .concat("\n"),
      "utf8",
    );

    const workspace = new Workspace(repoPath);
    const diff = await workspace.getDiff({
      target: { type: "all", mergeBaseBranch: "main" },
      maxDiffBytes: 128,
    });

    expect(diff.truncated).toBe(true);
    expect(Buffer.byteLength(diff.diff, "utf8")).toBeLessThanOrEqual(128);
    expect(diff.diff).toContain("diff --git");
    expect(diff.files).toContain("README.md");
    expect(diff.shortstat).toContain("1 file changed");
  });

  it("includes untracked files in one combined diff", async () => {
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

  it("bounds full-diff untracked content and reports truncation", async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, "a.txt"), "first\n", "utf8");
    await fs.writeFile(path.join(repoPath, "b.txt"), "second\n", "utf8");

    const diff = await new Workspace(repoPath).getDiff({
      target: { type: "uncommitted" },
      maxUntrackedFiles: 1,
    });

    expect(diff.truncated).toBe(true);
    expect(diff.files).toContain("a.txt");
    expect(diff.files).not.toContain("b.txt");
    expect(diff.diff).toContain("first");
    expect(diff.diff).not.toContain("second");
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

    await fs.writeFile(
      path.join(repoPath, "README.md"),
      "modified again\n",
      "utf8",
    );
    await fs.writeFile(path.join(repoPath, "temp.txt"), "temporary\n", "utf8");
    await workspace.reset();

    expect((await workspace.getStatus()).workingTree.state).toBe("clean");
    await expect(fs.stat(path.join(repoPath, "temp.txt"))).rejects.toThrow();
  });

  it("throws a typed no_changes error when there is nothing to commit", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);

    await expect(
      workspace.commit({ message: "nothing to commit", noVerify: false }),
    ).rejects.toMatchObject({
      name: "WorkspaceError",
      code: "no_changes",
    });

    await fs.writeFile(path.join(repoPath, "new.txt"), "real work\n", "utf8");
    const commit = await workspace.commit({
      message: "real commit",
      noVerify: false,
    });
    expect(typeof commit.commitSha).toBe("string");
  });

  it("serializes same-checkout mutations", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);
    await fs.writeFile(path.join(repoPath, "README.md"), "pending\n", "utf8");

    const lockEntered = createDeferredPromise<void>();
    const releaseLock = createDeferredPromise<void>();
    const heldLock = withCheckoutMutationLock(repoPath, async () => {
      lockEntered.resolve();
      await releaseLock.promise;
    });
    await lockEntered.promise;

    let resetCompleted = false;
    const reset = workspace.reset().then(() => {
      resetCompleted = true;
    });
    await waitForLockContention();

    expect(resetCompleted).toBe(false);

    releaseLock.resolve();
    await Promise.all([heldLock, reset]);

    expect(resetCompleted).toBe(true);
    expect((await workspace.getStatus()).workingTree.state).toBe("clean");
  });

  it("does not serialize different linked worktree checkout mutations", async () => {
    const repoPath = await initRepo();
    const worktreeParent = await makeTempDir("bb-workspace-lock-worktrees-");
    const worktreePath = path.join(worktreeParent, "feature");
    await runGit(["worktree", "add", "-b", "feature", worktreePath, "main"], {
      cwd: repoPath,
    });

    const primaryLockEntered = createDeferredPromise<void>();
    const releasePrimaryLock = createDeferredPromise<void>();
    const primaryLock = withCheckoutMutationLock(repoPath, async () => {
      primaryLockEntered.resolve();
      await releasePrimaryLock.promise;
    });
    await primaryLockEntered.promise;

    let worktreeLockEntered = false;
    await withCheckoutMutationLock(worktreePath, async () => {
      worktreeLockEntered = true;
    });

    releasePrimaryLock.resolve();
    await primaryLock;

    expect(worktreeLockEntered).toBe(true);
  });

  it("acquires multi-checkout mutation locks in stable order", async () => {
    const repoPath = await initRepo();
    const worktreeParent = await makeTempDir("bb-workspace-multi-lock-");
    const worktreePath = path.join(worktreeParent, "feature");
    await runGit(["worktree", "add", "-b", "feature", worktreePath, "main"], {
      cwd: repoPath,
    });

    const firstLockEntered = createDeferredPromise<void>();
    const releaseFirstLock = createDeferredPromise<void>();
    const firstLock = withCheckoutMutationLocks(
      [repoPath, worktreePath],
      async () => {
        firstLockEntered.resolve();
        await releaseFirstLock.promise;
      },
    );
    await firstLockEntered.promise;

    let secondLockEntered = false;
    const secondLock = withCheckoutMutationLocks(
      [worktreePath, repoPath],
      async () => {
        secondLockEntered = true;
      },
    );
    await waitForLockContention();

    expect(secondLockEntered).toBe(false);

    releaseFirstLock.resolve();
    await Promise.all([firstLock, secondLock]);

    expect(secondLockEntered).toBe(true);
  });

  it("times out waiters behind a stuck process-local lock", async () => {
    const stuck = withProcessLocalQueuedLocks({
      locks: [{ key: "stuck-lock", timeoutMs: 0 }],
      work: () => new Promise(() => undefined),
    });
    void stuck.catch(() => undefined);

    await expect(
      withProcessLocalQueuedLocks({
        locks: [{ key: "stuck-lock", timeoutMs: 10 }],
        work: async () => "unreachable",
      }),
    ).rejects.toBeInstanceOf(ProcessLocalQueuedLockTimeoutError);
  });

  it("skips process-local lock waiters that time out before entry", async () => {
    const entered = createDeferredPromise<void>();
    const release = createDeferredPromise<void>();
    let timedOutWorkRan = false;
    const first = withProcessLocalQueuedLocks({
      locks: [{ key: "timed-out-skip-lock", timeoutMs: 0 }],
      work: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;

    await expect(
      withProcessLocalQueuedLocks({
        locks: [{ key: "timed-out-skip-lock", timeoutMs: 10 }],
        work: async () => {
          timedOutWorkRan = true;
        },
      }),
    ).rejects.toBeInstanceOf(ProcessLocalQueuedLockTimeoutError);

    release.resolve();
    await first;
    await expect(
      withProcessLocalQueuedLocks({
        locks: [{ key: "timed-out-skip-lock", timeoutMs: 1000 }],
        work: async () => "after-timeout",
      }),
    ).resolves.toBe("after-timeout");
    expect(timedOutWorkRan).toBe(false);
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
    await fs.writeFile(
      path.join(folder, "nested", "notes.txt"),
      "hello\n",
      "utf8",
    );
    await fs.writeFile(path.join(folder, ".hidden.txt"), "skip\n", "utf8");
    await fs.mkdir(path.join(folder, "node_modules"), { recursive: true });
    await fs.writeFile(
      path.join(folder, "node_modules", "pkg.txt"),
      "skip\n",
      "utf8",
    );

    const workspace = new Workspace(folder);
    const files = await workspace.listFiles();

    expect(files).toEqual(["nested/notes.txt"]);
  });

  it("does not overflow the call stack merging a large subdirectory", async () => {
    const folder = await makeTempDir("bb-workspace-large-files-");
    const nested = path.join(folder, "many");
    await fs.mkdir(nested);
    const fileCount = 150_000;
    const batchSize = 500;
    for (let start = 0; start < fileCount; start += batchSize) {
      const end = Math.min(start + batchSize, fileCount);
      await Promise.all(
        Array.from({ length: end - start }, (_, offset) =>
          fs.writeFile(path.join(nested, `f${start + offset}.txt`), ""),
        ),
      );
    }

    const files = await new Workspace(folder).listFiles();

    expect(files).toHaveLength(fileCount);
  }, 60_000);

  it("returns null when HEAD is unavailable in an empty repository", async () => {
    const repoPath = await makeTempDir("bb-workspace-empty-repo-");
    await runGit(["init", "-b", "main"], { cwd: repoPath });
    await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
    await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });

    const workspace = new Workspace(repoPath);

    expect(await workspace.getHeadSha()).toBeNull();
  });
});

describe("getPullRequest", () => {
  it("reports a vanished workspace path as unavailable, not absent", async () => {
    const missingPath = path.join(
      os.tmpdir(),
      `bb-missing-workspace-${process.pid}-${Date.now()}`,
    );
    const workspace = new Workspace(missingPath);
    await expect(workspace.getPullRequest()).resolves.toEqual({
      outcome: "unavailable",
      message: `Workspace path no longer exists: ${missingPath}`,
    });
  });
});
