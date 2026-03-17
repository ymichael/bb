import { existsSync } from "node:fs";
import type { EnvironmentAgentConnectionTarget } from "@bb/environment-daemon";
import type {
  CreateEnvironmentContext,
  DemoteEnvironmentOptions,
  DemoteEnvironmentResult,
  EnvironmentCommandOptions,
  EnvironmentCommandResult,
  EnvironmentSpawnOptions,
  EnvironmentDefinition,
  EnvironmentCheckoutSnapshot,
  EnvironmentCommitSummary,
  EnvironmentInfo,
  EnvironmentWorkspaceCommitOptions,
  EnvironmentWorkspaceCommitResult,
  EnvironmentWorkspaceCommitsOptions,
  EnvironmentWorkspaceDiffOptions,
  EnvironmentWorkspaceDiffResult,
  EnvironmentWorkspaceStatusOptions,
  EnvironmentWorkStatus,
  EnvironmentSquashMergeOptions,
  EnvironmentSquashMergeResult,
  IEnvironment,
  PromoteEnvironmentOptions,
  PromoteEnvironmentResult,
} from "./contracts.js";
import type {
  CreateLocalGitWorkspaceOptions,
  LocalGitWorkspaceState,
} from "./local-git-workspace.js";
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
import { createLocalGitWorkspaceDefinition } from "./local-git-workspace.js";

interface LocalEnvironmentState {
  workspaceRoot?: string;
  branchName?: string;
}

export interface CreateLocalEnvironmentDefinitionOptions {
  worktree?: CreateLocalGitWorkspaceOptions;
}

const LOCAL_ENVIRONMENT_INFO: EnvironmentInfo = {
  id: "local",
  displayName: "Direct Workspace",
  description: "Run directly in the project root on the host machine.",
  capabilities: {
    host_filesystem: true,
    isolated_workspace: false,
    promote_primary_checkout: false,
    demote_primary_checkout: false,
    squash_merge: false,
  },
};

class LocalEnvironment implements IEnvironment {
  readonly kind = "local";
  readonly info = { ...LOCAL_ENVIRONMENT_INFO };
  private readonly projectId: string;
  private readonly threadId: string;
  private readonly environmentId: string;
  private readonly rootPath: string;
  private readonly env: Record<string, string | undefined>;
  private readonly services: CreateEnvironmentContext["services"];
  private readonly reconnectTarget: CreateEnvironmentContext["managedEnvironmentAgentReconnectTarget"];
  private managedAgentTarget?: EnvironmentAgentConnectionTarget;

  constructor(context: CreateEnvironmentContext) {
    this.projectId = context.projectId;
    this.threadId = context.threadId;
    this.environmentId = context.environmentId ?? this.kind;
    this.rootPath = context.workspaceRootPath ?? context.projectRootPath;
    this.env = { ...context.runtimeEnv };
    this.services = context.services;
    this.reconnectTarget = context.managedEnvironmentAgentReconnectTarget;
  }

  serialize(): LocalEnvironmentState {
    return {};
  }

  async prepare(): Promise<void> {
    const managedAgentTarget = await ensureManagedHostEnvironmentAgent({
      workspaceRootPath: this.rootPath,
      threadId: this.threadId,
      projectId: this.projectId,
      environmentId: this.environmentId,
      runtimeEnv: this.env,
      reconnectTarget: this.reconnectTarget,
    });
    if (managedAgentTarget) {
      this.managedAgentTarget = managedAgentTarget;
    }
  }

  async suspend(): Promise<void> {
    this.managedAgentTarget = undefined;
    await disposeManagedHostEnvironmentAgent({
      projectId: this.projectId,
      threadId: this.threadId,
      environmentId: this.environmentId,
      workspaceRootPath: this.rootPath,
      runtimeEnv: this.env,
    });
  }

  async destroy(): Promise<void> {
    await this.suspend();
  }

  exists(): boolean {
    return existsSync(this.rootPath);
  }

  supportsHostFilesystemAccess(): boolean {
    return true;
  }

  isIsolatedWorkspace(): boolean {
    return false;
  }

  getAgentConnectionTarget(): EnvironmentAgentConnectionTarget {
    const managedTarget = this.managedAgentTarget;
    if (!managedTarget && !this.env.BB_ENV_DAEMON_BASE_URL?.trim()) {
      throw new Error("Missing managed environment-agent target for local environment");
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

  async getCheckoutSnapshot(): Promise<EnvironmentCheckoutSnapshot> {
    const headResult = await this.run("git", ["rev-parse", "HEAD"]);
    if (headResult.exitCode !== 0 || !headResult.stdout) {
      throw new Error("Failed to resolve HEAD");
    }

    const branchResult = await this.run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branchResult.exitCode === 0 && branchResult.stdout) {
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

  getWorkspaceRootUnsafe(): string {
    return this.rootPath;
  }

  isPrimaryWorkspace(projectRootPath: string): boolean {
    return this.rootPath === projectRootPath;
  }

  isContainerBacked(): boolean {
    return false;
  }

  buildAgentInstructions(): string | undefined {
    return undefined;
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
    return false;
  }

  supportsDemoteFromActiveWorkspace(): boolean {
    return false;
  }

  supportsSquashMergeIntoDefaultBranch(): boolean {
    return false;
  }

  async promoteToActiveWorkspace(_args: PromoteEnvironmentOptions): Promise<PromoteEnvironmentResult> {
    throw new Error("Promotion is not supported for local environments");
  }

  async demoteFromActiveWorkspace(_args: DemoteEnvironmentOptions): Promise<DemoteEnvironmentResult> {
    throw new Error("Demotion is not supported for local environments");
  }

  async squashMergeIntoDefaultBranch(
    _args: EnvironmentSquashMergeOptions,
  ): Promise<EnvironmentSquashMergeResult> {
    throw new Error("Squash merge is not supported for local environments");
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

function isLocalGitWorkspaceState(value: LocalEnvironmentState): value is LocalGitWorkspaceState {
  return typeof value.workspaceRoot === "string" && typeof value.branchName === "string";
}

function shouldUseWorktreeRuntime(context: CreateEnvironmentContext): boolean {
  return (
    context.environmentProperties?.location === "localhost" &&
    context.environmentProperties?.workspaceKind === "worktree"
  );
}

export function createLocalEnvironmentDefinition(
  opts?: CreateLocalEnvironmentDefinitionOptions,
): EnvironmentDefinition<LocalEnvironmentState> {
  const localGitWorkspaceDefinition = createLocalGitWorkspaceDefinition(opts?.worktree);
  return {
    kind: "local",
    info: { ...LOCAL_ENVIRONMENT_INFO },
    create(context: CreateEnvironmentContext): IEnvironment {
      if (shouldUseWorktreeRuntime(context)) {
        return localGitWorkspaceDefinition.create(context);
      }
      return new LocalEnvironment(context);
    },
    restore(state: LocalEnvironmentState, context: CreateEnvironmentContext): IEnvironment {
      if (isLocalGitWorkspaceState(state) && shouldUseWorktreeRuntime(context)) {
        return localGitWorkspaceDefinition.restore(state, context);
      }
      return new LocalEnvironment({
        ...context,
        ...(typeof state.workspaceRoot === "string"
          ? { workspaceRootPath: state.workspaceRoot }
          : {}),
      });
    },
    isState(value: unknown): value is LocalEnvironmentState {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    },
  };
}
