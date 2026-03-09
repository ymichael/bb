import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import type { EnvironmentAgentConnectionTarget } from "@beanbag/environment-agent";
import type {
  CreateEnvironmentContext,
  DemoteEnvironmentOptions,
  DemoteEnvironmentResult,
  EnvironmentCommandOptions,
  EnvironmentDefinition,
  EnvironmentCheckoutSnapshot,
  EnvironmentCommitSummary,
  EnvironmentInfo,
  EnvironmentSpawnOptions,
  EnvironmentSquashMergeOptions,
  EnvironmentSquashMergeResult,
  EnvironmentWorkspaceCommitOptions,
  EnvironmentWorkspaceCommitResult,
  EnvironmentWorkspaceCommitsOptions,
  EnvironmentWorkspaceDiffOptions,
  EnvironmentWorkspaceDiffResult,
  EnvironmentWorkspaceStatusOptions,
  IEnvironment,
  PromoteEnvironmentOptions,
  PromoteEnvironmentResult,
} from "./contracts.js";
import {
  disposeManagedHostEnvironmentAgent,
  ensureManagedHostEnvironmentAgent,
  resolveManagedHostEnvironmentAgentTarget,
} from "./host-environment-agent.js";
import { runCommand, runCommandAsync, spawnCommand } from "./process.js";
import {
  resolveEnvironmentAgentConnectionTarget,
} from "./environment-agent-target.js";
import {
  createWorktreeEnvironmentDefinition,
  type CreateWorktreeEnvironmentDefinitionOptions,
  type WorktreeEnvironmentState,
} from "./worktree-environment.js";

export interface DockerEnvironmentState {
  worktree: WorktreeEnvironmentState;
  containerName: string;
  image: string;
  mountPath: string;
}

export interface CreateDockerEnvironmentDefinitionOptions {
  worktree?: CreateWorktreeEnvironmentDefinitionOptions;
  image?: string;
  mountPath?: string;
  containerPrefix?: string;
  dockerBin?: string;
}

const DEFAULT_CONTAINER_PREFIX = "beanbag-thread";
const DEFAULT_MOUNT_PATH = "/workspace";

const DOCKER_ENVIRONMENT_INFO: EnvironmentInfo = {
  id: "docker",
  displayName: "Docker Workspace",
  description:
    "Run thread commands in a per-thread Docker container backed by an isolated git worktree.",
  capabilities: {
    host_filesystem: true,
    isolated_workspace: true,
    promote_primary_checkout: true,
    demote_primary_checkout: true,
    squash_merge: true,
  },
};

function sanitizeContainerSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "thread";
}

function resolveContainerName(args: {
  threadId: string;
  containerPrefix: string;
}): string {
  return `${args.containerPrefix}-${sanitizeContainerSegment(args.threadId)}`;
}

function resolveDockerImage(args: {
  configuredImage?: string;
  runtimeEnv: Record<string, string | undefined>;
}): string {
  const image = args.configuredImage ?? args.runtimeEnv.BEANBAG_DOCKER_IMAGE;
  if (!image || image.trim().length === 0) {
    throw new Error(
      "Docker environment requires BEANBAG_DOCKER_IMAGE or an explicit image option",
    );
  }
  return image.trim();
}

function toDockerExecArgs(args: {
  mountPath: string;
  workspaceRoot: string;
  containerName: string;
  command: string;
  commandArgs: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}): string[] {
  const workDir = resolveContainerCwd({
    mountPath: args.mountPath,
    workspaceRoot: args.workspaceRoot,
    cwd: args.cwd,
  });
  return [
    "exec",
    "-i",
    ...(workDir ? ["-w", workDir] : []),
    ...toDockerEnvArgs(args.env),
    args.containerName,
    args.command,
    ...args.commandArgs,
  ];
}

