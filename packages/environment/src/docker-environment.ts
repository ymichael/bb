import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { EnvironmentAgentConnectionTarget } from "@bb/environment-daemon";
import { renderTemplate } from "@bb/templates";
import type {
  CreateEnvironmentContext,
  DemoteEnvironmentOptions,
  DemoteEnvironmentResult,
  EnvironmentCommandOptions,
  EnvironmentCommandResult,
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
  EnvironmentWorkStatus,
  IEnvironment,
  PromoteEnvironmentOptions,
  PromoteEnvironmentResult,
} from "./contracts.js";
import {
  DEFAULT_DOCKER_ENVIRONMENT_AGENT_CONTAINER_PORT,
  disposeManagedDockerEnvironmentAgent,
  ensureDockerEnvironmentImageAvailable,
  ensureManagedDockerEnvironmentAgent,
  resolveDockerEnvironmentImage,
} from "./docker-environment-agent.js";
import { runCommandAsync, spawnCommand } from "./process.js";
import {
  resolveEnvironmentAgentConnectionTarget,
} from "./environment-agent-target.js";
import {
  createLocalGitWorkspaceDefinition,
  type CreateLocalGitWorkspaceOptions,
  isLocalGitWorkspaceState,
  type LocalGitWorkspaceState,
} from "./local-git-workspace.js";

export interface DockerEnvironmentState {
  worktree: LocalGitWorkspaceState;
  containerName: string;
  image: string;
  mountPath: string;
  agentHostPort?: number;
  agentContainerPort?: number;
}

export interface CreateDockerEnvironmentDefinitionOptions {
  worktree?: CreateLocalGitWorkspaceOptions;
  image?: string;
  mountPath?: string;
  containerPrefix?: string;
  dockerBin?: string;
}

export function isDockerEnvironmentState(value: unknown): value is DockerEnvironmentState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.containerName === "string" &&
    typeof record.image === "string" &&
    typeof record.mountPath === "string" &&
    (record.agentHostPort === undefined ||
      typeof record.agentHostPort === "number") &&
    (record.agentContainerPort === undefined ||
      typeof record.agentContainerPort === "number") &&
    isLocalGitWorkspaceState(record.worktree)
  );
}

const DEFAULT_CONTAINER_PREFIX = "bb-thread";
const DEFAULT_MOUNT_PATH = "/workspace";

