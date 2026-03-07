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

async function createRepoWithThreadAheadOfMain() {
  const repoRoot = makeTempDir();
  const suffix = randomUUID();
  git(repoRoot, "init");
  git(repoRoot, "config", "user.name", "Beanbag Test");
  git(repoRoot, "config", "user.email", "beanbag-test@example.com");
  git(repoRoot, "checkout", "-b", "main");

  writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf8");
  git(repoRoot, "add", "README.md");
  git(repoRoot, "commit", "-m", "initial");

  const environment = createWorktreeEnvironmentDefinition().create({
    projectId: `project-${suffix}`,
    threadId: `thread-${suffix}`,
    projectRootPath: repoRoot,
    runtimeEnv: {},
  });
  await environment.prepare?.();
  environments.push(environment);

  writeFileSync(
    join(environment.getWorkspaceRootUnsafe(), "README.md"),
    "initial\nthread change\n",
    "utf8",
  );
  environment.run("git", ["add", "README.md"]);
  environment.run("git", ["commit", "-m", "thread change"]);

  return { repoRoot, environment };
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
});