function toDockerEnvArgs(
  env: Record<string, string | undefined> | undefined,
): string[] {
  if (!env) return [];
  const args: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    args.push("-e", `${key}=${value}`);
  }
  return args;
}

function resolveContainerCwd(args: {
  mountPath: string;
  workspaceRoot: string;
  cwd?: string;
}): string | undefined {
  if (!args.cwd) return args.mountPath;
  if (path.isAbsolute(args.cwd)) {
    const relativePath = path.relative(args.workspaceRoot, args.cwd);
    if (
      !relativePath.startsWith("..") &&
      relativePath !== ".." &&
      relativePath.length > 0
    ) {
      return path.posix.join(
        args.mountPath,
        relativePath.split(path.sep).join(path.posix.sep),
      );
    }
    if (relativePath === "") return args.mountPath;
    return args.cwd;
  }
  return path.posix.join(args.mountPath, args.cwd.split(path.sep).join(path.posix.sep));
}

class DockerEnvironment implements IEnvironment {
  readonly kind = "docker";
  readonly info = { ...DOCKER_ENVIRONMENT_INFO };

  constructor(
    private readonly projectId: string,
    private readonly threadId: string,
    private readonly inner: IEnvironment,
    private readonly state: DockerEnvironmentState,
    private readonly runtimeEnv: Record<string, string | undefined>,
    private readonly dockerBin: string,
  ) {}

  serialize(): DockerEnvironmentState {
    return {
      ...this.state,
      worktree: { ...this.state.worktree },
    };
  }

  async prepare(): Promise<void> {
    await this.inner.prepare?.();
    if (this.containerExists()) {
      this.ensureContainerRunning();
    } else {
      const result = spawnSync(
        this.dockerBin,
        [
          "run",
          "-d",
          "--name",
          this.state.containerName,
          "-v",
          `${this.getWorkspaceRootUnsafe()}:${this.state.mountPath}`,
          "-w",
          this.state.mountPath,
          this.state.image,
          "sleep",
          "infinity",
        ],
        {
          encoding: "utf-8",
          stdio: "pipe",
        },
      );
      if (result.status !== 0) {
        throw new Error(
          result.stderr || result.stdout || "Failed to create Docker container",
        );
      }
    }

    await ensureManagedHostEnvironmentAgent({
      workspaceRootPath: this.getWorkspaceRootUnsafe(),
      threadId: this.threadId,
      projectId: this.projectId,
      environmentId: this.kind,
      runtimeEnv: this.runtimeEnv,
    });
  }

  async dispose(): Promise<void> {
    await disposeManagedHostEnvironmentAgent({
      projectId: this.projectId,
      threadId: this.threadId,
      environmentId: this.kind,
      runtimeEnv: this.runtimeEnv,
    });
    spawnSync(
      this.dockerBin,
      ["rm", "-f", this.state.containerName],
      { encoding: "utf-8", stdio: "pipe" },
    );
    await Promise.resolve(this.inner.dispose());
  }

  exists(): boolean {
    return this.inner.exists() && this.containerExists();
  }

  supportsHostFilesystemAccess(): boolean {
    return true;
  }

  isIsolatedWorkspace(): boolean {
    return true;
  }

  getAgentConnectionTarget(): EnvironmentAgentConnectionTarget {
    const managedTarget = resolveManagedHostEnvironmentAgentTarget({
      projectId: this.projectId,
      threadId: this.threadId,
      environmentId: this.kind,
      runtimeEnv: this.runtimeEnv,
      providerLaunch: {
        command: this.dockerBin,
        args: ["exec", "-i", this.state.containerName],
      },
    });
    if (!managedTarget && !this.runtimeEnv.BEANBAG_ENVIRONMENT_AGENT_BASE_URL?.trim()) {
      throw new Error("Missing managed environment-agent target for docker environment");
    }
    return resolveEnvironmentAgentConnectionTarget({
      runtimeEnv: this.runtimeEnv,
      defaultTarget:
        managedTarget ?? {
          transport: "http",
          baseUrl: "http://127.0.0.1:0",
          providerLaunch: {
            command: this.dockerBin,
            args: ["exec", "-i", this.state.containerName],
          },
        },
    });
  }

