import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EnvironmentSquashMergeCommitFailureError,
  type IEnvironment,
} from "../contracts.js";
import {
  createLocalGitWorkspaceDefinition,
  ensureLocalGitWorkspace,
  removeLocalGitWorkspace,
  type LocalGitWorkspaceState,
} from "../local-git-workspace.js";

const tempDirs: string[] = [];
const environments: Array<{ environment: IEnvironment; projectRoot: string }> = [];

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
  git(repoRoot, "config", "user.name", "BB Test");
  git(repoRoot, "config", "user.email", "bb-test@example.com");
  git(repoRoot, "checkout", "-b", "main");

  commitReadme(repoRoot, "initial\n", "initial");

  const environment = createLocalGitWorkspaceDefinition({
    manageEnvironmentAgent: false,
  }).create({
    projectId: `project-${suffix}`,
    threadId: `thread-${suffix}`,
    projectRootPath: repoRoot,
    runtimeEnv: {},
  });
  await ensureLocalGitWorkspace({
    projectRootPath: repoRoot,
    state: environment.serialize() as LocalGitWorkspaceState,
    runtimeEnv: {},
  });
  await environment.prepare?.();
  environments.push({ environment, projectRoot: repoRoot });

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
  for (const entry of environments.splice(0)) {
    await entry.environment.destroy();
    await removeLocalGitWorkspace({
      projectRootPath: entry.projectRoot,
      workspaceRoot: entry.environment.getWorkspaceRootUnsafe(),
      runtimeEnv: {},
    });
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("LocalGitWorkspace", () => {
  it("rejects promotion when the active workspace is dirty", async () => {
    const { repoRoot, environment } = await createRepoWithThreadAheadOfMain();

    writeFileSync(join(repoRoot, "README.md"), "initial\nmain dirty change\n", "utf8");

    await expect(
      environment.promoteToActiveWorkspace({
        activeWorkspaceRoot: repoRoot,
      })
    ).rejects.toThrow(
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

    await expect(
      environment.promoteToActiveWorkspace({
        activeWorkspaceRoot: repoRoot,
      })
    ).rejects.toThrow(
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

    expect(result).toEqual(
      expect.objectContaining({
        merged: true,
        message: "Squash-merged into main",
        committed: false,
        commitSha: expect.any(String),
        commitSubject: "feat: integrate thread updates",
      }),
    );
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

    expect(result).toEqual(
      expect.objectContaining({
        merged: true,
        message: "Squash-merged into main",
        committed: false,
        commitSha: expect.any(String),
        commitSubject: expect.stringContaining("chore: squash merge from bb/env-"),
      }),
    );
    expect(resolveMessage).toHaveBeenCalledTimes(1);
    expect(git(repoRoot, "show", "-s", "--format=%s", "main")).toContain(
      "chore: squash merge from bb/env-",
    );
  });

  it("does not resolve a squash message when the squash merge conflicts", async () => {
    const { repoRoot, environment } = await createRepoWithThreadAheadOfMain();
    commitReadme(repoRoot, "initial\nmain change\n", "main change");
    commitReadme(
      environment.getWorkspaceRootUnsafe(),
      "initial\nthread conflicting change\n",
      "thread conflicting change",
    );
    const resolveMessage = vi.fn();

    const result = await environment.squashMergeIntoDefaultBranch({
      activeWorkspaceRoot: repoRoot,
      defaultBranch: "main",
      resolveMessage,
    });

    expect(result.merged).toBe(false);
    expect(result.message).toContain("Squash merge has conflicts against main");
    expect(resolveMessage).not.toHaveBeenCalled();
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

    expect(result).toEqual(
      expect.objectContaining({
        merged: true,
        message: "Squash-merged into main",
        committed: false,
        commitSha: expect.any(String),
        commitSubject: "feat: custom squash message",
      }),
    );
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
    expect(result.commitSha).toEqual(expect.any(String));
    expect(result.commitSubject).toContain("squash merge");
    expect(result.prepCommit).toEqual(
      expect.objectContaining({
        message: "Committed changes",
        commitSubject: "chore: prep thread changes",
        includeUnstaged: true,
        commitSha: expect.any(String),
      }),
    );
    expect(git(repoRoot, "show", "-s", "--format=%s", "main")).toContain("squash merge");
  });

  it("bypasses git hooks when creating the synthetic squash commit", async () => {
    const { repoRoot, environment } = await createRepoWithThreadAheadOfMain();
    const hooksDir = makeTempDir();
    const hookPath = join(hooksDir, "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(hookPath, 0o755);
    git(repoRoot, "config", "core.hooksPath", hooksDir);

    expect(() => git(repoRoot, "commit", "--allow-empty", "-m", "blocked by hook")).toThrow();

    const result = await environment.squashMergeIntoDefaultBranch({
      activeWorkspaceRoot: repoRoot,
      defaultBranch: "main",
    });

    expect(result).toEqual(
      expect.objectContaining({
        merged: true,
        message: "Squash-merged into main",
        committed: false,
        commitSha: expect.any(String),
      }),
    );
  });

  it("re-checks for unresolved conflicts after squash message generation", async () => {
    const { repoRoot, environment } = await createRepoWithThreadAheadOfMain();
    const resolveMessage = vi.fn().mockImplementation(async ({
      tempWorkspaceRoot,
    }: {
      tempWorkspaceRoot: string;
    }) => {
      const ours = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: tempWorkspaceRoot,
        encoding: "utf8",
        input: "ours\n",
      }).trim();
      const theirs = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: tempWorkspaceRoot,
        encoding: "utf8",
        input: "theirs\n",
      }).trim();
      execFileSync("git", ["update-index", "--force-remove", "README.md"], {
        cwd: tempWorkspaceRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      execFileSync("git", ["update-index", "--index-info"], {
        cwd: tempWorkspaceRoot,
        encoding: "utf8",
        input: `100644 ${ours} 1\tREADME.md\n100644 ${ours} 2\tREADME.md\n100644 ${theirs} 3\tREADME.md\n`,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return "feat: integrate thread updates";
    });

    await expect(
      environment.squashMergeIntoDefaultBranch({
        activeWorkspaceRoot: repoRoot,
        defaultBranch: "main",
        resolveMessage,
      }),
    ).rejects.toMatchObject({
      name: "EnvironmentSquashMergeCommitFailureError",
      stage: "squash_commit",
      message: expect.stringContaining("Squash merge has unresolved conflicts: README.md"),
    } satisfies Partial<EnvironmentSquashMergeCommitFailureError>);
    expect(resolveMessage).toHaveBeenCalledTimes(1);
  });

  it("reports committed branch work before the thread is merged", async () => {
    const { environment } = await createRepoWithThreadAheadOfMain();

    const status = await environment.getWorkspaceStatus({ defaultBranch: "main" });

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

    const status = await environment.getWorkspaceStatus({ defaultBranch: "main" });

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

    const status = await environment.getWorkspaceStatus({ defaultBranch: "main" });

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
