import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { EnvironmentAgentConnectionTarget } from "@beanbag/environment-agent";
import type {
  CreateEnvironmentContext,
  DemoteEnvironmentOptions,
  DemoteEnvironmentResult,
  EnvironmentCommandOptions,
  EnvironmentSpawnOptions,
  EnvironmentDefinition,
  EnvironmentCheckoutSnapshot,
  EnvironmentInfo,
  EnvironmentWorkspaceCommitOptions,
  EnvironmentWorkspaceCommitResult,
  EnvironmentWorkspaceCommitsOptions,
  EnvironmentWorkspaceDiffOptions,
  EnvironmentWorkspaceDiffResult,
  EnvironmentWorkspaceStatusOptions,
  EnvironmentSquashMergeOptions,
  EnvironmentSquashMergeResult,
  IEnvironment,
  PromoteEnvironmentOptions,
  PromoteEnvironmentResult,
} from "./contracts.js";
import {
  commitGitWorkspace,
  getGitWorkspaceDiff,
  getGitWorkspaceStatus,
  listGitWorkspaceCommitsSinceRef,
  watchGitWorkspaceStatus,
} from "./git-workspace.js";
import {
  resolveEnvironmentAgentConnectionTarget,
} from "./environment-agent-target.js";
import {
  disposeManagedHostEnvironmentAgent,
  ensureManagedHostEnvironmentAgent,
  resolveManagedHostEnvironmentAgentTarget,
} from "./host-environment-agent.js";
import { runCommand, runCommandAsync, spawnCommand } from "./process.js";

export interface WorktreeEnvironmentState {
  workspaceRoot: string;
  branchName: string;
}

export interface CreateWorktreeEnvironmentDefinitionOptions {
  worktreeRootName?: string;
  manageEnvironmentAgent?: boolean;
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
const DEFAULT_WORKTREE_ROOT = "~/.beanbag/worktrees";
const WORKTREE_AGENT_INSTRUCTIONS = [
  "[Beanbag worktree environment]",
  "- You are working in an isolated per-thread git worktree on a dedicated branch.",
  "- Commit meaningful work before reporting completion so changes are not stranded in the worktree.",
  "- Use the primary checkout only for manual verification when needed, then demote back to the thread worktree.",
].join("\n");

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

function hasLocalBranch(projectRoot: string, branch: string): boolean {
  return runGitAtPath(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
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
  private readonly projectId: string;
  private readonly threadId: string;
  private readonly rootPath: string;
  private readonly env: Record<string, string | undefined>;
  private readonly services: CreateEnvironmentContext["services"];
  private readonly manageEnvironmentAgent: boolean;
  private preparePromise: Promise<void> | null = null;

  constructor(
    projectId: string,
    threadId: string,
    private readonly projectRoot: string,
    private readonly state: WorktreeEnvironmentState,
    runtimeEnv: Record<string, string | undefined>,
    services?: CreateEnvironmentContext["services"],
    manageEnvironmentAgent = true,
  ) {
    this.projectId = projectId;
    this.threadId = threadId;
    this.rootPath = state.workspaceRoot;
    this.env = { ...runtimeEnv };
    this.services = services;
    this.manageEnvironmentAgent = manageEnvironmentAgent;
  }

  serialize(): WorktreeEnvironmentState {
    return { ...this.state };
  }

  async prepare(): Promise<void> {
    if (existsSync(this.state.workspaceRoot)) {
      if (this.manageEnvironmentAgent) {
        await ensureManagedHostEnvironmentAgent({
          workspaceRootPath: this.state.workspaceRoot,
          threadId: this.threadId,
          projectId: this.projectId,
          environmentId: this.kind,
          runtimeEnv: this.env,
        });
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
      await ensureManagedHostEnvironmentAgent({
        workspaceRootPath: this.state.workspaceRoot,
        threadId: this.threadId,
        projectId: this.projectId,
        environmentId: this.kind,
        runtimeEnv: this.env,
      });
    }
  }

  async dispose(): Promise<void> {
    if (this.manageEnvironmentAgent) {
      await disposeManagedHostEnvironmentAgent({
        projectId: this.projectId,
        threadId: this.threadId,
        environmentId: this.kind,
        runtimeEnv: this.env,
      });
    }
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
    const managedTarget = resolveManagedHostEnvironmentAgentTarget({
      projectId: this.projectId,
      threadId: this.threadId,
      environmentId: this.kind,
      runtimeEnv: this.env,
    });
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
    return resolveCheckoutSnapshot(this.rootPath);
  }

  getWorkspaceRootUnsafe(): string {
    return this.rootPath;
  }

  buildAgentInstructions(): string | undefined {
    return WORKTREE_AGENT_INSTRUCTIONS;
  }

  getWorkspaceStatus(args?: EnvironmentWorkspaceStatusOptions) {
    return getGitWorkspaceStatus(this, args);
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
    return listGitWorkspaceCommitsSinceRef(this, args);
  }

  getWorkspaceDiff(args: EnvironmentWorkspaceDiffOptions): EnvironmentWorkspaceDiffResult {
    return getGitWorkspaceDiff(this, args);
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
    let committed = false;
    let prepCommit:
      | {
          message: string;
          commitSha?: string;
          includeUnstaged?: boolean;
        }
      | undefined;
    if (statusResult.stdout.trim().length > 0) {
      if (args.commitIfNeeded !== true) {
        throw new Error("Workspace has uncommitted changes; commit first");
      }
      const commitResult = await this.commitWorkspace({
        defaultBranch: mergeBaseBranch,
        message: args.commitMessage?.trim(),
        includeUnstaged: args.includeUnstaged,
      });
      committed = commitResult.commitCreated;
      if (commitResult.commitCreated) {
        prepCommit = {
          message: commitResult.message,
          ...(commitResult.commitSha ? { commitSha: commitResult.commitSha } : {}),
          ...(commitResult.includeUnstaged !== undefined
            ? { includeUnstaged: commitResult.includeUnstaged }
            : {}),
        };
      }
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
          return { merged: false, message: "No commits to merge", committed };
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

      const hasSquashedChanges = runGitAtPath(tempWorkspaceRoot, [
        "diff",
        "--cached",
        "--quiet",
      ]);
      if (hasSquashedChanges.ok) {
        return {
          merged: false,
          message: "No changes to merge after squash",
          committed,
          ...(prepCommit ? { prepCommit } : {}),
        };
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
      } else {
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
      }

      return {
        merged: true,
        message: `Squash-merged into ${mergeBaseBranch}`,
        committed,
        ...(prepCommit ? { prepCommit } : {}),
      };
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
    const executionContext = this._executionContext();
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
  const worktreeRootName =
    opts?.worktreeRootName ??
    process.env.BEANBAG_WORKTREE_ROOT ??
    DEFAULT_WORKTREE_ROOT;
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