  getCheckoutSnapshot(): EnvironmentCheckoutSnapshot {
    return this.inner.getCheckoutSnapshot();
  }

  getWorkspaceRootUnsafe(): string {
    return this.inner.getWorkspaceRootUnsafe();
  }

  buildAgentInstructions(): string | undefined {
    const base = this.inner.buildAgentInstructions?.();
    const dockerNote =
      "- Commands run inside a per-thread Docker container backed by the isolated workspace.";
    return base ? `${base}\n${dockerNote}` : dockerNote;
  }

  getWorkspaceStatus(args?: EnvironmentWorkspaceStatusOptions) {
    return this.inner.getWorkspaceStatus(args);
  }

  watchWorkspaceStatus(onChange: () => void): () => void {
    return this.inner.watchWorkspaceStatus(onChange);
  }

  commitWorkspace(
    args: EnvironmentWorkspaceCommitOptions,
  ): Promise<EnvironmentWorkspaceCommitResult> {
    return this.inner.commitWorkspace(args);
  }

  listWorkspaceCommitsSinceRef(
    args: EnvironmentWorkspaceCommitsOptions,
  ): EnvironmentCommitSummary[] {
    return this.inner.listWorkspaceCommitsSinceRef(args);
  }

  getWorkspaceDiff(
    args: EnvironmentWorkspaceDiffOptions,
  ): EnvironmentWorkspaceDiffResult {
    return this.inner.getWorkspaceDiff(args);
  }

  spawn(
    command: string,
    args: string[],
    options?: EnvironmentSpawnOptions,
  ): ChildProcess {
    return spawnCommand(
      this.dockerBin,
      toDockerExecArgs({
        mountPath: this.state.mountPath,
        workspaceRoot: this.getWorkspaceRootUnsafe(),
        containerName: this.state.containerName,
        command,
        commandArgs: args,
        cwd: options?.cwd,
        env: options?.env,
      }),
      {
        cwd: this.getWorkspaceRootUnsafe(),
        env: this.runtimeEnv,
        stdio: options?.stdio,
      },
    );
  }

  shouldRunSetupScript(): boolean {
    return this.inner.shouldRunSetupScript();
  }

  supportsPromoteToActiveWorkspace(): boolean {
    return this.inner.supportsPromoteToActiveWorkspace();
  }

  supportsDemoteFromActiveWorkspace(): boolean {
    return this.inner.supportsDemoteFromActiveWorkspace();
  }

  supportsSquashMergeIntoDefaultBranch(): boolean {
    return this.inner.supportsSquashMergeIntoDefaultBranch();
  }

  promoteToActiveWorkspace(args: PromoteEnvironmentOptions): PromoteEnvironmentResult {
    return this.inner.promoteToActiveWorkspace(args);
  }

  demoteFromActiveWorkspace(args: DemoteEnvironmentOptions): DemoteEnvironmentResult {
    return this.inner.demoteFromActiveWorkspace(args);
  }

  squashMergeIntoDefaultBranch(
    args: EnvironmentSquashMergeOptions,
  ): Promise<EnvironmentSquashMergeResult> {
    return this.inner.squashMergeIntoDefaultBranch(args);
  }

