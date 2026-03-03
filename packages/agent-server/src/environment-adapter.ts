import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  EnvironmentAdapter,
  EnvironmentInstructionsContext,
  EnvironmentPrepareContext,
  EnvironmentProvisioningEvent,
  EnvironmentSession,
  SystemEnvironmentInfo,
} from "@beanbag/agent-core";

const LOCAL_ENVIRONMENT_INFO: SystemEnvironmentInfo = {
  id: "local",
  displayName: "Local Workspace",
  description: "Run directly in the project root on the host machine.",
  capabilities: {
    isolatedFilesystem: false,
    ephemeralWorkspace: false,
    supportsCleanup: false,
  },
};

const WORKTREE_ENVIRONMENT_INFO: SystemEnvironmentInfo = {
  id: "worktree",
  displayName: "Git Worktree Workspace",
  description:
    "Provision an isolated per-thread git worktree when the project is a git repository.",
  capabilities: {
    isolatedFilesystem: true,
    ephemeralWorkspace: true,
    supportsCleanup: true,
  },
};

const ENV_SETUP_SCRIPT_NAME = ".bb-env-setup.sh";
const ENV_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const WORKTREE_GUIDED_WORKFLOW_INSTRUCTIONS =
  [
    "[Beanbag worktree workflow]",
    "- You are running inside a per-thread git worktree.",
    "- Commit your work frequently so it can be safely promoted/tested and not lost.",
    "- Preferred flow: iterate in this worktree -> promote to primary checkout for manual/E2E testing -> continue edits back in this worktree -> squash merge when done.",
  ].join("\n");

function toChildEnv(
  env: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  return env;
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

interface CommandRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: Error;
}

function runCommandAsync(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<CommandRunResult> {
  return new Promise<CommandRunResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: CommandRunResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore process termination failures.
        }
      }, opts.timeoutMs);
    }

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      finish({
        status: null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        error,
      });
    });

    child.on("close", (status) => {
      finish({
        status,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      });
    });
  });
}

