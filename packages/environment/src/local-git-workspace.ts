import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { expandHomeDirectory, resolveBbPath } from "@bb/core/storage-paths";
import type { EnvironmentAgentConnectionTarget } from "@bb/environment-daemon";
import { renderTemplate } from "@bb/templates";
import {
  EnvironmentSquashMergeCommitFailureError,
  type CreateEnvironmentContext,
  type DemoteEnvironmentOptions,
  type DemoteEnvironmentResult,
  type EnvironmentCommandOptions,
  type EnvironmentCommandResult,
  type EnvironmentSpawnOptions,
  type EnvironmentDefinition,
  type EnvironmentCheckoutSnapshot,
  type EnvironmentCommitSummary,
  type EnvironmentInfo,
  type EnvironmentWorkspaceCommitOptions,
  type EnvironmentWorkspaceCommitResult,
  type EnvironmentWorkspaceCommitsOptions,
  type EnvironmentWorkspaceDiffOptions,
  type EnvironmentWorkspaceDiffResult,
  type EnvironmentWorkspaceStatusOptions,
  type EnvironmentWorkStatus,
  type EnvironmentSquashMergeOptions,
  type EnvironmentSquashMergeResult,
  type IEnvironment,
  type PromoteEnvironmentOptions,
  type PromoteEnvironmentResult,
} from "./contracts.js";
import {
  commitGitWorkspace,
  getGitWorkspaceDiffAsync,
  getGitWorkspaceStatusAsync,
  listGitWorkspaceCommitsSinceRefAsync,
  watchGitWorkspaceStatus,
} from "./git-workspace.js";
import {
  resolveEnvironmentAgentConnectionTarget,
} from "./environment-agent-target.js";
import {
  disposeManagedHostEnvironmentAgent,
  ensureManagedHostEnvironmentAgent,
} from "./host-environment-agent.js";
import { runCommandAsync, spawnCommand } from "./process.js";

export interface LocalGitWorkspaceState {
  workspaceRoot: string;
  branchName: string;
}

export interface CreateLocalGitWorkspaceOptions {
  worktreeRootName?: string;
  manageEnvironmentAgent?: boolean;
}

export function isLocalGitWorkspaceState(value: unknown): value is LocalGitWorkspaceState {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as LocalGitWorkspaceState).workspaceRoot === "string" &&
    typeof (value as LocalGitWorkspaceState).branchName === "string"
  );
}