const DOCKER_ENVIRONMENT_INFO: EnvironmentInfo = {
  id: "docker",
  displayName: "Docker Sandbox",
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
  environmentId: string;
  containerPrefix: string;
}): string {
  return `${args.containerPrefix}-${sanitizeContainerSegment(args.environmentId)}`;
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

async function runDockerCommandAsync(args: {
  dockerBin: string;
  commandArgs: string[];
  runtimeEnv: Record<string, string | undefined>;
  workspaceRoot: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return runCommandAsync(args.dockerBin, args.commandArgs, {
    cwd: args.workspaceRoot,
    env: args.runtimeEnv,
    rawOutput: true,
  });
}

async function dockerContainerExistsAsync(args: {
  dockerBin: string;
  containerName: string;
  runtimeEnv: Record<string, string | undefined>;
  workspaceRoot: string;
}): Promise<boolean> {
  const result = await runDockerCommandAsync({
    dockerBin: args.dockerBin,
    commandArgs: ["inspect", args.containerName],
    runtimeEnv: args.runtimeEnv,
    workspaceRoot: args.workspaceRoot,
  });
  return result.exitCode === 0;
}

async function ensureDockerContainerRunningAsync(args: {
  dockerBin: string;
  containerName: string;
  runtimeEnv: Record<string, string | undefined>;
  workspaceRoot: string;
}): Promise<void> {
  const stateResult = await runDockerCommandAsync({
    dockerBin: args.dockerBin,
    commandArgs: ["inspect", "-f", "{{.State.Running}}", args.containerName],
    runtimeEnv: args.runtimeEnv,
    workspaceRoot: args.workspaceRoot,
  });
  if (stateResult.exitCode === 0 && stateResult.stdout.trim() === "true") {
    return;
  }
  const startResult = await runDockerCommandAsync({
    dockerBin: args.dockerBin,
    commandArgs: ["start", args.containerName],
    runtimeEnv: args.runtimeEnv,
    workspaceRoot: args.workspaceRoot,
  });
  if (startResult.exitCode !== 0) {
    throw new Error(startResult.stderr || startResult.stdout || "Failed to start Docker container");
  }
}

async function dockerContainerHasExpectedPortMappingAsync(args: {
  dockerBin: string;
  containerName: string;
  agentHostPort?: number;
  agentContainerPort?: number;
  runtimeEnv: Record<string, string | undefined>;
  workspaceRoot: string;
}): Promise<boolean> {
  const hostPort = args.agentHostPort;
  const containerPort = args.agentContainerPort;
  if (!hostPort || !containerPort) {
    return false;
  }
  const inspectResult = await runDockerCommandAsync({
    dockerBin: args.dockerBin,
    commandArgs: [
      "inspect",
      "-f",
      `{{with index .NetworkSettings.Ports "${containerPort}/tcp"}}{{(index . 0).HostPort}}{{end}}`,
      args.containerName,
    ],
    runtimeEnv: args.runtimeEnv,
    workspaceRoot: args.workspaceRoot,
  });
  return inspectResult.exitCode === 0 && inspectResult.stdout.trim() === String(hostPort);
}

async function resolveGitMetadataMountArgsAsync(args: {
  projectRootPath: string;
  workspaceRoot: string;
}): Promise<string[]> {
  const mountRoots = new Set<string>();
  const workspaceGitFile = path.join(args.workspaceRoot, ".git");
  try {
    const rawGitFile = (await readFile(workspaceGitFile, "utf-8")).trim();
    const prefix = "gitdir:";
    if (rawGitFile.startsWith(prefix)) {
      const rawGitDir = rawGitFile.slice(prefix.length).trim();
      const resolvedGitDir = path.isAbsolute(rawGitDir)
        ? rawGitDir
        : path.resolve(args.workspaceRoot, rawGitDir);
      const worktreesRoot = path.dirname(resolvedGitDir);
      if (path.basename(worktreesRoot) === "worktrees") {
        mountRoots.add(path.dirname(worktreesRoot));
      }
    }
  } catch {
    // Ignore missing workspace git metadata mounts.
  }

  const projectGitRoot = path.join(args.projectRootPath, ".git");
  try {
    await access(projectGitRoot);
    mountRoots.add(projectGitRoot);
  } catch {
    // Ignore missing project git metadata mounts.
  }

  if (mountRoots.size === 0) {
    return [];
  }

  return Array.from(mountRoots).flatMap((mountRoot) => ["-v", `${mountRoot}:${mountRoot}`]);
}

async function createDockerContainerAsync(args: {
  dockerBin: string;
  projectRootPath: string;
  state: DockerEnvironmentState;
  runtimeEnv: Record<string, string | undefined>;
}): Promise<void> {
  const gitMetadataMountArgs = await resolveGitMetadataMountArgsAsync({
    projectRootPath: args.projectRootPath,
    workspaceRoot: args.state.worktree.workspaceRoot,
  });
  const result = await runDockerCommandAsync({
    dockerBin: args.dockerBin,
    commandArgs: [
      "run",
      "-d",
      "--name",
      args.state.containerName,
      "-p",
      `${args.state.agentHostPort}:${args.state.agentContainerPort}`,
      "-v",
      `${args.state.worktree.workspaceRoot}:${args.state.mountPath}`,
      ...gitMetadataMountArgs,
      "-w",
      args.state.mountPath,
      args.state.image,
      "sleep",
      "infinity",
    ],
    runtimeEnv: args.runtimeEnv,
    workspaceRoot: args.state.worktree.workspaceRoot,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to create Docker container");
  }
}

async function removeDockerContainerAsync(args: {
  dockerBin: string;
  containerName: string;
  runtimeEnv: Record<string, string | undefined>;
  workspaceRoot: string;
}): Promise<void> {
  await runDockerCommandAsync({
    dockerBin: args.dockerBin,
    commandArgs: ["rm", "-f", args.containerName],
    runtimeEnv: args.runtimeEnv,
    workspaceRoot: args.workspaceRoot,
  });
}

async function verifyDockerGitRepositoryAccessibleAsync(args: {
  dockerBin: string;
  containerName: string;
  mountPath: string;
  runtimeEnv: Record<string, string | undefined>;
  workspaceRoot: string;
}): Promise<void> {
  const commands: ReadonlyArray<readonly string[]> = [
    ["git", "rev-parse", "--show-toplevel"],
    ["git", "rev-parse", "--git-dir"],
  ];

  for (const commandArgs of commands) {
    const result = await runDockerCommandAsync({
      dockerBin: args.dockerBin,
      commandArgs: [
        "exec",
        "-i",
        "-w",
        args.mountPath,
        args.containerName,
        ...commandArgs,
      ],
      runtimeEnv: args.runtimeEnv,
      workspaceRoot: args.workspaceRoot,
    });
    if (result.exitCode === 0) {
      continue;
    }
    const renderedCommand = commandArgs.join(" ");
    throw new Error(
      result.stderr ||
        result.stdout ||
        `Docker workspace git check failed: ${renderedCommand}`,
    );
  }
}

class DockerEnvironment implements IEnvironment {
  readonly kind = "docker";
  readonly info = { ...DOCKER_ENVIRONMENT_INFO };
  private readonly environmentId: string;
  private managedAgentTarget?: EnvironmentAgentConnectionTarget;

  constructor(
    private readonly projectId: string,
    private readonly threadId: string,
    private readonly projectRootPath: string,
    private readonly inner: IEnvironment,
    private readonly state: DockerEnvironmentState,
    private readonly runtimeEnv: Record<string, string | undefined>,
    private readonly dockerBin: string,
  ) {
    this.environmentId = runtimeEnv.BB_ENVIRONMENT_ID?.trim() || this.kind;
  }

  serialize(): DockerEnvironmentState {
    return {
      ...this.state,
      worktree: { ...this.state.worktree },
    };
  }

  async prepare(): Promise<void> {
    await this.inner.prepare?.();
    if (!this.state.agentHostPort || !this.state.agentContainerPort) {
      throw new Error(`Docker workspace is unavailable: ${this.state.containerName}`);
    }
    if (!await this.containerExistsAsync()) {
      throw new Error(`Docker workspace is unavailable: ${this.state.containerName}`);
    }
    await this.ensureContainerRunningAsync();
    await this.verifyGitRepositoryAccessibleInContainerAsync();

    const managedAgentTarget = await ensureManagedDockerEnvironmentAgent({
      workspaceRootPath: this.getWorkspaceRootUnsafe(),
      threadId: this.threadId,
      projectId: this.projectId,
      environmentId: this.environmentId,
      runtimeEnv: this.runtimeEnv,
      dockerBin: this.dockerBin,
      containerName: this.state.containerName,
      hostPort: this.state.agentHostPort,
      containerPort: this.state.agentContainerPort,
    });
    if (managedAgentTarget) {
      this.managedAgentTarget = managedAgentTarget;
    }
  }

  async suspend(): Promise<void> {
    this.managedAgentTarget = undefined;
    await disposeManagedDockerEnvironmentAgent({
      projectId: this.projectId,
      threadId: this.threadId,
      environmentId: this.environmentId,
      dockerBin: this.dockerBin,
      containerName: this.state.containerName,
      workspaceRootPath: this.getWorkspaceRootUnsafe(),
      runtimeEnv: this.runtimeEnv,
    });
    await Promise.resolve(this.inner.suspend());
  }

  async destroy(): Promise<void> {
    await this.suspend();
  }

  exists(): boolean {
    return this.inner.exists();
  }

  supportsHostFilesystemAccess(): boolean {
    return true;
  }

  isIsolatedWorkspace(): boolean {
    return true;
  }

  getAgentConnectionTarget(): EnvironmentAgentConnectionTarget {
    const managedTarget = this.managedAgentTarget;
    if (!managedTarget && !this.runtimeEnv.BB_ENV_DAEMON_BASE_URL?.trim()) {
      throw new Error("Missing managed environment-agent target for docker environment");
    }
    return resolveEnvironmentAgentConnectionTarget({
      runtimeEnv: this.runtimeEnv,
      defaultTarget:
        managedTarget ?? {
          transport: "http",
          baseUrl: "http://127.0.0.1:0",
        },
    });
  }

  getCheckoutSnapshot(): Promise<EnvironmentCheckoutSnapshot> {
    return this.inner.getCheckoutSnapshot();
  }

  getWorkspaceRootUnsafe(): string {
    return this.inner.getWorkspaceRootUnsafe();
  }

  isPrimaryWorkspace(projectRootPath: string): boolean {
    return this.inner.isPrimaryWorkspace
      ? this.inner.isPrimaryWorkspace(projectRootPath)
      : path.resolve(this.getWorkspaceRootUnsafe()) === path.resolve(projectRootPath);
  }

  isContainerBacked(): boolean {
    return true;
  }

  buildAgentInstructions(): string | undefined {
    const base = this.inner.buildAgentInstructions?.();
    const dockerNote = renderTemplate("dockerAgentNote", {});
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
  ): Promise<EnvironmentCommitSummary[]> {
    return this.inner.listWorkspaceCommitsSinceRef(args);
  }

  getWorkspaceDiff(
    args: EnvironmentWorkspaceDiffOptions,
  ): Promise<EnvironmentWorkspaceDiffResult> {
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

  supportsPromoteToActiveWorkspace(): boolean {
    return this.inner.supportsPromoteToActiveWorkspace();
  }

  supportsDemoteFromActiveWorkspace(): boolean {
    return this.inner.supportsDemoteFromActiveWorkspace();
  }

  supportsSquashMergeIntoDefaultBranch(): boolean {
    return this.inner.supportsSquashMergeIntoDefaultBranch();
  }

  promoteToActiveWorkspace(
    args: PromoteEnvironmentOptions,
  ): Promise<PromoteEnvironmentResult> {
    return this.inner.promoteToActiveWorkspace(args);
  }

  demoteFromActiveWorkspace(
    args: DemoteEnvironmentOptions,
  ): Promise<DemoteEnvironmentResult> {
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

  private async runDockerCommandAsync(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return runCommandAsync(this.dockerBin, args, {
      cwd: this.getWorkspaceRootUnsafe(),
      env: this.runtimeEnv,
      rawOutput: true,
    });
  }

  private async containerExistsAsync(): Promise<boolean> {
    const result = await this.runDockerCommandAsync(["inspect", this.state.containerName]);
    return result.exitCode === 0;
  }

  private async ensureContainerRunningAsync(): Promise<void> {
    const stateResult = await this.runDockerCommandAsync([
      "inspect",
      "-f",
      "{{.State.Running}}",
      this.state.containerName,
    ]);
    if (stateResult.exitCode === 0 && stateResult.stdout.trim() === "true") {
      return;
    }
    const startResult = await this.runDockerCommandAsync(["start", this.state.containerName]);
    if (startResult.exitCode !== 0) {
      throw new Error(
        startResult.stderr || startResult.stdout || "Failed to start Docker container",
      );
    }
  }

  private async containerHasExpectedPortMappingAsync(): Promise<boolean> {
    const hostPort = this.state.agentHostPort;
    const containerPort = this.state.agentContainerPort;
    if (!hostPort || !containerPort) {
      return false;
    }
    const inspectResult = await this.runDockerCommandAsync([
      "inspect",
      "-f",
      `{{with index .NetworkSettings.Ports "${containerPort}/tcp"}}{{(index . 0).HostPort}}{{end}}`,
      this.state.containerName,
    ]);
    return inspectResult.exitCode === 0 && inspectResult.stdout.trim() === String(hostPort);
  }

  private async createContainerAsync(): Promise<void> {
    const gitMetadataMountArgs = await this.resolveGitMetadataMountArgsAsync();
    const result = await this.runDockerCommandAsync([
      "run",
      "-d",
      "--name",
      this.state.containerName,
      "-p",
      `${this.state.agentHostPort}:${this.state.agentContainerPort}`,
      "-v",
      `${this.getWorkspaceRootUnsafe()}:${this.state.mountPath}`,
      ...gitMetadataMountArgs,
      "-w",
      this.state.mountPath,
      this.state.image,
      "sleep",
      "infinity",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "Failed to create Docker container");
    }
  }

  private async removeContainerAsync(): Promise<void> {
    await this.runDockerCommandAsync(["rm", "-f", this.state.containerName]);
  }

  private async resolveGitMetadataMountArgsAsync(): Promise<string[]> {
    const mountRoots = new Set<string>();
    const workspaceGitFile = path.join(this.getWorkspaceRootUnsafe(), ".git");
    try {
      const rawGitFile = (await readFile(workspaceGitFile, "utf-8")).trim();
      const prefix = "gitdir:";
      if (rawGitFile.startsWith(prefix)) {
        const rawGitDir = rawGitFile.slice(prefix.length).trim();
        const resolvedGitDir = path.isAbsolute(rawGitDir)
          ? rawGitDir
          : path.resolve(this.getWorkspaceRootUnsafe(), rawGitDir);
        const worktreesRoot = path.dirname(resolvedGitDir);
        if (path.basename(worktreesRoot) === "worktrees") {
          mountRoots.add(path.dirname(worktreesRoot));
        }
      }
    } catch {
      // Ignore missing workspace git metadata mounts.
    }

    const projectGitRoot = path.join(this.projectRootPath, ".git");
    try {
      await access(projectGitRoot);
      mountRoots.add(projectGitRoot);
    } catch {
      // Ignore missing project git metadata mounts.
    }

    if (mountRoots.size === 0) {
      return [];
    }

    return Array.from(mountRoots).flatMap((mountRoot) => [
      "-v",
      `${mountRoot}:${mountRoot}`,
    ]);
  }

  private async verifyGitRepositoryAccessibleInContainerAsync(): Promise<void> {
    const commands: ReadonlyArray<readonly string[]> = [
      ["git", "rev-parse", "--show-toplevel"],
      ["git", "rev-parse", "--git-dir"],
    ];

    for (const commandArgs of commands) {
      const result = await this.runDockerCommandAsync([
        "exec",
        "-i",
        "-w",
        this.state.mountPath,
        this.state.containerName,
        ...commandArgs,
      ]);
      if (result.exitCode === 0) {
        continue;
      }
      const renderedCommand = commandArgs.join(" ");
      throw new Error(
        result.stderr ||
          result.stdout ||
          `Docker workspace git check failed: ${renderedCommand}`,
      );
    }
  }
}

async function allocatePort(): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate docker environment-agent port")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise(address.port);
      });
    });
  });
}

