import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IEnvironment } from "../contracts.js";
import { createWorktreeEnvironmentDefinition } from "../worktree-environment.js";

const tempDirs: string[] = [];
const environments: IEnvironment[] = [];

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "bb-environment-worktree-"));
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

function commitReadme(cwd: string, contents: string, message: string): void {
  writeFileSync(join(cwd, "README.md"), contents, "utf8");
  git(cwd, "add", "README.md");
  git(cwd, "commit", "-m", message);
}

async function createRepoWithThreadAheadOfMain() {
  const repoRoot = makeTempDir();
  const suffix = randomUUID();
  git(repoRoot, "init");
  git(repoRoot, "config", "user.name", "Beanbag Test");
  git(repoRoot, "config", "user.email", "beanbag-test@example.com");
  git(repoRoot, "checkout", "-b", "main");

  commitReadme(repoRoot, "initial\n", "initial");

  const environment = createWorktreeEnvironmentDefinition({
    manageEnvironmentAgent: false,
  }).create({
    projectId: `project-${suffix}`,
    threadId: `thread-${suffix}`,
    projectRootPath: repoRoot,
    runtimeEnv: {},
  });
  await environment.prepare?.();
  environments.push(environment);

  commitReadme(
    environment.getWorkspaceRootUnsafe(),
    "initial\nthread change\n",
    "thread change",
  );

  return { repoRoot, environment };
}

async function createRepoWithThreadTwoCommits() {
  const setup = await createRepoWithThreadAheadOfMain();
  commitReadme(
    setup.environment.getWorkspaceRootUnsafe(),
    "initial\nthread change\nthread follow-up\n",
    "thread follow-up",
  );
  return setup;
}

