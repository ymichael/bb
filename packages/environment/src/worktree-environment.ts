import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { SystemEnvironmentInfo } from "@beanbag/agent-core";
import type {
  CreateEnvironmentContext,
  DemoteEnvironmentOptions,
  DemoteEnvironmentResult,
  EnvironmentCommandOptions,
  EnvironmentDefinition,
  EnvironmentCheckoutSnapshot,
  EnvironmentSquashMergeOptions,
  EnvironmentSquashMergeResult,
  IEnvironment,
  PromoteEnvironmentOptions,
  PromoteEnvironmentResult,
} from "./contracts.js";
import { runCommand } from "./process.js";

export interface WorktreeEnvironmentState {
  workspaceRoot: string;
  branchName: string;
}

export interface CreateWorktreeEnvironmentDefinitionOptions {
  worktreeRootName?: string;
}

const WORKTREE_ENVIRONMENT_INFO: SystemEnvironmentInfo = {
  id: "worktree",
  displayName: "Git Worktree Workspace",
  description:
    "Provision an isolated per-thread git worktree when the project is a git repository.",
};
const DEFAULT_WORKTREE_ROOT = "~/.beanbag/worktrees";

function toChildEnv(
  env: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  return env;
}

function normalizeDetail(message: string | Buffer): string {
  return (typeof message === "string" ? message : message.toString("utf8")).trim();
}

function runGitAtPath(
  cwd: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? result.error?.message ?? "",
  };
}