  run(
    command: string,
    args: string[],
    options?: EnvironmentCommandOptions,
  ) {
    return runCommand(
      this.dockerBin,
      toDockerExecArgs({
        mountPath: this.state.mountPath,
        workspaceRoot: this.getWorkspaceRootUnsafe(),
        containerName: this.state.containerName,
        command,
        commandArgs: args,
        cwd: options?.cwd,
        env: options?.env,
      }),
      {
        cwd: this.getWorkspaceRootUnsafe(),
        env: this.runtimeEnv,
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.rawOutput ? { rawOutput: true } : {}),
      },
    );
  }

  runAsync(
    command: string,
    args: string[],
    options?: EnvironmentCommandOptions,
  ) {
    return runCommandAsync(
      this.dockerBin,
      toDockerExecArgs({
        mountPath: this.state.mountPath,
        workspaceRoot: this.getWorkspaceRootUnsafe(),
        containerName: this.state.containerName,
        command,
        commandArgs: args,
        cwd: options?.cwd,
        env: options?.env,
      }),
      {
        cwd: this.getWorkspaceRootUnsafe(),
        env: this.runtimeEnv,
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.rawOutput ? { rawOutput: true } : {}),
        ...(options?.onStdoutLine ? { onStdoutLine: options.onStdoutLine } : {}),
        ...(options?.onStderrLine ? { onStderrLine: options.onStderrLine } : {}),
      },
    );
  }

  private containerExists(): boolean {
    const result = spawnSync(
      this.dockerBin,
      ["inspect", this.state.containerName],
      { encoding: "utf-8", stdio: "pipe" },
    );
    return result.status === 0;
  }

  private ensureContainerRunning(): void {
    const stateResult = spawnSync(
      this.dockerBin,
      ["inspect", "-f", "{{.State.Running}}", this.state.containerName],
      { encoding: "utf-8", stdio: "pipe" },
    );
    if (stateResult.status === 0 && stateResult.stdout.trim() === "true") {
      return;
    }
    const startResult = spawnSync(
      this.dockerBin,
      ["start", this.state.containerName],
      { encoding: "utf-8", stdio: "pipe" },
    );
    if (startResult.status !== 0) {
      throw new Error(
        startResult.stderr || startResult.stdout || "Failed to start Docker container",
      );
    }
  }
}

export function createDockerEnvironmentDefinition(
  opts?: CreateDockerEnvironmentDefinitionOptions,
): EnvironmentDefinition<DockerEnvironmentState> {
  const worktreeDefinition = createWorktreeEnvironmentDefinition({
    ...opts?.worktree,
    manageEnvironmentAgent: false,
  });
  const dockerBin = opts?.dockerBin ?? "docker";
  const mountPath = opts?.mountPath ?? DEFAULT_MOUNT_PATH;
  const containerPrefix = opts?.containerPrefix ?? DEFAULT_CONTAINER_PREFIX;

  return {
    kind: "docker",
    info: { ...DOCKER_ENVIRONMENT_INFO },
    create(context: CreateEnvironmentContext): IEnvironment {
      const inner = worktreeDefinition.create(context);
      const worktreeState = inner.serialize() as WorktreeEnvironmentState;
      const image = resolveDockerImage({
        configuredImage: opts?.image,
        runtimeEnv: context.runtimeEnv,
      });
      return new DockerEnvironment(
        context.projectId,
        context.threadId,
        inner,
        {
          worktree: worktreeState,
          containerName: resolveContainerName({
            threadId: context.threadId,
            containerPrefix,
          }),
          image,
          mountPath,
        },
        context.runtimeEnv,
        dockerBin,
      );
    },
    restore(state: DockerEnvironmentState, context: CreateEnvironmentContext): IEnvironment {
      const inner = worktreeDefinition.restore(state.worktree, context);
      return new DockerEnvironment(
        context.projectId,
        context.threadId,
        inner,
        {
          worktree: { ...state.worktree },
          containerName: state.containerName,
          image: state.image,
          mountPath: state.mountPath,
        },
        context.runtimeEnv,
        dockerBin,
      );
    },
    isState(value: unknown): value is DockerEnvironmentState {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      return (
        typeof record.containerName === "string" &&
        typeof record.image === "string" &&
        typeof record.mountPath === "string" &&
        Boolean(record.worktree) &&
        typeof record.worktree === "object"
      );
    },
  };
}