export function createDockerEnvironmentDefinition(
  opts?: CreateDockerEnvironmentDefinitionOptions,
): EnvironmentDefinition<DockerEnvironmentState> {
  const localGitWorkspaceDefinition = createLocalGitWorkspaceDefinition({
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
      const inner = localGitWorkspaceDefinition.create(context);
      const worktreeState = inner.serialize() as LocalGitWorkspaceState;
      return new DockerEnvironment(
        context.projectId,
        context.threadId,
        context.projectRootPath,
        inner,
        {
          worktree: worktreeState,
          containerName: resolveContainerName({
            environmentId: context.environmentId ?? context.threadId,
            containerPrefix,
          }),
          image: resolveDockerEnvironmentImage({
            configuredImage: opts?.image,
            runtimeEnv: context.runtimeEnv,
          }),
          mountPath,
          agentContainerPort: DEFAULT_DOCKER_ENVIRONMENT_AGENT_CONTAINER_PORT,
        },
        context.runtimeEnv,
        dockerBin,
      );
    },
    restore(state: DockerEnvironmentState, context: CreateEnvironmentContext): IEnvironment {
      const inner = localGitWorkspaceDefinition.restore(state.worktree, context);
      return new DockerEnvironment(
        context.projectId,
        context.threadId,
        context.projectRootPath,
        inner,
        {
          worktree: { ...state.worktree },
          containerName: state.containerName,
          image: state.image,
          mountPath: state.mountPath,
          ...(typeof state.agentHostPort === "number"
            ? { agentHostPort: state.agentHostPort }
            : {}),
          ...(typeof state.agentContainerPort === "number"
            ? { agentContainerPort: state.agentContainerPort }
            : {}),
        },
        context.runtimeEnv,
        dockerBin,
      );
    },
    isState: isDockerEnvironmentState,
  };
}

