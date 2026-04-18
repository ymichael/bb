import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function createDeferred(): Deferred {
  let resolveDeferred = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return {
    promise,
    resolve: resolveDeferred,
  };
}

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
    expect(untrackedStatus.workingTree.files).toHaveLength(1);

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
      },
    ]);
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
      { path: "README.md", status: "M" },
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
      },
    ]);
    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: true,
      aheadCount: 1,
      behindCount: 0,
    });
    expect(status.mergeBase?.files).toEqual([
      { path: "README.md", status: "M" },
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
    const { worktreePath } = await createPrimaryAndFeatureWorktree();
    // Add a second branch commit so the squash collapses N > 1 commits.
    await fs.writeFile(
      path.join(worktreePath, "feature.txt"),
      "feature extra\n",
      "utf8",
    );
    await runGit(["add", "feature.txt"], { cwd: worktreePath });
    await runGit(["commit", "-m", "Feature extra"], { cwd: worktreePath });

    const workspace = new Workspace(worktreePath);
    await workspace.squashMergeInto({
      targetBranch: "main",
      commitMessage: "feat: squash merge multi-commit feature into main",
    });

    const status = await workspace.getStatus({ mergeBaseBranch: "main" });

    expect(status.mergeBase).toMatchObject({
      mergeBaseBranch: "main",
      hasCommittedUnmergedChanges: false,
      aheadCount: 0,
    });
    expect(status.mergeBase?.commits).toEqual([]);
    // Files and line counts must collapse along with commits — if they don't,
    // the UI would show "Committed · N files, +X -Y" for a squash-merged
    // branch that has nothing left to merge.
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
    await workspace.squashMergeInto({
      targetBranch: "main",
      commitMessage: "feat: squash merge feature into main",
    });

    // Main advances further after the squash commit lands.
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
    // Branch already has "Feature work" writing "squash\n" to README.md.
    // Revert it on the branch so the cumulative diff vs. the fork point is empty.
    await fs.writeFile(path.join(worktreePath, "README.md"), "hello\n", "utf8");
    await runGit(["add", "README.md"], { cwd: worktreePath });
    await runGit(["commit", "-m", "Revert feature"], { cwd: worktreePath });

    // Advance the base so the squash-detection path is reached
    // (we skip it when behindCount === 0).
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
    await workspace.squashMergeInto({
      targetBranch: "main",
      commitMessage: "feat: squash merge feature into main",
    });

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
      path.join(repoPath, "notes.txt"),
      "untracked pending\n",
      "utf8",
    );

    const workspace = new Workspace(repoPath);
    const status = await workspace.getStatus();

    expect(status.workingTree.state).toBe("untracked");
    expect(status.branch.currentBranch).toBe("main");
    expect(status.workingTree.files).toEqual([
      {
        path: "notes.txt",
        status: "??",
      },
    ]);
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

  it("serializes same-checkout mutations", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);
    await fs.writeFile(path.join(repoPath, "README.md"), "pending\n", "utf8");

    const lockEntered = createDeferred();
    const releaseLock = createDeferred();
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

  it("keeps real concurrent reset and checkout mutations coherent", async () => {
    const repoPath = await initRepo();
    const workspace = new Workspace(repoPath);
    const fileNames = Array.from(
      { length: 40 },
      (_, index) => `file-${index}.txt`,
    );

    await Promise.all(
      fileNames.map((fileName, index) =>
        fs.writeFile(path.join(repoPath, fileName), `main ${index}\n`, "utf8"),
      ),
    );
    await runGit(["add", "."], { cwd: repoPath });
    await runGit(["commit", "-m", "Add checkout stress files"], {
      cwd: repoPath,
    });

    await runGit(["checkout", "-b", "feature"], { cwd: repoPath });
    await Promise.all(
      fileNames.map((fileName, index) =>
        fs.writeFile(
          path.join(repoPath, fileName),
          `feature ${index}\n`,
          "utf8",
        ),
      ),
    );
    await runGit(["add", "."], { cwd: repoPath });
    await runGit(["commit", "-m", "Update feature files"], { cwd: repoPath });

    await runGit(["checkout", "main"], { cwd: repoPath });

    const mutations = Array.from({ length: 12 }, (_, index) =>
      index % 2 === 0 ? workspace.reset() : workspace.checkoutBranch("feature"),
    );
    await Promise.all(mutations);

    const firstFileName = fileNames[0];
    if (!firstFileName) {
      throw new Error("Expected checkout stress files");
    }

    expect(await workspace.currentBranch).toBe("feature");
    expect((await workspace.getStatus()).workingTree.state).toBe("clean");
    await expect(fs.readFile(path.join(repoPath, firstFileName), "utf8"))
      .resolves.toBe("feature 0\n");

    const fsck = await runGit(["fsck", "--no-progress"], {
      cwd: repoPath,
      allowFailure: true,
    });
    expect(fsck.exitCode).toBe(0);
  });

  it("does not serialize different linked worktree checkout mutations", async () => {
    const repoPath = await initRepo();
    const worktreeParent = await makeTempDir("bb-workspace-lock-worktrees-");
    const worktreePath = path.join(worktreeParent, "feature");
    await runGit(["worktree", "add", "-b", "feature", worktreePath, "main"], {
      cwd: repoPath,
    });

    const primaryLockEntered = createDeferred();
    const releasePrimaryLock = createDeferred();
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

    const firstLockEntered = createDeferred();
    const releaseFirstLock = createDeferred();
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
    const entered = createDeferred();
    const release = createDeferred();
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
    expect((await workspace.getStatus()).workingTree.state).toBe(
      "dirty_uncommitted",
    );
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

  it("squash merges when the target branch is checked out in another worktree", async () => {
    const { primaryRepo, worktreePath } =
      await createPrimaryAndFeatureWorktree();

    const workspace = new Workspace(worktreePath);
    const result = await workspace.squashMergeInto({
      targetBranch: "main",
      commitMessage: "feat: squash merge feature into main",
    });

    const targetBranchSubject = (
      await runGit(["log", "-1", "--pretty=%s", "main"], { cwd: primaryRepo })
    ).stdout.trim();
    const targetWorktreeContent = await fs.readFile(
      path.join(primaryRepo, "README.md"),
      "utf8",
    );

    expect(result.merged).toBe(true);
    expect(targetBranchSubject).toBe("feat: squash merge feature into main");
    expect(targetWorktreeContent).toBe("squash\n");
  });

  it("rejects squash merges when the checked-out target branch is dirty", async () => {
    const { primaryRepo, worktreePath } =
      await createPrimaryAndFeatureWorktree();
    await fs.writeFile(
      path.join(primaryRepo, "local.txt"),
      "local work\n",
      "utf8",
    );

    const workspace = new Workspace(worktreePath);

    await expect(
      workspace.squashMergeInto({
        targetBranch: "main",
        commitMessage: "feat: squash merge feature into main",
      }),
    ).rejects.toMatchObject({ code: "dirty_target_branch" });

    const targetBranchSubject = (
      await runGit(["log", "-1", "--pretty=%s", "main"], { cwd: primaryRepo })
    ).stdout.trim();
    expect(targetBranchSubject).toBe("Initial commit");
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

  it("returns null when HEAD is unavailable in an empty repository", async () => {
    const repoPath = await makeTempDir("bb-workspace-empty-repo-");
    await runGit(["init", "-b", "main"], { cwd: repoPath });
    await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
    await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });

    const workspace = new Workspace(repoPath);

    expect(await workspace.getHeadSha()).toBeNull();
  });
});