async function runGitAsync(
  gitCommand: string,
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string }> {
  const result = await runCommandAsync(gitCommand, args, { cwd });
  return {
    ok: result.status === 0,
    stdout: result.stdout,
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

async function hasLocalBranchAsync(
  gitCommand: string,
  projectRoot: string,
  branch: string,
): Promise<boolean> {
  return (
    await runGitAsync(
      gitCommand,
      projectRoot,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    )
  ).ok;
}

function resolveWorktreeStartRef(
  gitCommand: string,
  projectRoot: string,
): string | undefined {
  if (hasLocalBranch(gitCommand, projectRoot, "main")) return "main";
  if (hasLocalBranch(gitCommand, projectRoot, "master")) return "master";
  const headBranch = runGit(gitCommand, projectRoot, ["symbolic-ref", "--short", "HEAD"]);
  if (headBranch.ok && headBranch.stdout.length > 0) {
    return headBranch.stdout;
  }
  return undefined;
}

async function resolveWorktreeStartRefAsync(
  gitCommand: string,
  projectRoot: string,
): Promise<string | undefined> {
  if (await hasLocalBranchAsync(gitCommand, projectRoot, "main")) return "main";
  if (await hasLocalBranchAsync(gitCommand, projectRoot, "master")) return "master";
  const headBranch = await runGitAsync(gitCommand, projectRoot, [
    "symbolic-ref",
    "--short",
    "HEAD",
  ]);
  if (headBranch.ok && headBranch.stdout.length > 0) {
    return headBranch.stdout;
  }
  return undefined;
}

function toWorktreeBranchName(threadId: string): string {
  const normalized = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = normalized.length > 0 ? normalized : "thread";
  return `bb/thread-${suffix}`;
}

function localSession(context: EnvironmentPrepareContext): EnvironmentSession {
  return {
    cwd: context.projectRootPath,
    env: {
      BB_WORKSPACE_ROOT: context.projectRootPath,
      BB_WORKSPACE_MODE: "local",
    },
    metadata: {
      mode: "local",
      workspaceRoot: context.projectRootPath,
    },
  };
}

type WorktreeFallbackReason = "missing-git-root" | "worktree-add-failed";

function localFallbackSession(
  context: EnvironmentPrepareContext,
  reason: WorktreeFallbackReason,
): EnvironmentSession {
  const fallback = localSession(context);
  return {
    ...fallback,
    env: {
      ...(fallback.env ?? {}),
      BB_WORKSPACE_MODE: "local-fallback",
    },
    metadata: {
      ...(fallback.metadata ?? {}),
      fallbackReason: reason,
    },
  };
}

export function createLocalEnvironmentAdapter(): EnvironmentAdapter {
  return {
    info: { ...LOCAL_ENVIRONMENT_INFO },
    prepare(context: EnvironmentPrepareContext): EnvironmentSession {
      return localSession(context);
    },
  };
}

export interface CreateWorktreeEnvironmentAdapterOptions {
  gitCommand?: string;
  worktreeRootName?: string;
}

const DEFAULT_WORKTREE_ROOT = "~/.beanbag/worktrees";

function expandHomeDirectory(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
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

function appendInstructions(
  currentInstructions: string | undefined,
  nextInstructions: string,
): string {
  const current = currentInstructions?.trim();
  const next = nextInstructions.trim();
  if (!current) return next;
  return `${current}\n\n${next}`;
}

function emitProvisioningEvent(
  context: EnvironmentPrepareContext,
  event: EnvironmentProvisioningEvent,
): void {
  context.onProvisioningEvent?.(event);
}

function normalizeDetail(message: string): string {
  return message.trim();
}

function runOptionalEnvSetupHook(context: EnvironmentPrepareContext, workspaceRoot: string): void {
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

  const command = "sh";
  const args = [scriptPath];

  const result = spawnSync(command, args, {
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
    const elapsedMs = Date.now() - startedAt;
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      const detail = `${ENV_SETUP_SCRIPT_NAME} timed out after 10 minutes`;
      emitProvisioningEvent(context, {
        type: "env-setup",
        status: "failed",
        scriptPath: ENV_SETUP_SCRIPT_NAME,
        workspaceRoot,
        timeoutMs: ENV_SETUP_TIMEOUT_MS,
        durationMs: elapsedMs,
        detail,
      });
      throw new Error(
        detail,
      );
    }
    const message = normalizeDetail(result.error.message);
    emitProvisioningEvent(context, {
      type: "env-setup",
      status: "failed",
      scriptPath: ENV_SETUP_SCRIPT_NAME,
      workspaceRoot,
      timeoutMs: ENV_SETUP_TIMEOUT_MS,
      durationMs: elapsedMs,
      detail: message,
    });
    throw new Error(`Failed to run ${ENV_SETUP_SCRIPT_NAME}: ${message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    const detail = normalizeDetail(stderr || stdout || "unknown error");
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

async function runOptionalEnvSetupHookAsync(
  context: EnvironmentPrepareContext,
  workspaceRoot: string,
): Promise<void> {
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

  const command = "sh";
  const args = [scriptPath];
  const result = await runCommandAsync(command, args, {
    cwd: workspaceRoot,
    env: toChildEnv({
      ...context.runtimeEnv,
      BB_PROJECT_ID: context.projectId,
      BB_THREAD_ID: context.threadId,
      BB_WORKSPACE_ROOT: workspaceRoot,
      BB_WORKSPACE_MODE: "worktree",
      BB_ENV_SETUP_TIMEOUT_MS: String(ENV_SETUP_TIMEOUT_MS),
    }),
    timeoutMs: ENV_SETUP_TIMEOUT_MS,
  });

  if (result.error) {
    const elapsedMs = Date.now() - startedAt;
    const message = normalizeDetail(result.error.message);
    emitProvisioningEvent(context, {
      type: "env-setup",
      status: "failed",
      scriptPath: ENV_SETUP_SCRIPT_NAME,
      workspaceRoot,
      timeoutMs: ENV_SETUP_TIMEOUT_MS,
      durationMs: elapsedMs,
      detail: message,
    });
    throw new Error(`Failed to run ${ENV_SETUP_SCRIPT_NAME}: ${message}`);
  }
  if (result.timedOut) {
    const detail = `${ENV_SETUP_SCRIPT_NAME} timed out after 10 minutes`;
    emitProvisioningEvent(context, {
      type: "env-setup",
      status: "failed",
      scriptPath: ENV_SETUP_SCRIPT_NAME,
      workspaceRoot,
      timeoutMs: ENV_SETUP_TIMEOUT_MS,
      durationMs: Date.now() - startedAt,
      detail,
    });
    throw new Error(detail);
  }
  if (result.status !== 0) {
    const detail = normalizeDetail(result.stderr || result.stdout || "unknown error");
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

export function createWorktreeEnvironmentAdapter(
  opts?: CreateWorktreeEnvironmentAdapterOptions,
): EnvironmentAdapter {
  const gitCommand = opts?.gitCommand ?? process.env.BEANBAG_GIT_COMMAND ?? "git";
  const worktreeRootName = opts?.worktreeRootName ??
    process.env.BEANBAG_WORKTREE_ROOT ??
    DEFAULT_WORKTREE_ROOT;

  return {
    info: { ...WORKTREE_ENVIRONMENT_INFO },
    prepare(context: EnvironmentPrepareContext): EnvironmentSession {
      const projectRoot = context.projectRootPath;
      const gitDir = join(projectRoot, ".git");
      if (!existsSync(gitDir)) {
        return localFallbackSession(context, "missing-git-root");
      }

      const { root: configuredWorktreeRoot, isGlobalRoot } =
        resolveConfiguredWorktreeRoot(projectRoot, worktreeRootName);
      const worktreeRoot = isGlobalRoot
        ? resolve(configuredWorktreeRoot, context.projectId)
        : configuredWorktreeRoot;
      const workspaceRoot = resolve(worktreeRoot, context.threadId);
      mkdirSync(worktreeRoot, { recursive: true });

      if (!existsSync(workspaceRoot)) {
        const worktreeBranch = toWorktreeBranchName(context.threadId);
        const startRef = resolveWorktreeStartRef(gitCommand, projectRoot);
        const branchAddArgs = hasLocalBranch(gitCommand, projectRoot, worktreeBranch)
          ? ["worktree", "add", workspaceRoot, worktreeBranch]
          : [
              "worktree",
              "add",
              "-b",
              worktreeBranch,
              workspaceRoot,
              ...(startRef ? [startRef] : []),
            ];
        const branchAddResult = spawnSync(
          gitCommand,
          branchAddArgs,
          {
            cwd: projectRoot,
            env: toChildEnv(context.runtimeEnv),
            stdio: "pipe",
          },
        );
        const addResult = branchAddResult.status === 0
          ? branchAddResult
          : spawnSync(
              gitCommand,
              ["worktree", "add", "--detach", workspaceRoot],
              {
                cwd: projectRoot,
                env: toChildEnv(context.runtimeEnv),
                stdio: "pipe",
              },
        );
        if (addResult.status !== 0) {
          return localFallbackSession(context, "worktree-add-failed");
        }
        runOptionalEnvSetupHook(context, workspaceRoot);
      }

      return {
        cwd: workspaceRoot,
        env: {
          BB_WORKSPACE_ROOT: workspaceRoot,
          BB_WORKSPACE_MODE: "worktree",
        },
        metadata: {
          mode: "worktree",
          workspaceRoot,
        },
        cleanup: () => {
          spawnSync(gitCommand, ["worktree", "remove", "--force", workspaceRoot], {
            cwd: projectRoot,
            env: toChildEnv(context.runtimeEnv),
            stdio: "pipe",
          });
          rmSync(workspaceRoot, { recursive: true, force: true });
        },
      };
    },
    async prepareAsync(context: EnvironmentPrepareContext): Promise<EnvironmentSession> {
      const projectRoot = context.projectRootPath;
      const gitDir = join(projectRoot, ".git");
      if (!existsSync(gitDir)) {
        return localFallbackSession(context, "missing-git-root");
      }

      const { root: configuredWorktreeRoot, isGlobalRoot } =
        resolveConfiguredWorktreeRoot(projectRoot, worktreeRootName);
      const worktreeRoot = isGlobalRoot
        ? resolve(configuredWorktreeRoot, context.projectId)
        : configuredWorktreeRoot;
      const workspaceRoot = resolve(worktreeRoot, context.threadId);
      mkdirSync(worktreeRoot, { recursive: true });

      if (!existsSync(workspaceRoot)) {
        const worktreeBranch = toWorktreeBranchName(context.threadId);
        const startRef = await resolveWorktreeStartRefAsync(gitCommand, projectRoot);
        const branchAddArgs = await hasLocalBranchAsync(gitCommand, projectRoot, worktreeBranch)
          ? ["worktree", "add", workspaceRoot, worktreeBranch]
          : [
              "worktree",
              "add",
              "-b",
              worktreeBranch,
              workspaceRoot,
              ...(startRef ? [startRef] : []),
            ];
        const branchAddResult = await runCommandAsync(gitCommand, branchAddArgs, {
          cwd: projectRoot,
          env: toChildEnv(context.runtimeEnv),
        });
        const addResult = branchAddResult.status === 0
          ? branchAddResult
          : await runCommandAsync(
              gitCommand,
              ["worktree", "add", "--detach", workspaceRoot],
              {
                cwd: projectRoot,
                env: toChildEnv(context.runtimeEnv),
              },
            );
        if (addResult.status !== 0) {
          return localFallbackSession(context, "worktree-add-failed");
        }
      }
      await runOptionalEnvSetupHookAsync(context, workspaceRoot);

      return {
        cwd: workspaceRoot,
        env: {
          BB_WORKSPACE_ROOT: workspaceRoot,
          BB_WORKSPACE_MODE: "worktree",
        },
        metadata: {
          mode: "worktree",
          workspaceRoot,
        },
        cleanup: async () => {
          await runCommandAsync(
            gitCommand,
            ["worktree", "remove", "--force", workspaceRoot],
            {
              cwd: projectRoot,
              env: toChildEnv(context.runtimeEnv),
            },
          );
          rmSync(workspaceRoot, { recursive: true, force: true });
        },
      };
    },
    customizeDeveloperInstructions(
      currentInstructions: string | undefined,
      context: EnvironmentInstructionsContext,
    ): string | undefined {
      if (context.mode !== "worktree") {
        return currentInstructions;
      }
      return appendInstructions(
        currentInstructions,
        WORKTREE_GUIDED_WORKFLOW_INSTRUCTIONS,
      );
    },
  };
}
