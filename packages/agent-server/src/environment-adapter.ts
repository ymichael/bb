import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  EnvironmentAdapter,
  EnvironmentPrepareContext,
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

function toChildEnv(
  env: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  return env;
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

export function createWorktreeEnvironmentAdapter(
  opts?: CreateWorktreeEnvironmentAdapterOptions,
): EnvironmentAdapter {
  const gitCommand = opts?.gitCommand ?? process.env.BEANBAG_GIT_COMMAND ?? "git";
  const worktreeRootName = opts?.worktreeRootName ?? ".beanbag/worktrees";

  return {
    info: { ...WORKTREE_ENVIRONMENT_INFO },
    prepare(context: EnvironmentPrepareContext): EnvironmentSession {
      const fallback = localSession(context);
      const projectRoot = context.projectRootPath;
      const gitDir = join(projectRoot, ".git");
      if (!existsSync(gitDir)) {
        return {
          ...fallback,
          env: {
            ...(fallback.env ?? {}),
            BB_WORKSPACE_MODE: "local-fallback",
          },
          metadata: {
            ...(fallback.metadata ?? {}),
            fallbackReason: "missing-git-root",
          },
        };
      }

      const worktreeRoot = resolve(projectRoot, worktreeRootName);
      const workspaceRoot = resolve(worktreeRoot, context.threadId);
      mkdirSync(worktreeRoot, { recursive: true });

      if (!existsSync(workspaceRoot)) {
        const addResult = spawnSync(
          gitCommand,
          ["worktree", "add", "--detach", workspaceRoot],
          {
            cwd: projectRoot,
            env: toChildEnv(context.runtimeEnv),
            stdio: "pipe",
          },
        );
        if (addResult.status !== 0) {
          return {
            ...fallback,
            env: {
              ...(fallback.env ?? {}),
              BB_WORKSPACE_MODE: "local-fallback",
            },
            metadata: {
              ...(fallback.metadata ?? {}),
              fallbackReason: "worktree-add-failed",
            },
          };
        }
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
  };
}