function hasLocalBranch(projectRoot: string, branch: string): boolean {
  return runGitAtPath(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

function resolveWorktreeStartRef(projectRoot: string): string | undefined {
  if (hasLocalBranch(projectRoot, "main")) return "main";
  if (hasLocalBranch(projectRoot, "master")) return "master";
  const headBranch = runGitAtPath(projectRoot, ["symbolic-ref", "--short", "HEAD"]);
  return headBranch.ok && headBranch.stdout.length > 0 ? headBranch.stdout : undefined;
}

function toWorktreeBranchName(threadId: string): string {
  const normalized = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `bb/thread-${normalized.length > 0 ? normalized : "thread"}`;
}

function summarizeSpawnSyncFailure(result: {
  error?: Error;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
  status?: number | null;
  signal?: NodeJS.Signals | null;
}): string {
  if (result.error?.message) return normalizeDetail(result.error.message);
  if (result.stderr !== undefined) {
    const stderr = normalizeDetail(result.stderr);
    if (stderr.length > 0) return stderr;
  }
  if (result.stdout !== undefined) {
    const stdout = normalizeDetail(result.stdout);
    if (stdout.length > 0) return stdout;
  }
  if (result.signal) return `terminated by signal ${result.signal}`;
  if (typeof result.status === "number") return `exited with status ${result.status}`;
  return "unknown error";
}

function expandHomeDirectory(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function resolveConfiguredWorktreeRoot(
  projectRoot: string,
  configuredRoot: string,
): { root: string; isGlobalRoot: boolean } {
  const normalizedRoot = expandHomeDirectory(configuredRoot.trim());
  if (isAbsolute(normalizedRoot)) {
    return { root: normalizedRoot, isGlobalRoot: true };
  }
  return {
    root: resolve(projectRoot, normalizedRoot),
    isGlobalRoot: false,
  };
}

function hasLocalWorkingChanges(repoRoot: string): boolean {
  const status = runGitAtPath(repoRoot, ["status", "--porcelain"]);
  return status.ok && status.stdout.trim().length > 0;
}

function resolveCheckoutSnapshot(repoRoot: string): EnvironmentCheckoutSnapshot {
  const headResult = runGitAtPath(repoRoot, ["rev-parse", "HEAD"]);
  if (!headResult.ok || !headResult.stdout) {
    throw new Error("Failed to resolve HEAD");
  }

  const branchResult = runGitAtPath(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branchResult.ok && branchResult.stdout) {
    return {
      branch: branchResult.stdout,
      head: headResult.stdout,
      detached: false,
    };
  }

  return {
    head: headResult.stdout,
    detached: true,
  };
}

function hasRepoLocalBranch(repoRoot: string, branch: string): boolean {
  return runGitAtPath(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

function checkoutSnapshot(repoRoot: string, snapshot: EnvironmentCheckoutSnapshot): void {
  const branch = snapshot.branch?.trim();
  if (branch && hasRepoLocalBranch(repoRoot, branch)) {
    const branchCheckout = runGitAtPath(repoRoot, ["checkout", "--ignore-other-worktrees", branch]);
    if (branchCheckout.ok) return;
  }

  const detachedCheckout = runGitAtPath(repoRoot, ["checkout", "--detach", snapshot.head]);
  if (!detachedCheckout.ok) {
    throw new Error(detachedCheckout.stderr || "Failed to checkout detached HEAD");
  }
}

function resolveDefaultBranch(repoRoot: string): string | undefined {
  const remoteHead = runGitAtPath(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (remoteHead.ok && remoteHead.stdout.startsWith("refs/remotes/origin/")) {
    return remoteHead.stdout.slice("refs/remotes/origin/".length);
  }
  if (hasLocalBranch(repoRoot, "main")) return "main";
  if (hasLocalBranch(repoRoot, "master")) return "master";
  return undefined;
}

class WorktreeEnvironment implements IEnvironment {
  readonly kind = "worktree";
  readonly info = { ...WORKTREE_ENVIRONMENT_INFO };
  private readonly rootPath: string;
  private readonly env: Record<string, string | undefined>;

  constructor(
    private readonly projectRoot: string,
    private readonly state: WorktreeEnvironmentState,
  ) {
    this.rootPath = state.workspaceRoot;
    this.env = {};
  }

  serialize(): WorktreeEnvironmentState {
    return { ...this.state };
  }

  dispose(): void {
    spawnSync(
      "git",
      ["worktree", "remove", "--force", this.state.workspaceRoot],
      {
        cwd: this.projectRoot,
        stdio: "pipe",
      },
    );
    rmSync(this.state.workspaceRoot, { recursive: true, force: true });
  }

  getWorkspaceRoot(): string {
    return this.rootPath;
  }

  getExecutionContext(): { cwd: string; env: Record<string, string | undefined> } {
    return {
      cwd: this.rootPath,
      env: { ...this.env },
    };
  }

  shouldRunSetupScript(): boolean {
    return true;
  }

  supportsPromoteToActiveWorkspace(): boolean {
    return true;
  }

  supportsDemoteFromActiveWorkspace(): boolean {
    return true;
  }

  supportsSquashMergeIntoDefaultBranch(): boolean {
    return true;
  }

  promoteToActiveWorkspace(args: PromoteEnvironmentOptions): PromoteEnvironmentResult {
    if (hasLocalWorkingChanges(args.activeWorkspaceRoot)) {
      throw new Error(
        "Primary checkout has local changes. Commit, stash, or discard changes before promoting a thread.",
      );
    }
    if (hasLocalWorkingChanges(this.rootPath)) {
      throw new Error(
        "Thread worktree has local changes. Commit, stash, or discard changes before promoting a thread.",
      );
    }

    const previousCheckout = resolveCheckoutSnapshot(args.activeWorkspaceRoot);
    const promotedCheckout = resolveCheckoutSnapshot(this.rootPath);

    try {
      checkoutSnapshot(args.activeWorkspaceRoot, promotedCheckout);
      return {
        previousCheckout,
        promotedCheckout,
      };
    } catch (err) {
      try {
        checkoutSnapshot(args.activeWorkspaceRoot, previousCheckout);
      } catch (restoreErr) {
        const restoreMessage = restoreErr instanceof Error
          ? restoreErr.message
          : String(restoreErr);
        throw new Error(
          `${err instanceof Error ? err.message : String(err)} (failed to restore primary checkout: ${restoreMessage})`,
        );
      }
      throw err;
    }
  }

  demoteFromActiveWorkspace(args: DemoteEnvironmentOptions): DemoteEnvironmentResult {
    const reset = runGitAtPath(args.activeWorkspaceRoot, ["reset", "--hard"]);
    if (!reset.ok) {
      throw new Error(reset.stderr || "Failed to reset primary checkout");
    }
    const clean = runGitAtPath(args.activeWorkspaceRoot, ["clean", "-fd"]);
    if (!clean.ok) {
      throw new Error(clean.stderr || "Failed to clean primary checkout");
    }
    checkoutSnapshot(args.activeWorkspaceRoot, args.snapshot);
    return {
      restoredCheckout: args.snapshot,
    };
  }

  async squashMergeIntoDefaultBranch(
    args: EnvironmentSquashMergeOptions,
  ): Promise<EnvironmentSquashMergeResult> {
    const mergeBaseBranch =
      args.defaultBranch ?? resolveDefaultBranch(args.activeWorkspaceRoot);
    if (!mergeBaseBranch) {
      throw new Error("Could not determine merge base branch");
    }
    const statusResult = this.run("git", ["status", "--porcelain"]);
    if (statusResult.exitCode !== 0) {
      throw new Error(statusResult.stderr || "Failed to inspect worktree status");
    }
    if (statusResult.stdout.trim().length > 0) {
      throw new Error("Workspace has uncommitted changes; commit first");
    }
    if (hasLocalWorkingChanges(args.activeWorkspaceRoot)) {
      throw new Error(
        "Project root has local changes that could be lost; commit or stash them before squash merge",
      );
    }

    const workspaceHead = this.run("git", ["rev-parse", "HEAD"]);
    if (workspaceHead.exitCode !== 0 || !workspaceHead.stdout) {
      throw new Error("Failed to resolve worktree HEAD");
    }

    const currentProjectBranch = runGitAtPath(args.activeWorkspaceRoot, ["symbolic-ref", "--short", "HEAD"]);
    const defaultHead = runGitAtPath(args.activeWorkspaceRoot, ["rev-parse", mergeBaseBranch]);
    if (!defaultHead.ok || !defaultHead.stdout) {
      throw new Error(`Failed to resolve ${mergeBaseBranch}`);
    }

    const aheadResult = this.run("git", [
      "rev-list",
      "--left-right",
      "--count",
      `${mergeBaseBranch}...HEAD`,
    ]);
    if (aheadResult.exitCode === 0) {
      const [, aheadRaw] = aheadResult.stdout.split("\t");
      const aheadCount = Number.parseInt(aheadRaw ?? "0", 10);
      if (!Number.isNaN(aheadCount) && aheadCount <= 0) {
        return { merged: false, message: "No commits to merge" };
      }
    }

    const tempRoot = mkdtempSync(join(tmpdir(), "beanbag-squash-merge-"));
    const tempWorkspaceRoot = resolve(tempRoot, "integration");

    try {
      const addWorktree = runGitAtPath(args.activeWorkspaceRoot, [
        "worktree",
        "add",
        "--detach",
        tempWorkspaceRoot,
        defaultHead.stdout,
      ]);
      if (!addWorktree.ok) {
        throw new Error(addWorktree.stderr || "Failed to prepare integration worktree");
      }

      const squashResult = runGitAtPath(tempWorkspaceRoot, [
        "merge",
        "--squash",
        workspaceHead.stdout,
      ]);
      if (!squashResult.ok) {
        const conflictFiles = runGitAtPath(tempWorkspaceRoot, [
          "diff",
          "--name-only",
          "--diff-filter=U",
        ]);
        runGitAtPath(tempWorkspaceRoot, ["reset", "--hard"]);
        return {
          merged: false,
          message:
            `Squash merge has conflicts against ${mergeBaseBranch}. Rebase/merge ${mergeBaseBranch} into the worktree, resolve conflicts, and retry.`,
          ...(conflictFiles.ok && conflictFiles.stdout
            ? {
                conflictFiles: conflictFiles.stdout
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0),
              }
            : {}),
        };
      }

      const hasSquashedChanges = runGitAtPath(tempWorkspaceRoot, [
        "diff",
        "--cached",
        "--quiet",
      ]);
      if (hasSquashedChanges.ok) {
        return { merged: false, message: "No changes to merge after squash" };
      }

      const sourceBranch = runGitAtPath(this.rootPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      const defaultMessage = `chore: squash merge from ${sourceBranch.ok && sourceBranch.stdout ? sourceBranch.stdout : "worktree"}`;
      let message = args.message?.trim();
      if (!message && args.resolveMessage) {
        try {
          const resolved = await args.resolveMessage({
            tempWorkspaceRoot,
            mergeBaseBranch,
            sourceBranch: sourceBranch.ok ? sourceBranch.stdout : undefined,
            defaultMessage,
          });
          const trimmed = resolved?.trim();
          if (trimmed) {
            message = trimmed;
          }
        } catch {
          // Fall back to the default message when generation fails.
        }
      }
      const finalMessage = message || defaultMessage;
      const commitResult = runGitAtPath(tempWorkspaceRoot, [
        "commit",
        "-m",
        finalMessage,
      ]);
      if (!commitResult.ok) {
        throw new Error(commitResult.stderr || "Failed to commit squashed merge");
      }

      const mergedHead = runGitAtPath(tempWorkspaceRoot, ["rev-parse", "HEAD"]);
      if (!mergedHead.ok || !mergedHead.stdout) {
        throw new Error("Failed to resolve squashed merge commit");
      }

      const updateRef = runGitAtPath(args.activeWorkspaceRoot, [
        "update-ref",
        `refs/heads/${mergeBaseBranch}`,
        mergedHead.stdout,
        defaultHead.stdout,
      ]);
      if (!updateRef.ok) {
        throw new Error(
          updateRef.stderr || `${mergeBaseBranch} moved during squash merge; please retry`,
        );
      }

      if (currentProjectBranch.ok && currentProjectBranch.stdout === mergeBaseBranch) {
        const resetResult = runGitAtPath(args.activeWorkspaceRoot, [
          "reset",
          "--hard",
          mergedHead.stdout,
        ]);
        if (!resetResult.ok) {
          throw new Error(
            resetResult.stderr || `Squash merged into ${mergeBaseBranch}, but failed to refresh checkout`,
          );
        }
      }

      return { merged: true, message: `Squash-merged into ${mergeBaseBranch}` };
    } finally {
      runGitAtPath(args.activeWorkspaceRoot, [
        "worktree",
        "remove",
        "--force",
        tempWorkspaceRoot,
      ]);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  run(
    command: string,
    args: string[],
    options?: EnvironmentCommandOptions,
  ) {
    const executionContext = this.getExecutionContext();
    return runCommand(command, args, {
      cwd: options?.cwd ?? executionContext.cwd,
      env: {
        ...executionContext.env,
        ...(options?.env ?? {}),
      },
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.rawOutput ? { rawOutput: true } : {}),
    });
  }
}

export function createWorktreeEnvironmentDefinition(
  opts?: CreateWorktreeEnvironmentDefinitionOptions,
): EnvironmentDefinition<WorktreeEnvironmentState> {
  const worktreeRootName =
    opts?.worktreeRootName ??
    process.env.BEANBAG_WORKTREE_ROOT ??
    DEFAULT_WORKTREE_ROOT;

  return {
    kind: "worktree",
    info: { ...WORKTREE_ENVIRONMENT_INFO },
    create(context: CreateEnvironmentContext): IEnvironment {
      const projectRoot = context.projectRootPath;
      if (!existsSync(join(projectRoot, ".git"))) {
        throw new Error("Worktree provisioning requires a git repository at the project root");
      }

      const { root: configuredWorktreeRoot, isGlobalRoot } =
        resolveConfiguredWorktreeRoot(projectRoot, worktreeRootName);
      const worktreeRoot = isGlobalRoot
        ? resolve(configuredWorktreeRoot, context.projectId)
        : configuredWorktreeRoot;
      const workspaceRoot = resolve(worktreeRoot, context.threadId);
      const branchName = toWorktreeBranchName(context.threadId);
      mkdirSync(worktreeRoot, { recursive: true });

      if (!existsSync(workspaceRoot)) {
        const startRef = resolveWorktreeStartRef(projectRoot);
        const branchAddArgs = hasLocalBranch(projectRoot, branchName)
          ? ["worktree", "add", workspaceRoot, branchName]
          : ["worktree", "add", "-b", branchName, workspaceRoot, ...(startRef ? [startRef] : [])];
        const branchAddResult = spawnSync("git", branchAddArgs, {
          cwd: projectRoot,
          env: toChildEnv(context.runtimeEnv),
          stdio: "pipe",
        });
        const addResult = branchAddResult.status === 0
          ? branchAddResult
          : spawnSync("git", ["worktree", "add", "--detach", workspaceRoot], {
              cwd: projectRoot,
              env: toChildEnv(context.runtimeEnv),
              stdio: "pipe",
            });
        if (addResult.status !== 0) {
          throw new Error(`Failed to create worktree: ${summarizeSpawnSyncFailure(addResult)}`);
        }
      }

      return new WorktreeEnvironment(projectRoot, {
        workspaceRoot,
        branchName,
      });
    },
    restore(state: WorktreeEnvironmentState, context: CreateEnvironmentContext): IEnvironment {
      if (!existsSync(state.workspaceRoot)) {
        throw new Error(`Worktree workspace is unavailable: ${state.workspaceRoot}`);
      }
      return new WorktreeEnvironment(context.projectRootPath, state);
    },
    isState(value: unknown): value is WorktreeEnvironmentState {
      return (
        value !== null &&
        typeof value === "object" &&
        typeof (value as WorktreeEnvironmentState).workspaceRoot === "string" &&
        typeof (value as WorktreeEnvironmentState).branchName === "string"
      );
    },
  };
}