async function listUnmergedPathsAtAsync(
  workspaceRoot: string,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const result = await runGitAtPathAsync(workspaceRoot, [
    "diff",
    "--name-only",
    "--diff-filter=U",
  ], env);
  if (!result.ok || !result.stdout) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const LOCAL_GIT_WORKSPACE_INFO: EnvironmentInfo = {
  id: "local",
  displayName: "Git Worktree Workspace",
  description:
    "Provision an isolated per-thread git worktree when the project is a git repository.",
  capabilities: {
    host_filesystem: true,
    isolated_workspace: true,
    promote_primary_checkout: true,
    demote_primary_checkout: true,
    squash_merge: true,
  },
};
const WORKTREE_AGENT_INSTRUCTIONS = renderTemplate("worktreeAgentInstructions", {});

async function runGitAtPathAsync(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runCommandAsync("git", args, {
    cwd,
    env,
  });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function hasLocalBranchAsync(
  projectRoot: string,
  branch: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  return (
    await runGitAtPathAsync(
      projectRoot,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      env,
    )
  ).ok;
}

async function resolveWorktreeStartRefAsync(
  projectRoot: string,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  if (await hasLocalBranchAsync(projectRoot, "main", env)) return "main";
  if (await hasLocalBranchAsync(projectRoot, "master", env)) return "master";
  const headBranch = await runGitAtPathAsync(
    projectRoot,
    ["symbolic-ref", "--short", "HEAD"],
    env,
  );
  return headBranch.ok && headBranch.stdout.length > 0 ? headBranch.stdout : undefined;
}

function toWorktreeBranchName(environmentId: string): string {
  const normalized = environmentId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `bb/env-${normalized.length > 0 ? normalized : "env"}`;
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

async function hasLocalWorkingChangesAsync(
  repoRoot: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const status = await runGitAtPathAsync(repoRoot, ["status", "--porcelain"], env);
  return status.ok && status.stdout.trim().length > 0;
}

async function resolveCheckoutSnapshotAsync(
  repoRoot: string,
  env: Record<string, string | undefined>,
): Promise<EnvironmentCheckoutSnapshot> {
  const headResult = await runGitAtPathAsync(repoRoot, ["rev-parse", "HEAD"], env);
  if (!headResult.ok || !headResult.stdout) {
    throw new Error("Failed to resolve HEAD");
  }

  const branchResult = await runGitAtPathAsync(
    repoRoot,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    env,
  );
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

async function checkoutSnapshotAsync(
  repoRoot: string,
  snapshot: EnvironmentCheckoutSnapshot,
  env: Record<string, string | undefined>,
): Promise<void> {
  const branch = snapshot.branch?.trim();
  if (
    branch &&
    (await runGitAtPathAsync(
      repoRoot,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      env,
    )).ok
  ) {
    const branchCheckout = await runGitAtPathAsync(
      repoRoot,
      ["checkout", "--ignore-other-worktrees", branch],
      env,
    );
    if (branchCheckout.ok) return;
  }

  const detachedCheckout = await runGitAtPathAsync(
    repoRoot,
    ["checkout", "--detach", snapshot.head],
    env,
  );
  if (!detachedCheckout.ok) {
    throw new Error(detachedCheckout.stderr || "Failed to checkout detached HEAD");
  }
}

async function resolveDefaultBranchAsync(
  repoRoot: string,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  const remoteHead = await runGitAtPathAsync(
    repoRoot,
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    env,
  );
  if (remoteHead.ok && remoteHead.stdout.startsWith("refs/remotes/origin/")) {
    return remoteHead.stdout.slice("refs/remotes/origin/".length);
  }
  if (await hasLocalBranchAsync(repoRoot, "main", env)) return "main";
  if (await hasLocalBranchAsync(repoRoot, "master", env)) return "master";
  return undefined;
}

class LocalGitWorkspaceEnvironment implements IEnvironment {
  readonly kind = "local";
  readonly info = { ...LOCAL_GIT_WORKSPACE_INFO };
  private readonly projectId: string;
  private readonly threadId: string;
  private readonly environmentId: string;
  private readonly rootPath: string;
  private readonly env: Record<string, string | undefined>;
  private readonly services: CreateEnvironmentContext["services"];
  private readonly reconnectTarget: CreateEnvironmentContext["managedEnvironmentAgentReconnectTarget"];
  private readonly manageEnvironmentAgent: boolean;
  private preparePromise: Promise<void> | null = null;
  private managedAgentTarget?: EnvironmentAgentConnectionTarget;

  constructor(
    projectId: string,
    threadId: string,
    private readonly projectRoot: string,
    private readonly state: LocalGitWorkspaceState,
    runtimeEnv: Record<string, string | undefined>,
    reconnectTarget?: CreateEnvironmentContext["managedEnvironmentAgentReconnectTarget"],
    services?: CreateEnvironmentContext["services"],
    manageEnvironmentAgent = true,
  ) {
    this.projectId = projectId;
    this.threadId = threadId;
    this.environmentId = runtimeEnv.BB_ENVIRONMENT_ID?.trim() || this.kind;
    this.rootPath = state.workspaceRoot;
    this.env = { ...runtimeEnv };
    this.reconnectTarget = reconnectTarget;
    this.services = services;
    this.manageEnvironmentAgent = manageEnvironmentAgent;
  }

  serialize(): LocalGitWorkspaceState {
    return { ...this.state };
  }

  async prepare(): Promise<void> {
    if (!existsSync(this.state.workspaceRoot)) {
      throw new Error(`Local git workspace is unavailable: ${this.state.workspaceRoot}`);
    }
    if (!this.manageEnvironmentAgent) {
      return;
    }
    if (this.preparePromise) {
      return this.preparePromise;
    }
    this.preparePromise = ensureManagedHostEnvironmentAgent({
      workspaceRootPath: this.state.workspaceRoot,
      threadId: this.threadId,
      projectId: this.projectId,
      environmentId: this.environmentId,
      runtimeEnv: this.env,
      reconnectTarget: this.reconnectTarget,
    }).then((managedAgentTarget) => {
      if (managedAgentTarget) {
        this.managedAgentTarget = managedAgentTarget;
      }
    }).finally(() => {
      this.preparePromise = null;
    });
    return this.preparePromise;
  }

  async suspend(): Promise<void> {
    this.managedAgentTarget = undefined;
    if (this.manageEnvironmentAgent) {
      await disposeManagedHostEnvironmentAgent({
        projectId: this.projectId,
        threadId: this.threadId,
        environmentId: this.environmentId,
        workspaceRootPath: this.rootPath,
        runtimeEnv: this.env,
      });
    }
  }

  async destroy(): Promise<void> {
    await this.suspend();
  }

  exists(): boolean {
    return existsSync(this.state.workspaceRoot);
  }

  supportsHostFilesystemAccess(): boolean {
    return true;
  }

  isIsolatedWorkspace(): boolean {
    return true;
  }

  getAgentConnectionTarget(): EnvironmentAgentConnectionTarget {
    if (!this.manageEnvironmentAgent && !this.env.BB_ENV_DAEMON_BASE_URL?.trim()) {
      throw new Error("Local git workspace environment-agent management is disabled");
    }
    const managedTarget = this.managedAgentTarget;
    if (!managedTarget && !this.env.BB_ENV_DAEMON_BASE_URL?.trim()) {
      throw new Error("Missing managed environment-agent target for local git workspace");
    }
    return resolveEnvironmentAgentConnectionTarget({
      runtimeEnv: this.env,
      defaultTarget:
        managedTarget ?? {
          transport: "http",
          baseUrl: "http://127.0.0.1:0",
        },
    });
  }

  getCheckoutSnapshot(): Promise<EnvironmentCheckoutSnapshot> {
    return resolveCheckoutSnapshotAsync(this.rootPath, this.env);
  }

  getWorkspaceRootUnsafe(): string {
    return this.rootPath;
  }

  isPrimaryWorkspace(projectRootPath: string): boolean {
    return resolve(this.rootPath) === resolve(projectRootPath);
  }

  isContainerBacked(): boolean {
    return false;
  }

  buildAgentInstructions(): string | undefined {
    return WORKTREE_AGENT_INSTRUCTIONS;
  }

  getWorkspaceStatus(args?: EnvironmentWorkspaceStatusOptions) {
    return getGitWorkspaceStatusAsync(this, args);
  }

  watchWorkspaceStatus(onChange: () => void): () => void {
    return watchGitWorkspaceStatus(this, onChange);
  }

  commitWorkspace(args: EnvironmentWorkspaceCommitOptions): Promise<EnvironmentWorkspaceCommitResult> {
    return commitGitWorkspace(
      this,
      args,
      this.services?.llmCompletion,
    );
  }

  listWorkspaceCommitsSinceRef(args: EnvironmentWorkspaceCommitsOptions) {
    return listGitWorkspaceCommitsSinceRefAsync(this, args);
  }

  getWorkspaceDiff(args: EnvironmentWorkspaceDiffOptions) {
    return getGitWorkspaceDiffAsync(this, args);
  }

  private _executionContext(): { cwd: string; env: Record<string, string | undefined> } {
    return {
      cwd: this.rootPath,
      env: { ...this.env },
    };
  }

  spawn(
    command: string,
    args: string[],
    options?: EnvironmentSpawnOptions,
  ) {
    const executionContext = this._executionContext();
    return spawnCommand(command, args, {
      cwd: options?.cwd ?? executionContext.cwd,
      env: {
        ...executionContext.env,
        ...(options?.env ?? {}),
      },
      stdio: options?.stdio,
    });
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

  async promoteToActiveWorkspace(
    args: PromoteEnvironmentOptions,
  ): Promise<PromoteEnvironmentResult> {
    if (await hasLocalWorkingChangesAsync(args.activeWorkspaceRoot, this.env)) {
      throw new Error(
        "Primary checkout has local changes. Commit, stash, or discard changes before promoting a thread.",
      );
    }
    if (await hasLocalWorkingChangesAsync(this.rootPath, this.env)) {
      throw new Error(
        "Thread worktree has local changes. Commit, stash, or discard changes before promoting a thread.",
      );
    }

    const previousCheckout = await resolveCheckoutSnapshotAsync(
      args.activeWorkspaceRoot,
      this.env,
    );
    const promotedCheckout = await resolveCheckoutSnapshotAsync(this.rootPath, this.env);

    try {
      await checkoutSnapshotAsync(args.activeWorkspaceRoot, promotedCheckout, this.env);
      return {
        previousCheckout,
        promotedCheckout,
      };
    } catch (err) {
      try {
        await checkoutSnapshotAsync(args.activeWorkspaceRoot, previousCheckout, this.env);
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

  async demoteFromActiveWorkspace(
    args: DemoteEnvironmentOptions,
  ): Promise<DemoteEnvironmentResult> {
    const reset = await runGitAtPathAsync(args.activeWorkspaceRoot, ["reset", "--hard"], this.env);
    if (!reset.ok) {
      throw new Error(reset.stderr || "Failed to reset primary checkout");
    }
    const clean = await runGitAtPathAsync(args.activeWorkspaceRoot, ["clean", "-fd"], this.env);
    if (!clean.ok) {
      throw new Error(clean.stderr || "Failed to clean primary checkout");
    }
    await checkoutSnapshotAsync(args.activeWorkspaceRoot, args.snapshot, this.env);
    return {
      restoredCheckout: args.snapshot,
    };
  }

  async squashMergeIntoDefaultBranch(
    args: EnvironmentSquashMergeOptions,
  ): Promise<EnvironmentSquashMergeResult> {
    const mergeBaseBranch =
      args.defaultBranch ?? await resolveDefaultBranchAsync(args.activeWorkspaceRoot, this.env);
    if (!mergeBaseBranch) {
      throw new Error("Could not determine merge base branch");
    }
    const statusResult = await this.run("git", ["status", "--porcelain"]);
    if (statusResult.exitCode !== 0) {
      throw new Error(statusResult.stderr || "Failed to inspect worktree status");
    }
    let committed = false;
    let prepCommit:
      | {
          message: string;
          commitSha?: string;
          commitSubject?: string;
          includeUnstaged?: boolean;
        }
      | undefined;
    if (statusResult.stdout.trim().length > 0) {
      if (args.commitIfNeeded !== true) {
        throw new Error("Workspace has uncommitted changes; commit first");
      }
      let commitResult;
      try {
        commitResult = await this.commitWorkspace({
          defaultBranch: mergeBaseBranch,
          message: args.commitMessage?.trim(),
          includeUnstaged: args.includeUnstaged,
        });
      } catch (error) {
        throw new EnvironmentSquashMergeCommitFailureError(
          "prep_commit",
          error instanceof Error ? error.message : String(error),
        );
      }
      committed = commitResult.commitCreated;
      if (commitResult.commitCreated) {
        prepCommit = {
          message: commitResult.message,
          ...(commitResult.commitSha ? { commitSha: commitResult.commitSha } : {}),
          ...(commitResult.commitSubject ? { commitSubject: commitResult.commitSubject } : {}),
          ...(commitResult.includeUnstaged !== undefined
            ? { includeUnstaged: commitResult.includeUnstaged }
            : {}),
        };
      }
    }
    if (await hasLocalWorkingChangesAsync(args.activeWorkspaceRoot, this.env)) {
      throw new Error(
        "Project root has local changes that could be lost; commit or stash them before squash merge",
      );
    }

    const workspaceHead = await this.run("git", ["rev-parse", "HEAD"]);
    if (workspaceHead.exitCode !== 0 || !workspaceHead.stdout) {
      throw new Error("Failed to resolve worktree HEAD");
    }

    const currentProjectBranch = await runGitAtPathAsync(
      args.activeWorkspaceRoot,
      ["symbolic-ref", "--short", "HEAD"],
      this.env,
    );
    const defaultHead = await runGitAtPathAsync(
      args.activeWorkspaceRoot,
      ["rev-parse", mergeBaseBranch],
      this.env,
    );
    if (!defaultHead.ok || !defaultHead.stdout) {
      throw new Error(`Failed to resolve ${mergeBaseBranch}`);
    }

    const aheadResult = await this.run("git", [
      "rev-list",
      "--left-right",
      "--count",
      `${mergeBaseBranch}...HEAD`,
    ]);
      if (aheadResult.exitCode === 0) {
        const [, aheadRaw] = aheadResult.stdout.split("\t");
        const aheadCount = Number.parseInt(aheadRaw ?? "0", 10);
        if (!Number.isNaN(aheadCount) && aheadCount <= 0) {
          return { merged: false, message: "No commits to merge", committed };
        }
      }

    const tempRoot = await mkdtemp(join(tmpdir(), "bb-squash-merge-"));
    const tempWorkspaceRoot = resolve(tempRoot, "integration");

    try {
      const addWorktree = await runGitAtPathAsync(args.activeWorkspaceRoot, [
        "worktree",
        "add",
        "--detach",
        tempWorkspaceRoot,
        defaultHead.stdout,
      ], this.env);
      if (!addWorktree.ok) {
        throw new Error(addWorktree.stderr || "Failed to prepare integration worktree");
      }

      const squashResult = await runGitAtPathAsync(tempWorkspaceRoot, [
        "merge",
        "--squash",
        workspaceHead.stdout,
      ], this.env);
      if (!squashResult.ok) {
        const conflictFiles = await runGitAtPathAsync(tempWorkspaceRoot, [
          "diff",
          "--name-only",
          "--diff-filter=U",
        ], this.env);
        await runGitAtPathAsync(tempWorkspaceRoot, ["reset", "--hard"], this.env);
        return {
          merged: false,
          message:
            `Squash merge has conflicts against ${mergeBaseBranch}. Rebase/merge ${mergeBaseBranch} into the worktree, resolve conflicts, and retry.`,
          committed,
          ...(prepCommit ? { prepCommit } : {}),
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

      const hasSquashedChanges = await runGitAtPathAsync(tempWorkspaceRoot, [
        "diff",
        "--cached",
        "--quiet",
      ], this.env);
      if (hasSquashedChanges.ok) {
        return {
          merged: false,
          message: "No changes to merge after squash",
          committed,
          ...(prepCommit ? { prepCommit } : {}),
        };
      }

      const unmergedPathsBeforeMessage = await listUnmergedPathsAtAsync(tempWorkspaceRoot, this.env);
      if (unmergedPathsBeforeMessage.length > 0) {
        throw new EnvironmentSquashMergeCommitFailureError(
          "squash_commit",
          `Squash merge has unresolved conflicts: ${unmergedPathsBeforeMessage.join(", ")}`,
        );
      }

      const sourceBranch = await runGitAtPathAsync(
        this.rootPath,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        this.env,
      );
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
      const unmergedPathsBeforeCommit = await listUnmergedPathsAtAsync(tempWorkspaceRoot, this.env);
      if (unmergedPathsBeforeCommit.length > 0) {
        throw new EnvironmentSquashMergeCommitFailureError(
          "squash_commit",
          `Squash merge has unresolved conflicts: ${unmergedPathsBeforeCommit.join(", ")}`,
        );
      }
      const commitResult = await runGitAtPathAsync(tempWorkspaceRoot, [
        "commit",
        "--no-verify",
        "-m",
        finalMessage,
      ], this.env);
      if (!commitResult.ok) {
        throw new EnvironmentSquashMergeCommitFailureError(
          "squash_commit",
          commitResult.stderr || "Failed to commit squashed merge",
        );
      }

      const mergedHead = await runGitAtPathAsync(tempWorkspaceRoot, ["rev-parse", "HEAD"], this.env);
      if (!mergedHead.ok || !mergedHead.stdout) {
        throw new Error("Failed to resolve squashed merge commit");
      }

      if (currentProjectBranch.ok && currentProjectBranch.stdout === mergeBaseBranch) {
        const resetResult = await runGitAtPathAsync(args.activeWorkspaceRoot, [
          "reset",
          "--hard",
          mergedHead.stdout,
        ], this.env);
        if (!resetResult.ok) {
          throw new Error(
            resetResult.stderr || `Squash merged into ${mergeBaseBranch}, but failed to refresh checkout`,
          );
        }
      } else {
        const updateRef = await runGitAtPathAsync(args.activeWorkspaceRoot, [
          "update-ref",
          `refs/heads/${mergeBaseBranch}`,
          mergedHead.stdout,
          defaultHead.stdout,
        ], this.env);
        if (!updateRef.ok) {
          throw new Error(
            updateRef.stderr || `${mergeBaseBranch} moved during squash merge; please retry`,
          );
        }
      }

      const commitSubject = finalMessage.split("\n")[0]?.trim();

      return {
        merged: true,
        message: `Squash-merged into ${mergeBaseBranch}`,
        committed,
        commitSha: mergedHead.stdout.trim(),
        ...(commitSubject ? { commitSubject } : {}),
        ...(prepCommit ? { prepCommit } : {}),
      };
    } finally {
      await runGitAtPathAsync(args.activeWorkspaceRoot, [
        "worktree",
        "remove",
        "--force",
        tempWorkspaceRoot,
      ], this.env);
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  run(
    command: string,
    args: string[],
    options?: EnvironmentCommandOptions,
  ) {
    const executionContext = this._executionContext();
    return runCommandAsync(command, args, {
      cwd: options?.cwd ?? executionContext.cwd,
      env: {
        ...executionContext.env,
        ...(options?.env ?? {}),
      },
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.rawOutput ? { rawOutput: true } : {}),
      ...(options?.onStdoutLine ? { onStdoutLine: options.onStdoutLine } : {}),
      ...(options?.onStderrLine ? { onStderrLine: options.onStderrLine } : {}),
    });
  }
}

export function createLocalGitWorkspaceDefinition(
  opts?: CreateLocalGitWorkspaceOptions,
): EnvironmentDefinition<LocalGitWorkspaceState> {
  const manageEnvironmentAgent = opts?.manageEnvironmentAgent ?? true;

  return {
    kind: "local",
    info: { ...LOCAL_GIT_WORKSPACE_INFO },
    create(context: CreateEnvironmentContext): IEnvironment {
      const projectRoot = context.projectRootPath;
      if (!existsSync(join(projectRoot, ".git"))) {
        throw new Error("Worktree provisioning requires a git repository at the project root");
      }

      return new LocalGitWorkspaceEnvironment(
        context.projectId,
        context.threadId,
        projectRoot,
        resolveLocalGitWorkspaceState({
          projectId: context.projectId,
          threadId: context.threadId,
          environmentId: context.environmentId,
          projectRootPath: context.projectRootPath,
          runtimeEnv: context.runtimeEnv,
          ...(opts?.worktreeRootName ? { worktreeRootName: opts.worktreeRootName } : {}),
        }),
        context.runtimeEnv,
        context.managedEnvironmentAgentReconnectTarget,
        context.services,
        manageEnvironmentAgent,
      );
    },
    restore(state: LocalGitWorkspaceState, context: CreateEnvironmentContext): IEnvironment {
      if (!existsSync(state.workspaceRoot)) {
        throw new Error(`Worktree workspace is unavailable: ${state.workspaceRoot}`);
      }
      return new LocalGitWorkspaceEnvironment(
        context.projectId,
        context.threadId,
        context.projectRootPath,
        state,
        context.runtimeEnv,
        context.managedEnvironmentAgentReconnectTarget,
        context.services,
        manageEnvironmentAgent,
      );
    },
    isState: isLocalGitWorkspaceState,
  };
}

export function resolveLocalGitWorkspaceState(args: {
  projectId: string;
  threadId: string;
  environmentId?: string;
  projectRootPath: string;
  runtimeEnv: Record<string, string | undefined>;
  worktreeRootName?: string;
}): LocalGitWorkspaceState {
  const configuredWorktreeRootName =
    args.worktreeRootName ?? args.runtimeEnv.BB_WORKTREE_ROOT?.trim();
  const worktreeRootName = configuredWorktreeRootName?.trim().length
    ? configuredWorktreeRootName
    : resolveBbPath(args.runtimeEnv, "worktrees");
  const { root: configuredWorktreeRoot, isGlobalRoot } =
    resolveConfiguredWorktreeRoot(args.projectRootPath, worktreeRootName);
  const worktreeRoot = isGlobalRoot
    ? resolve(configuredWorktreeRoot, args.projectId)
    : configuredWorktreeRoot;
  const worktreeId = args.environmentId ?? args.threadId;
  return {
    workspaceRoot: resolve(worktreeRoot, worktreeId),
    branchName: toWorktreeBranchName(worktreeId),
  };
}

export async function ensureLocalGitWorkspace(args: {
  projectRootPath: string;
  state: LocalGitWorkspaceState;
  runtimeEnv: Record<string, string | undefined>;
}): Promise<boolean> {
  if (existsSync(args.state.workspaceRoot)) {
    return false;
  }
  mkdirSync(dirname(args.state.workspaceRoot), {
    recursive: true,
  });
  const startRef = await resolveWorktreeStartRefAsync(args.projectRootPath, args.runtimeEnv);
  const branchExists = await hasLocalBranchAsync(
    args.projectRootPath,
    args.state.branchName,
    args.runtimeEnv,
  );
  const branchAddArgs = branchExists
    ? ["worktree", "add", args.state.workspaceRoot, args.state.branchName]
    : [
        "worktree",
        "add",
        "-b",
        args.state.branchName,
        args.state.workspaceRoot,
        ...(startRef ? [startRef] : []),
      ];
  const branchAddResult = await runGitAtPathAsync(
    args.projectRootPath,
    branchAddArgs,
    args.runtimeEnv,
  );
  const addResult = branchAddResult.ok
    ? branchAddResult
    : await runGitAtPathAsync(
        args.projectRootPath,
        ["worktree", "add", "--detach", args.state.workspaceRoot],
        args.runtimeEnv,
      );
  if (!addResult.ok) {
    throw new Error(
      `Failed to create worktree: ${addResult.stderr || addResult.stdout || "unknown error"}`,
    );
  }
  return true;
}

export async function removeLocalGitWorkspace(args: {
  projectRootPath: string;
  workspaceRoot: string;
  runtimeEnv: Record<string, string | undefined>;
}): Promise<void> {
  if (!existsSync(args.workspaceRoot)) {
    return;
  }
  await runGitAtPathAsync(
    args.projectRootPath,
    ["worktree", "remove", "--force", args.workspaceRoot],
    args.runtimeEnv,
  );
  await rm(args.workspaceRoot, { recursive: true, force: true });
}
