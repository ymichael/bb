import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadGitStatusService } from "../thread-git-status.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "bb-thread-git-status-"));
  tempDirs.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepoWithThreadAheadOfMain(): string {
  const repoRoot = makeTempDir();
  git(repoRoot, "init");
  git(repoRoot, "config", "user.name", "Beanbag Test");
  git(repoRoot, "config", "user.email", "beanbag-test@example.com");
  git(repoRoot, "checkout", "-b", "main");

  writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf8");
  git(repoRoot, "add", "README.md");
  git(repoRoot, "commit", "-m", "initial");

  git(repoRoot, "checkout", "-b", "thread");
  writeFileSync(join(repoRoot, "README.md"), "initial\nthread change\n", "utf8");
  git(repoRoot, "add", "README.md");
  git(repoRoot, "commit", "-m", "thread change");

  return repoRoot;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ThreadGitStatusService", () => {
  it("returns deleted state when workspace root does not exist", () => {
    const service = new ThreadGitStatusService();
    const tempRoot = makeTempDir();
    const missingWorkspace = join(tempRoot, "missing-worktree");
    const status = service.getStatus({
      workspaceRoot: missingWorkspace,
      projectRoot: tempRoot,
    });

    expect(status.state).toBe("deleted");
    expect(status.workspaceRoot).toBe(missingWorkspace);
    expect(status.workspaceChangedFiles).toBe(0);
  });

  it("returns untracked state when workspace is not a git repository", () => {
    const service = new ThreadGitStatusService();
    const workspaceRoot = makeTempDir();
    const status = service.getStatus({
      workspaceRoot,
      projectRoot: workspaceRoot,
    });

    expect(status.state).toBe("untracked");
    expect(status.workspaceRoot).toBe(workspaceRoot);
    expect(status.workspaceChangedFiles).toBe(0);
  });

  it("does not report ahead commits that are already cherry-picked onto main", () => {
    const repoRoot = makeTempDir();
    git(repoRoot, "init");
    git(repoRoot, "config", "user.name", "Beanbag Test");
    git(repoRoot, "config", "user.email", "beanbag-test@example.com");
    git(repoRoot, "checkout", "-b", "main");

    writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "initial");
    git(repoRoot, "checkout", "-b", "thread");
    writeFileSync(join(repoRoot, "README.md"), "initial\nthread change\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "thread change");
    const threadCommit = git(repoRoot, "rev-parse", "HEAD");

    git(repoRoot, "checkout", "main");
    git(repoRoot, "cherry-pick", threadCommit);
    git(repoRoot, "checkout", "--detach", threadCommit);

    const service = new ThreadGitStatusService();
    const status = service.getStatus({
      workspaceRoot: repoRoot,
      projectRoot: repoRoot,
      defaultBranch: "main",
    });

    expect(status.aheadCount).toBe(0);
    expect(status.hasCommittedUnmergedChanges).toBe(false);
    expect(status.state).toBe("clean");
  });

  it("treats squash-merged branch content as merged even when history is still ahead", () => {
    const repoRoot = makeTempDir();
    git(repoRoot, "init");
    git(repoRoot, "config", "user.name", "Beanbag Test");
    git(repoRoot, "config", "user.email", "beanbag-test@example.com");
    git(repoRoot, "checkout", "-b", "main");

    writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "initial");

    git(repoRoot, "checkout", "-b", "thread");
    writeFileSync(join(repoRoot, "README.md"), "initial\nthread line 1\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "thread change 1");
    writeFileSync(join(repoRoot, "README.md"), "initial\nthread line 1\nthread line 2\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "thread change 2");

    git(repoRoot, "checkout", "main");
    git(repoRoot, "merge", "--squash", "thread");
    git(repoRoot, "commit", "-m", "squash thread");
    git(repoRoot, "checkout", "thread");

    const service = new ThreadGitStatusService();
    const status = service.getStatus({
      workspaceRoot: repoRoot,
      projectRoot: repoRoot,
      defaultBranch: "main",
    });

    expect(status.aheadCount).toBeGreaterThan(0);
    expect(status.hasCommittedUnmergedChanges).toBe(false);
    expect(status.state).toBe("clean");
  });

  it("computes ahead/behind against a selected merge base branch", () => {
    const repoRoot = makeTempDir();
    git(repoRoot, "init");
    git(repoRoot, "config", "user.name", "Beanbag Test");
    git(repoRoot, "config", "user.email", "beanbag-test@example.com");
    git(repoRoot, "checkout", "-b", "main");

    writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "initial");

    git(repoRoot, "checkout", "-b", "release");
    git(repoRoot, "checkout", "main");
    writeFileSync(join(repoRoot, "README.md"), "initial\nmain change\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "main change");

    git(repoRoot, "checkout", "-b", "thread");
    writeFileSync(join(repoRoot, "README.md"), "initial\nmain change\nthread change\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "thread change");

    const service = new ThreadGitStatusService();
    const statusAgainstMain = service.getStatus({
      workspaceRoot: repoRoot,
      projectRoot: repoRoot,
      defaultBranch: "main",
    });
    const statusAgainstRelease = service.getStatus({
      workspaceRoot: repoRoot,
      projectRoot: repoRoot,
      defaultBranch: "main",
      mergeBaseBranch: "release",
    });

    expect(statusAgainstMain.mergeBaseBranch).toBe("main");
    expect(statusAgainstMain.aheadCount).toBe(1);
    expect(statusAgainstRelease.mergeBaseBranch).toBe("release");
    expect(statusAgainstRelease.aheadCount).toBe(2);
    expect(statusAgainstRelease.mergeBaseBranches).toContain("main");
    expect(statusAgainstRelease.mergeBaseBranches).toContain("release");
  });

  it("does not auto-select an arbitrary merge-base branch when default branch is unknown", () => {
    const repoRoot = makeTempDir();
    git(repoRoot, "init");
    git(repoRoot, "config", "user.name", "Beanbag Test");
    git(repoRoot, "config", "user.email", "beanbag-test@example.com");

    writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "initial");
    git(repoRoot, "branch", "-m", "topic");
    git(repoRoot, "checkout", "-b", "release");
    git(repoRoot, "checkout", "topic");

    const service = new ThreadGitStatusService();
    const status = service.getStatus({
      workspaceRoot: repoRoot,
      projectRoot: repoRoot,
    });

    expect(status.defaultBranch).toBeUndefined();
    expect(status.mergeBaseBranch).toBeUndefined();
    expect(status.baseRef).toBeUndefined();
    expect(status.mergeBaseBranches).toContain("topic");
    expect(status.mergeBaseBranches).toContain("release");
  });

  it("reports merge-base diff stats for committed worktree changes", () => {
    const repoRoot = makeTempDir();
    git(repoRoot, "init");
    git(repoRoot, "config", "user.name", "Beanbag Test");
    git(repoRoot, "config", "user.email", "beanbag-test@example.com");
    git(repoRoot, "checkout", "-b", "main");

    writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "initial");

    git(repoRoot, "checkout", "-b", "thread");
    writeFileSync(join(repoRoot, "FEATURE.md"), "thread change\n", "utf8");
    git(repoRoot, "add", "FEATURE.md");
    git(repoRoot, "commit", "-m", "add feature");

    const service = new ThreadGitStatusService();
    const status = service.getStatus({
      workspaceRoot: repoRoot,
      projectRoot: repoRoot,
      defaultBranch: "main",
    });

    expect(status.workspaceChangedFiles).toBe(0);
    expect(status.workspaceInsertions).toBe(0);
    expect(status.workspaceDeletions).toBe(0);
    expect(status.changedFiles).toBe(1);
    expect(status.insertions).toBe(1);
    expect(status.deletions).toBe(0);
    expect(status.files?.some((entry) => entry.path === "FEATURE.md" && entry.status === "A")).toBe(true);
    expect(status.hasCommittedUnmergedChanges).toBe(true);
    expect(status.state).toBe("committed_unmerged");
  });

  it("ignores merge-base branch-only commits when reporting thread diff stats", () => {
    const repoRoot = makeTempDir();
    git(repoRoot, "init");
    git(repoRoot, "config", "user.name", "Beanbag Test");
    git(repoRoot, "config", "user.email", "beanbag-test@example.com");
    git(repoRoot, "checkout", "-b", "main");

    writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "initial");

    git(repoRoot, "checkout", "-b", "thread");
    writeFileSync(join(repoRoot, "THREAD.md"), "thread only\n", "utf8");
    git(repoRoot, "add", "THREAD.md");
    git(repoRoot, "commit", "-m", "thread change");

    git(repoRoot, "checkout", "main");
    writeFileSync(join(repoRoot, "BASE_ONLY.md"), "main only\n", "utf8");
    git(repoRoot, "add", "BASE_ONLY.md");
    git(repoRoot, "commit", "-m", "main change");

    git(repoRoot, "checkout", "thread");

    const service = new ThreadGitStatusService();
    const status = service.getStatus({
      workspaceRoot: repoRoot,
      projectRoot: repoRoot,
      defaultBranch: "main",
    });

    expect(status.changedFiles).toBe(1);
    expect(status.insertions).toBe(1);
    expect(status.deletions).toBe(0);
    expect(status.files?.some((entry) => entry.path === "THREAD.md" && entry.status === "A")).toBe(true);
    expect(status.files?.some((entry) => entry.path === "BASE_ONLY.md")).toBe(false);
  });

  it("includes uncommitted worktree changes in combined diff output", () => {
    const repoRoot = makeTempDir();
    git(repoRoot, "init");
    git(repoRoot, "config", "user.name", "Beanbag Test");
    git(repoRoot, "config", "user.email", "beanbag-test@example.com");
    git(repoRoot, "checkout", "-b", "main");

    writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "initial");

    git(repoRoot, "checkout", "-b", "thread");
    writeFileSync(join(repoRoot, "README.md"), "initial\nthread draft\n", "utf8");

    const service = new ThreadGitStatusService();
    const status = service.getStatus({
      workspaceRoot: repoRoot,
      projectRoot: repoRoot,
      defaultBranch: "main",
    });
    const diffResult = service.getCombinedDiffSinceRef({
      workspaceRoot: repoRoot,
      baseRef: status.baseRef,
    });

    expect(diffResult.diff).toContain("diff --git a/README.md b/README.md");
    expect(diffResult.diff).toContain("+thread draft");
  });

  it("combined diff excludes merge-base branch-only commits and keeps uncommitted edits", () => {
    const repoRoot = makeTempDir();
    git(repoRoot, "init");
    git(repoRoot, "config", "user.name", "Beanbag Test");
    git(repoRoot, "config", "user.email", "beanbag-test@example.com");
    git(repoRoot, "checkout", "-b", "main");

    writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "initial");

    git(repoRoot, "checkout", "-b", "thread");
    writeFileSync(join(repoRoot, "THREAD.md"), "thread committed\n", "utf8");
    git(repoRoot, "add", "THREAD.md");
    git(repoRoot, "commit", "-m", "thread committed");

    git(repoRoot, "checkout", "main");
    writeFileSync(join(repoRoot, "BASE_ONLY.md"), "main only\n", "utf8");
    git(repoRoot, "add", "BASE_ONLY.md");
    git(repoRoot, "commit", "-m", "main change");

    git(repoRoot, "checkout", "thread");
    writeFileSync(join(repoRoot, "THREAD.md"), "thread committed\nthread uncommitted\n", "utf8");

    const service = new ThreadGitStatusService();
    const status = service.getStatus({
      workspaceRoot: repoRoot,
      projectRoot: repoRoot,
      defaultBranch: "main",
    });
    const diffResult = service.getCombinedDiffSinceRef({
      workspaceRoot: repoRoot,
      baseRef: status.baseRef,
    });

    expect(diffResult.diff).toContain("THREAD.md");
    expect(diffResult.diff).toContain("+thread committed");
    expect(diffResult.diff).toContain("+thread uncommitted");
    expect(diffResult.diff).not.toContain("BASE_ONLY.md");
  });

  it("lists untracked files instead of collapsing to untracked directories", () => {
    const repoRoot = makeTempDir();
    git(repoRoot, "init");
    git(repoRoot, "config", "user.name", "Beanbag Test");
    git(repoRoot, "config", "user.email", "beanbag-test@example.com");
    git(repoRoot, "checkout", "-b", "main");

    writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "initial");

    const nestedDir = join(repoRoot, "plans");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, "note.md"), "hello\n", { encoding: "utf8", flag: "w" });

    const service = new ThreadGitStatusService();
    const status = service.getStatus({
      workspaceRoot: repoRoot,
      projectRoot: repoRoot,
      defaultBranch: "main",
    });

    expect(status.files?.some((entry) => entry.path === "plans/note.md" && entry.status === "A?")).toBe(true);
    expect(status.files?.some((entry) => entry.path === "plans/note.md")).toBe(true);
    expect(status.files?.some((entry) => entry.path === "plans/")).toBe(false);
  });

  it("marks unstaged tracked edits with a trailing question mark", () => {
    const repoRoot = makeTempDir();
    git(repoRoot, "init");
    git(repoRoot, "config", "user.name", "Beanbag Test");
    git(repoRoot, "config", "user.email", "beanbag-test@example.com");
    git(repoRoot, "checkout", "-b", "main");

    writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "initial");

    writeFileSync(join(repoRoot, "README.md"), "initial\nedit\n", "utf8");

    const service = new ThreadGitStatusService();
    const status = service.getStatus({
      workspaceRoot: repoRoot,
      projectRoot: repoRoot,
      defaultBranch: "main",
    });

    expect(status.files?.some((entry) => entry.path === "README.md" && entry.status === "M?")).toBe(true);
  });

});