afterEach(async () => {
  for (const environment of environments.splice(0)) {
    await environment.dispose();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("WorktreeEnvironment", () => {
  it("rejects promotion when the active workspace is dirty", async () => {
    const { repoRoot, environment } = await createRepoWithThreadAheadOfMain();

    writeFileSync(join(repoRoot, "README.md"), "initial\nmain dirty change\n", "utf8");

    expect(() =>
      environment.promoteToActiveWorkspace({
        activeWorkspaceRoot: repoRoot,
      })
    ).toThrow(
      "Primary checkout has local changes. Commit, stash, or discard changes before promoting a thread.",
    );
  });

  it("rejects promotion when the worktree is dirty", async () => {
    const { repoRoot, environment } = await createRepoWithThreadAheadOfMain();

    writeFileSync(
      join(environment.getWorkspaceRootUnsafe(), "README.md"),
      "initial\nthread dirty change\n",
      "utf8",
    );

    expect(() =>
      environment.promoteToActiveWorkspace({
        activeWorkspaceRoot: repoRoot,
      })
    ).toThrow(
      "Thread worktree has local changes. Commit, stash, or discard changes before promoting a thread.",
    );
  });

  it("uses a resolved squash message when no explicit message is provided", async () => {
    const { repoRoot, environment } = await createRepoWithThreadAheadOfMain();
    const resolveMessage = vi
      .fn()
      .mockImplementation(async ({ tempWorkspaceRoot }: { tempWorkspaceRoot: string }) => {
        expect(git(tempWorkspaceRoot, "diff", "--cached", "--name-only")).toContain("README.md");
        return "feat: integrate thread updates";
      });

    const result = await environment.squashMergeIntoDefaultBranch({
      activeWorkspaceRoot: repoRoot,
      defaultBranch: "main",
      resolveMessage,
    });

    expect(result).toEqual({ merged: true, message: "Squash-merged into main", committed: false });
    expect(resolveMessage).toHaveBeenCalledTimes(1);
    expect(git(repoRoot, "show", "-s", "--format=%s", "main")).toBe(
      "feat: integrate thread updates",
    );
  });

  it("falls back to the default squash message when resolution fails", async () => {
    const { repoRoot, environment } = await createRepoWithThreadAheadOfMain();
    const resolveMessage = vi.fn().mockRejectedValue(new Error("generation failed"));

    const result = await environment.squashMergeIntoDefaultBranch({
      activeWorkspaceRoot: repoRoot,
      defaultBranch: "main",
      resolveMessage,
    });

    expect(result).toEqual({ merged: true, message: "Squash-merged into main", committed: false });
    expect(resolveMessage).toHaveBeenCalledTimes(1);
    expect(git(repoRoot, "show", "-s", "--format=%s", "main")).toContain(
      "chore: squash merge from bb/thread-thread-",
    );
  });

  it("prefers explicit squash messages over resolved messages", async () => {
    const { repoRoot, environment } = await createRepoWithThreadAheadOfMain();
    const resolveMessage = vi.fn();

    const result = await environment.squashMergeIntoDefaultBranch({
      activeWorkspaceRoot: repoRoot,
      defaultBranch: "main",
      message: "feat: custom squash message",
      resolveMessage,
    });

    expect(result).toEqual({ merged: true, message: "Squash-merged into main", committed: false });
    expect(resolveMessage).not.toHaveBeenCalled();
    expect(git(repoRoot, "show", "-s", "--format=%s", "main")).toBe(
      "feat: custom squash message",
    );
  });

  it("reports the prep commit created during commit-and-squash flows", async () => {
    const { repoRoot, environment } = await createRepoWithThreadAheadOfMain();
    writeFileSync(
      join(environment.getWorkspaceRootUnsafe(), "README.md"),
      "initial\nthread change\nthread unstaged change\n",
      "utf8",
    );

    const result = await environment.squashMergeIntoDefaultBranch({
      activeWorkspaceRoot: repoRoot,
      defaultBranch: "main",
      commitIfNeeded: true,
      commitMessage: "chore: prep thread changes",
      includeUnstaged: true,
    });

    expect(result.merged).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.prepCommit).toEqual(
      expect.objectContaining({
        message: "Committed changes",
        includeUnstaged: true,
        commitSha: expect.any(String),
      }),
    );
    expect(git(repoRoot, "show", "-s", "--format=%s", "main")).toContain("squash merge");
  });

  it("reports committed branch work before the thread is merged", async () => {
    const { environment } = await createRepoWithThreadAheadOfMain();

    const status = environment.getWorkspaceStatus({ defaultBranch: "main" });

    expect(status.aheadCount).toBe(1);
    expect(status.behindCount).toBe(0);
    expect(status.hasCommittedUnmergedChanges).toBe(true);
    expect(status.state).toBe("committed_unmerged");
  });

  it("treats multi-commit squash merges as merged even when cherry still sees ahead commits", async () => {
    const { repoRoot, environment } = await createRepoWithThreadTwoCommits();

    await environment.squashMergeIntoDefaultBranch({
      activeWorkspaceRoot: repoRoot,
      defaultBranch: "main",
    });

    const status = environment.getWorkspaceStatus({ defaultBranch: "main" });

    expect(status.aheadCount).toBeGreaterThan(0);
    expect(status.hasCommittedUnmergedChanges).toBe(false);
    expect(status.state).toBe("clean");
    expect(status.changedFiles).toBe(0);
    expect(status.insertions).toBe(0);
    expect(status.deletions).toBe(0);
    expect(status.files).toEqual([]);
  });

  it("keeps squash-merged branches clean after main later changes the same file", async () => {
    const { repoRoot, environment } = await createRepoWithThreadAheadOfMain();

    await environment.squashMergeIntoDefaultBranch({
      activeWorkspaceRoot: repoRoot,
      defaultBranch: "main",
    });
    commitReadme(repoRoot, "initial\nthread change\nmain follow-up\n", "main follow-up");

    const status = environment.getWorkspaceStatus({ defaultBranch: "main" });

    expect(status.aheadCount).toBe(0);
    expect(status.behindCount).toBe(2);
    expect(status.hasCommittedUnmergedChanges).toBe(false);
    expect(status.state).toBe("clean");
    expect(status.changedFiles).toBe(0);
    expect(status.insertions).toBe(0);
    expect(status.deletions).toBe(0);
    expect(status.files).toEqual([]);
  });
});