export async function resolveDockerEnvironmentState(args: {
  projectId: string;
  threadId: string;
  environmentId?: string;
  runtimeEnv: Record<string, string | undefined>;
  worktree: LocalGitWorkspaceState;
  image?: string;
  mountPath?: string;
  containerPrefix?: string;
}): Promise<DockerEnvironmentState> {
  return {
    worktree: { ...args.worktree },
    containerName: resolveContainerName({
      environmentId: args.environmentId ?? args.threadId,
      containerPrefix: args.containerPrefix ?? DEFAULT_CONTAINER_PREFIX,
    }),
    image: resolveDockerEnvironmentImage({
      configuredImage: args.image,
      runtimeEnv: args.runtimeEnv,
    }),
    mountPath: args.mountPath ?? DEFAULT_MOUNT_PATH,
    agentHostPort: await allocatePort(),
    agentContainerPort: DEFAULT_DOCKER_ENVIRONMENT_AGENT_CONTAINER_PORT,
  };
}

export async function ensureDockerEnvironmentArtifacts(args: {
  projectId: string;
  threadId: string;
  projectRootPath: string;
  state: DockerEnvironmentState;
  runtimeEnv: Record<string, string | undefined>;
  dockerBin?: string;
}): Promise<boolean> {
  const dockerBin = args.dockerBin ?? "docker";
  await ensureDockerEnvironmentImageAvailable({
    dockerBin,
    image: args.state.image,
    runtimeEnv: args.runtimeEnv,
    cwd: args.state.worktree.workspaceRoot,
  });
  const existed = await dockerContainerExistsAsync({
    dockerBin,
    containerName: args.state.containerName,
    runtimeEnv: args.runtimeEnv,
    workspaceRoot: args.state.worktree.workspaceRoot,
  });
  if (!existed) {
    await createDockerContainerAsync({
      dockerBin,
      projectRootPath: args.projectRootPath,
      state: args.state,
      runtimeEnv: args.runtimeEnv,
    });
  } else if (!await dockerContainerHasExpectedPortMappingAsync({
    dockerBin,
    containerName: args.state.containerName,
    agentHostPort: args.state.agentHostPort,
    agentContainerPort: args.state.agentContainerPort,
    runtimeEnv: args.runtimeEnv,
    workspaceRoot: args.state.worktree.workspaceRoot,
  })) {
    await removeDockerContainerAsync({
      dockerBin,
      containerName: args.state.containerName,
      runtimeEnv: args.runtimeEnv,
      workspaceRoot: args.state.worktree.workspaceRoot,
    });
    await createDockerContainerAsync({
      dockerBin,
      projectRootPath: args.projectRootPath,
      state: args.state,
      runtimeEnv: args.runtimeEnv,
    });
  }
  await ensureDockerContainerRunningAsync({
    dockerBin,
    containerName: args.state.containerName,
    runtimeEnv: args.runtimeEnv,
    workspaceRoot: args.state.worktree.workspaceRoot,
  });
  await verifyDockerGitRepositoryAccessibleAsync({
    dockerBin,
    containerName: args.state.containerName,
    mountPath: args.state.mountPath,
    runtimeEnv: args.runtimeEnv,
    workspaceRoot: args.state.worktree.workspaceRoot,
  });
  return !existed;
}

export async function removeDockerEnvironmentArtifacts(args: {
  state: DockerEnvironmentState;
  runtimeEnv: Record<string, string | undefined>;
  dockerBin?: string;
}): Promise<void> {
  await removeDockerContainerAsync({
    dockerBin: args.dockerBin ?? "docker",
    containerName: args.state.containerName,
    runtimeEnv: args.runtimeEnv,
    workspaceRoot: args.state.worktree.workspaceRoot,
  });
}
