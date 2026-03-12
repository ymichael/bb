import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { expandHomeDirectory, resolveBeanbagPath } from "@beanbag/agent-core/storage-paths";
import type { EnvironmentAgentConnectionTarget } from "@beanbag/environment-agent";
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

export interface WorktreeEnvironmentState {
  workspaceRoot: string;
  branchName: string;
}

export interface CreateWorktreeEnvironmentDefinitionOptions {
  worktreeRootName?: string;
  manageEnvironmentAgent?: boolean;
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

const WORKTREE_ENVIRONMENT_INFO: EnvironmentInfo = {
  id: "worktree",
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
const WORKTREE_AGENT_INSTRUCTIONS = [
  "[Beanbag worktree environment]",
  "- You are working in an isolated per-thread git worktree on a dedicated branch.",
  "- Commit meaningful work before reporting completion so changes are not stranded in the worktree.",
  "- Use the primary checkout only for manual verification when needed, then demote back to the thread worktree.",
].join("\n");

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

function toWorktreeBranchName(threadId: string): string {
  const normalized = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `bb/thread-${normalized.length > 0 ? normalized : "thread"}`;
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

function resolveDefaultBranch(repoRoot: string): string | undefined {
  return undefined;
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

class WorktreeEnvironment implements IEnvironment {
  readonly kind = "worktree";
  readonly info = { ...WORKTREE_ENVIRONMENT_INFO };
  private readonly projectId: string;
  private readonly threadId: string;
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
    private readonly state: WorktreeEnvironmentState,
    runtimeEnv: Record<string, string | undefined>,
    reconnectTarget?: CreateEnvironmentContext["managedEnvironmentAgentReconnectTarget"],
    services?: CreateEnvironmentContext["services"],
    manageEnvironmentAgent = true,
  ) {
    this.projectId = projectId;
    this.threadId = threadId;
    this.rootPath = state.workspaceRoot;
    this.env = { ...runtimeEnv };
    this.reconnectTarget = reconnectTarget;
    this.services = services;
    this.manageEnvironmentAgent = manageEnvironmentAgent;
  }

  serialize(): WorktreeEnvironmentState {
    return { ...this.state };
  }

  async prepare(): Promise<void> {
    if (existsSync(this.state.workspaceRoot)) {
      if (this.manageEnvironmentAgent) {
        const managedAgentTarget = await ensureManagedHostEnvironmentAgent({
          workspaceRootPath: this.state.workspaceRoot,
          threadId: this.threadId,
          projectId: this.projectId,
          environmentId: this.kind,
          runtimeEnv: this.env,
          reconnectTarget: this.reconnectTarget,
        });
        if (managedAgentTarget) {
          this.managedAgentTarget = managedAgentTarget;
        }
      }
      return;
    }
    if (this.preparePromise) {
      return this.preparePromise;
    }

    this.preparePromise = this._prepareWorkspace().finally(() => {
      this.preparePromise = null;
    });
    return this.preparePromise;
  }

  private async _prepareWorkspace(): Promise<void> {
    if (existsSync(this.state.workspaceRoot)) {
      return;
    }

    const startRef = await resolveWorktreeStartRefAsync(this.projectRoot, this.env);
    const branchExists = await hasLocalBranchAsync(
      this.projectRoot,
      this.state.branchName,
      this.env,
    );
    const branchAddArgs = branchExists
      ? ["worktree", "add", this.state.workspaceRoot, this.state.branchName]
      : [
          "worktree",
          "add",
          "-b",
          this.state.branchName,
          this.state.workspaceRoot,
          ...(startRef ? [startRef] : []),
        ];
    const branchAddResult = await runGitAtPathAsync(
      this.projectRoot,
      branchAddArgs,
      this.env,
    );
    const addResult = branchAddResult.ok
      ? branchAddResult
      : await runGitAtPathAsync(
          this.projectRoot,
          ["worktree", "add", "--detach", this.state.workspaceRoot],
          this.env,
        );
    if (!addResult.ok) {
      throw new Error(
        `Failed to create worktree: ${addResult.stderr || addResult.stdout || "unknown error"}`,
      );
    }

    if (this.manageEnvironmentAgent) {
      const managedAgentTarget = await ensureManagedHostEnvironmentAgent({
        workspaceRootPath: this.state.workspaceRoot,
        threadId: this.threadId,
        projectId: this.projectId,
        environmentId: this.kind,
        runtimeEnv: this.env,
        reconnectTarget: this.reconnectTarget,
      });
      if (managedAgentTarget) {
        this.managedAgentTarget = managedAgentTarget;
      }
    }
  }

  async suspend(): Promise<void> {
    this.managedAgentTarget = undefined;
    if (this.manageEnvironmentAgent) {
      await disposeManagedHostEnvironmentAgent({
        projectId: this.projectId,
        threadId: this.threadId,
        environmentId: this.kind,
        workspaceRootPath: this.rootPath,
        runtimeEnv: this.env,
      });
    }
  }

  async destroy(): Promise<void> {
    await this.suspend();
    await runGitAtPathAsync(
      this.projectRoot,
      ["worktree", "remove", "--force", this.state.workspaceRoot],
      this.env,
    );
    await rm(this.state.workspaceRoot, { recursive: true, force: true });
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
    if (!this.manageEnvironmentAgent && !this.env.BEANBAG_ENVIRONMENT_AGENT_BASE_URL?.trim()) {
      throw new Error("Worktree environment-agent management is disabled");
    }
    const managedTarget = this.managedAgentTarget;
    if (!managedTarget && !this.env.BEANBAG_ENVIRONMENT_AGENT_BASE_URL?.trim()) {
      throw new Error("Missing managed environment-agent target for worktree environment");
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

  getCheckoutSnapshot(): EnvironmentCheckoutSnapshot {
    throw new Error("Synchronous checkout snapshot is unsupported; use getCheckoutSnapshotAsync");
  }

  getCheckoutSnapshotAsync(): Promise<EnvironmentCheckoutSnapshot> {
    return resolveCheckoutSnapshotAsync(this.rootPath, this.env);
  }

  getWorkspaceRootUnsafe(): string {
    return this.rootPath;
  }

  buildAgentInstructions(): string | undefined {
    return WORKTREE_AGENT_INSTRUCTIONS;
  }

  getWorkspaceStatus(_args?: EnvironmentWorkspaceStatusOptions): EnvironmentWorkStatus {
    throw new Error("Synchronous workspace status is unsupported; use getWorkspaceStatusAsync");
  }

  getWorkspaceStatusAsync(args?: EnvironmentWorkspaceStatusOptions) {
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

  listWorkspaceCommitsSinceRef(_args: EnvironmentWorkspaceCommitsOptions): EnvironmentCommitSummary[] {
    throw new Error(
      "Synchronous workspace commit listing is unsupported; use listWorkspaceCommitsSinceRefAsync",
    );
  }

  listWorkspaceCommitsSinceRefAsync(args: EnvironmentWorkspaceCommitsOptions) {
    return listGitWorkspaceCommitsSinceRefAsync(this, args);
  }

  getWorkspaceDiff(_args: EnvironmentWorkspaceDiffOptions): EnvironmentWorkspaceDiffResult {
    throw new Error("Synchronous workspace diff is unsupported; use getWorkspaceDiffAsync");
  }

  getWorkspaceDiffAsync(args: EnvironmentWorkspaceDiffOptions) {
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
    throw new Error("Synchronous promotion is unsupported; use promoteToActiveWorkspaceAsync");
  }

  async promoteToActiveWorkspaceAsync(
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

  demoteFromActiveWorkspace(args: DemoteEnvironmentOptions): DemoteEnvironmentResult {
    throw new Error("Synchronous demotion is unsupported; use demoteFromActiveWorkspaceAsync");
  }

  async demoteFromActiveWorkspaceAsync(
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
    const statusResult = await this.runAsync("git", ["status", "--porcelain"]);
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

    const workspaceHead = await this.runAsync("git", ["rev-parse", "HEAD"]);
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

    const aheadResult = await this.runAsync("git", [
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

    const tempRoot = await mkdtemp(join(tmpdir(), "beanbag-squash-merge-"));
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
    _command: string,
    _args: string[],
    _options?: EnvironmentCommandOptions,
  ): EnvironmentCommandResult {
    throw new Error("Synchronous process execution is unsupported; use runAsync");
  }

  runAsync(
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

export function createWorktreeEnvironmentDefinition(
  opts?: CreateWorktreeEnvironmentDefinitionOptions,
): EnvironmentDefinition<WorktreeEnvironmentState> {
  const configuredWorktreeRootName =
    opts?.worktreeRootName ?? process.env.BEANBAG_WORKTREE_ROOT?.trim();
  const worktreeRootName = configuredWorktreeRootName?.trim().length
    ? configuredWorktreeRootName
    : resolveBeanbagPath(process.env, "worktrees");
  const manageEnvironmentAgent = opts?.manageEnvironmentAgent ?? true;

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

      return new WorktreeEnvironment(
        context.projectId,
        context.threadId,
        projectRoot,
        {
          workspaceRoot,
          branchName,
        },
        context.runtimeEnv,
        context.managedEnvironmentAgentReconnectTarget,
        context.services,
        manageEnvironmentAgent,
      );
    },
    restore(state: WorktreeEnvironmentState, context: CreateEnvironmentContext): IEnvironment {
      if (!existsSync(state.workspaceRoot)) {
        throw new Error(`Worktree workspace is unavailable: ${state.workspaceRoot}`);
      }
      return new WorktreeEnvironment(
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
