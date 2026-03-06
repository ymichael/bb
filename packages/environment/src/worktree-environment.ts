import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  EnvironmentProvisioningEvent,
  SystemEnvironmentInfo,
} from "@beanbag/agent-core";
import type {
  CreateEnvironmentContext,
  EnvironmentDefinition,
  IEnvironment,
} from "./contracts.js";
import { runCommand } from "./process.js";

export interface WorktreeEnvironmentState {
  workspaceRoot: string;
  branchName: string;
}

export interface CreateWorktreeEnvironmentDefinitionOptions {
  gitCommand?: string;
  worktreeRootName?: string;
}

const WORKTREE_ENVIRONMENT_INFO: SystemEnvironmentInfo = {
  id: "worktree",
  displayName: "Git Worktree Workspace",
  description:
    "Provision an isolated per-thread git worktree when the project is a git repository.",
};

const ENV_SETUP_SCRIPT_NAME = ".bb-env-setup.sh";
const ENV_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_WORKTREE_ROOT = "~/.beanbag/worktrees";

function toChildEnv(
  env: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  return env;
}

function emitProvisioningEvent(
  context: CreateEnvironmentContext,
  event: EnvironmentProvisioningEvent,
): void {
  context.onProvisioningEvent?.(event);
}

function normalizeDetail(message: string | Buffer): string {
  return (typeof message === "string" ? message : message.toString("utf8")).trim();
}

function runGit(
  gitCommand: string,
  cwd: string,
  args: string[],
): { ok: boolean; stdout: string } {
  const result = spawnSync(gitCommand, args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
  };
}

function hasLocalBranch(
  gitCommand: string,
  projectRoot: string,
  branch: string,
): boolean {
  return runGit(
    gitCommand,
    projectRoot,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
  ).ok;
}

function resolveWorktreeStartRef(
  gitCommand: string,
  projectRoot: string,
): string | undefined {
  if (hasLocalBranch(gitCommand, projectRoot, "main")) return "main";
  if (hasLocalBranch(gitCommand, projectRoot, "master")) return "master";
  const headBranch = runGit(gitCommand, projectRoot, ["symbolic-ref", "--short", "HEAD"]);
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

function runOptionalEnvSetupHook(
  context: CreateEnvironmentContext,
  workspaceRoot: string,
): void {
  const scriptPath = resolve(workspaceRoot, ENV_SETUP_SCRIPT_NAME);
  if (!existsSync(scriptPath)) return;
  const startedAt = Date.now();
  emitProvisioningEvent(context, {
    type: "env-setup",
    status: "started",
    scriptPath: ENV_SETUP_SCRIPT_NAME,
    workspaceRoot,
    timeoutMs: ENV_SETUP_TIMEOUT_MS,
  });

  const result = spawnSync("sh", [scriptPath], {
    cwd: workspaceRoot,
    env: toChildEnv({
      ...context.runtimeEnv,
      BB_PROJECT_ID: context.projectId,
      BB_THREAD_ID: context.threadId,
      BB_WORKSPACE_ROOT: workspaceRoot,
      BB_WORKSPACE_MODE: "worktree",
      BB_ENV_SETUP_TIMEOUT_MS: String(ENV_SETUP_TIMEOUT_MS),
    }),
    stdio: "pipe",
    encoding: "utf-8",
    timeout: ENV_SETUP_TIMEOUT_MS,
  });

  if (result.error) {
    const detail = normalizeDetail(result.error.message);
    emitProvisioningEvent(context, {
      type: "env-setup",
      status: "failed",
      scriptPath: ENV_SETUP_SCRIPT_NAME,
      workspaceRoot,
      timeoutMs: ENV_SETUP_TIMEOUT_MS,
      durationMs: Date.now() - startedAt,
      detail,
    });
    throw new Error(`Failed to run ${ENV_SETUP_SCRIPT_NAME}: ${detail}`);
  }
  if (result.status !== 0) {
    const detail = summarizeSpawnSyncFailure(result);
    emitProvisioningEvent(context, {
      type: "env-setup",
      status: "failed",
      scriptPath: ENV_SETUP_SCRIPT_NAME,
      workspaceRoot,
      timeoutMs: ENV_SETUP_TIMEOUT_MS,
      durationMs: Date.now() - startedAt,
      detail,
    });
    throw new Error(`${ENV_SETUP_SCRIPT_NAME} failed: ${detail}`);
  }

  emitProvisioningEvent(context, {
    type: "env-setup",
    status: "completed",
    scriptPath: ENV_SETUP_SCRIPT_NAME,
    workspaceRoot,
    timeoutMs: ENV_SETUP_TIMEOUT_MS,
    durationMs: Date.now() - startedAt,
  });
}

class WorktreeEnvironment implements IEnvironment {
  readonly kind = "worktree";
  readonly info = { ...WORKTREE_ENVIRONMENT_INFO };
  readonly rootPath: string;
  readonly env: Record<string, string | undefined>;

  constructor(
    private readonly gitCommand: string,
    private readonly projectRoot: string,
    private readonly state: WorktreeEnvironmentState,
  ) {
    this.rootPath = state.workspaceRoot;
    this.env = {
      BB_WORKSPACE_ROOT: state.workspaceRoot,
      BB_WORKSPACE_MODE: "worktree",
    };
  }

  serialize(): WorktreeEnvironmentState {
    return { ...this.state };
  }

  dispose(): void {
    spawnSync(
      this.gitCommand,
      ["worktree", "remove", "--force", this.state.workspaceRoot],
      {
        cwd: this.projectRoot,
        stdio: "pipe",
      },
    );
    rmSync(this.state.workspaceRoot, { recursive: true, force: true });
  }

  run(command: string, args: string[]) {
    return runCommand(command, args, {
      cwd: this.rootPath,
      env: this.env,
    });
  }
}

export function createWorktreeEnvironmentDefinition(
  opts?: CreateWorktreeEnvironmentDefinitionOptions,
): EnvironmentDefinition<WorktreeEnvironmentState> {
  const gitCommand = opts?.gitCommand ?? process.env.BEANBAG_GIT_COMMAND ?? "git";
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
        const startRef = resolveWorktreeStartRef(gitCommand, projectRoot);
        const branchAddArgs = hasLocalBranch(gitCommand, projectRoot, branchName)
          ? ["worktree", "add", workspaceRoot, branchName]
          : ["worktree", "add", "-b", branchName, workspaceRoot, ...(startRef ? [startRef] : [])];
        const branchAddResult = spawnSync(gitCommand, branchAddArgs, {
          cwd: projectRoot,
          env: toChildEnv(context.runtimeEnv),
          stdio: "pipe",
        });
        const addResult = branchAddResult.status === 0
          ? branchAddResult
          : spawnSync(gitCommand, ["worktree", "add", "--detach", workspaceRoot], {
              cwd: projectRoot,
              env: toChildEnv(context.runtimeEnv),
              stdio: "pipe",
            });
        if (addResult.status !== 0) {
          throw new Error(`Failed to create worktree: ${summarizeSpawnSyncFailure(addResult)}`);
        }
        runOptionalEnvSetupHook(context, workspaceRoot);
      }

      return new WorktreeEnvironment(gitCommand, projectRoot, {
        workspaceRoot,
        branchName,
      });
    },
    restore(state: WorktreeEnvironmentState, context: CreateEnvironmentContext): IEnvironment {
      if (!existsSync(state.workspaceRoot)) {
        throw new Error(`Worktree workspace is unavailable: ${state.workspaceRoot}`);
      }
      return new WorktreeEnvironment(gitCommand, context.projectRootPath, state);
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
