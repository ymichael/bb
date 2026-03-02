import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ThreadGitStatusService } from "../thread-git-status.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "bb-thread-git-status-"));
  tempDirs.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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

  it("refuses squash merge when project root has local changes", () => {
    const repoRoot = makeTempDir();
    const threadRoot = join(makeTempDir(), "thread-worktree");
    git(repoRoot, "init");
    git(repoRoot, "config", "user.name", "Beanbag Test");
    git(repoRoot, "config", "user.email", "beanbag-test@example.com");
    git(repoRoot, "checkout", "-b", "main");

    writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "initial");

    git(repoRoot, "worktree", "add", "-b", "thread", threadRoot, "main");
    writeFileSync(join(threadRoot, "README.md"), "initial\nthread change\n", "utf8");
    git(threadRoot, "add", "README.md");
    git(threadRoot, "commit", "-m", "thread change");

    writeFileSync(join(repoRoot, "README.md"), "initial\nlocal dirty change\n", "utf8");

    const service = new ThreadGitStatusService();
    expect(() =>
      service.squashMergeWorktreeIntoDefaultBranch({
        workspaceRoot: threadRoot,
        projectRoot: repoRoot,
        defaultBranch: "main",
      })
    ).toThrow("Project root has local changes");
  });

  it("returns conflict file list when squash merge conflicts with main", () => {
    const repoRoot = makeTempDir();
    const threadRoot = join(makeTempDir(), "thread-worktree");
    git(repoRoot, "init");
    git(repoRoot, "config", "user.name", "Beanbag Test");
    git(repoRoot, "config", "user.email", "beanbag-test@example.com");
    git(repoRoot, "checkout", "-b", "main");

    writeFileSync(join(repoRoot, "README.md"), "line\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "initial");

    git(repoRoot, "worktree", "add", "-b", "thread", threadRoot, "main");
    writeFileSync(join(threadRoot, "README.md"), "thread line\n", "utf8");
    git(threadRoot, "add", "README.md");
    git(threadRoot, "commit", "-m", "thread change");

    writeFileSync(join(repoRoot, "README.md"), "main line\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "main change");

    const service = new ThreadGitStatusService();
    const result = service.squashMergeWorktreeIntoDefaultBranch({
      workspaceRoot: threadRoot,
      projectRoot: repoRoot,
      defaultBranch: "main",
    });

    expect(result.merged).toBe(false);
    expect(result.conflictFiles).toContain("README.md");
    expect(result.message).toContain("conflicts");
  });

  it("keeps project root clean when squash merge updates the checked-out default branch", () => {
    const repoRoot = makeTempDir();
    const threadRoot = join(makeTempDir(), "thread-worktree");
    git(repoRoot, "init");
    git(repoRoot, "config", "user.name", "Beanbag Test");
    git(repoRoot, "config", "user.email", "beanbag-test@example.com");
    git(repoRoot, "checkout", "-b", "main");

    writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf8");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-m", "initial");

    git(repoRoot, "worktree", "add", "-b", "thread", threadRoot, "main");
    writeFileSync(join(threadRoot, "README.md"), "initial\nthread change\n", "utf8");
    git(threadRoot, "add", "README.md");
    git(threadRoot, "commit", "-m", "thread change");

    const service = new ThreadGitStatusService();
    const result = service.squashMergeWorktreeIntoDefaultBranch({
      workspaceRoot: threadRoot,
      projectRoot: repoRoot,
      defaultBranch: "main",
    });

    expect(result.merged).toBe(true);
    expect(git(repoRoot, "status", "--porcelain")).toBe("");
    expect(git(repoRoot, "show", "--pretty=format:", "--name-only", "HEAD")).toContain("README.md");
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
