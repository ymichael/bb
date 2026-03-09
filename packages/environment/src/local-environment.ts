import { existsSync } from "node:fs";
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

interface LocalEnvironmentState {}

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
  private readonly rootPath: string;
  private readonly env: Record<string, string | undefined>;
  private readonly services: CreateEnvironmentContext["services"];

  constructor(context: CreateEnvironmentContext) {
    this.projectId = context.projectId;
    this.threadId = context.threadId;
    this.rootPath = context.projectRootPath;
    this.env = { ...context.runtimeEnv };
    this.services = context.services;
  }

  serialize(): LocalEnvironmentState {
    return {};
  }

  async prepare(): Promise<void> {
    await ensureManagedHostEnvironmentAgent({
      workspaceRootPath: this.rootPath,
      threadId: this.threadId,
      projectId: this.projectId,
      environmentId: this.kind,
      runtimeEnv: this.env,
    });
  }

  async dispose(): Promise<void> {
    await disposeManagedHostEnvironmentAgent({
      projectId: this.projectId,
      threadId: this.threadId,
      environmentId: this.kind,
      runtimeEnv: this.env,
    });
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
    const managedTarget = resolveManagedHostEnvironmentAgentTarget({
      projectId: this.projectId,
      threadId: this.threadId,
      environmentId: this.kind,
      runtimeEnv: this.env,
    });
    if (!managedTarget && !this.env.BEANBAG_ENVIRONMENT_AGENT_BASE_URL?.trim()) {
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

  getCheckoutSnapshot(): EnvironmentCheckoutSnapshot {
    const headResult = this.run("git", ["rev-parse", "HEAD"]);
    if (headResult.exitCode !== 0 || !headResult.stdout) {
      throw new Error("Failed to resolve HEAD");
    }

    const branchResult = this.run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
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

  buildAgentInstructions(): string | undefined {
    return undefined;
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
    return false;
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

  promoteToActiveWorkspace(_args: PromoteEnvironmentOptions): PromoteEnvironmentResult {
    throw new Error("Promotion is not supported for local environments");
  }

  demoteFromActiveWorkspace(_args: DemoteEnvironmentOptions): DemoteEnvironmentResult {
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

export function createLocalEnvironmentDefinition(): EnvironmentDefinition<LocalEnvironmentState> {
  return {
    kind: "local",
    info: { ...LOCAL_ENVIRONMENT_INFO },
    create(context: CreateEnvironmentContext): IEnvironment {
      return new LocalEnvironment(context);
    },
    restore(_state: LocalEnvironmentState, context: CreateEnvironmentContext): IEnvironment {
      return new LocalEnvironment(context);
    },
    isState(value: unknown): value is LocalEnvironmentState {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    },
  };
}
