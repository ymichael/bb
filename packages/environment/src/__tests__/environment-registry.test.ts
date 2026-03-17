import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  EnvironmentRegistry,
  createDefaultEnvironmentRegistry,
  createDockerEnvironmentDefinition,
  createLocalEnvironmentDefinition,
  ensureLocalGitWorkspace,
  type LocalGitWorkspaceState,
} from "../index.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
}

describe("EnvironmentRegistry", () => {
  it("creates local environments and lists registered infos", () => {
    const registry = new EnvironmentRegistry().register(createLocalEnvironmentDefinition());
    const environment = registry.create("local", {
      projectId: "proj-1",
      threadId: "thread-1",
      projectRootPath: "/tmp/project",
      runtimeEnv: {},
    });

    expect(environment.kind).toBe("local");
    expect(environment.getWorkspaceRootUnsafe()).toBe("/tmp/project");
    expect(registry.list().map((item) => item.id)).toEqual(["local"]);
  });

  it("restores worktree environments from persisted state", async () => {
    const projectRoot = makeTempDir("bb-env-project-");
    const worktreeRoot = join(projectRoot, ".worktrees");
    const projectId = `proj-${Date.now()}`;
    const threadId = `thread-${Date.now()}`;

    try {
      git(projectRoot, "init", "-b", "main");
      git(projectRoot, "config", "user.name", "BB");
      git(projectRoot, "config", "user.email", "bb@example.com");
      spawnSync("sh", ["-lc", "printf 'hello\\n' > README.md"], { cwd: projectRoot });
      git(projectRoot, "add", "README.md");
      git(projectRoot, "commit", "-m", "init");

      const registry = new EnvironmentRegistry().register(
        createLocalEnvironmentDefinition({
          worktree: {
            worktreeRootName: ".worktrees",
            manageEnvironmentAgent: false,
          },
        }),
      );
      const environment = registry.create("local", {
        projectId,
        threadId,
        projectRootPath: projectRoot,
        environmentProperties: {
          provisioningSystemKind: "worktree",
          location: "localhost",
          workspaceKind: "worktree",
        },
          runtimeEnv: {},
      });
      await ensureLocalGitWorkspace({
        projectRootPath: projectRoot,
        state: environment.serialize() as LocalGitWorkspaceState,
        runtimeEnv: {},
      });
      await environment.prepare?.();
      const restored = registry.restore(
        {
          kind: "local",
          state: environment.serialize(),
        },
        {
          projectId,
          threadId,
          projectRootPath: projectRoot,
          environmentProperties: {
            provisioningSystemKind: "worktree",
            location: "localhost",
            workspaceKind: "worktree",
          },
          runtimeEnv: {},
        },
      );

      expect(restored.kind).toBe("local");
      expect(restored.getWorkspaceRootUnsafe()).toBe(join(worktreeRoot, threadId));

      await restored.destroy();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("restores direct-path git worktrees through the worktree-capable local runtime", async () => {
    const projectRoot = makeTempDir("bb-env-project-");
    const worktreeRoot = join(projectRoot, ".worktrees");
    const threadId = `thread-${Date.now()}`;

    try {
      git(projectRoot, "init", "-b", "main");
      git(projectRoot, "config", "user.name", "BB");
      git(projectRoot, "config", "user.email", "bb@example.com");
      spawnSync("sh", ["-lc", "printf 'hello\\n' > README.md"], { cwd: projectRoot });
      git(projectRoot, "add", "README.md");
      git(projectRoot, "commit", "-m", "init");
      git(projectRoot, "worktree", "add", join(worktreeRoot, threadId), "-b", "feature/direct-path");

      const registry = new EnvironmentRegistry().register(
        createLocalEnvironmentDefinition({
          worktree: {
            worktreeRootName: ".worktrees",
            manageEnvironmentAgent: false,
          },
        }),
      );
      const restored = registry.restore(
        {
          kind: "local",
          state: {
            workspaceRoot: join(worktreeRoot, threadId),
            branchName: "feature/direct-path",
          },
        },
        {
          projectId: "proj-1",
          threadId,
          projectRootPath: projectRoot,
          environmentProperties: {
            provisioningSystemKind: "direct-path",
            location: "localhost",
            workspaceKind: "worktree",
          },
          runtimeEnv: {},
        },
      );

      expect(restored.kind).toBe("local");
      expect(restored.getWorkspaceRootUnsafe()).toBe(join(worktreeRoot, threadId));
      expect(restored.supportsPromoteToActiveWorkspace()).toBe(true);
      expect(restored.supportsDemoteFromActiveWorkspace()).toBe(true);
      expect(restored.supportsSquashMergeIntoDefaultBranch()).toBe(true);

      await restored.destroy();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("fails loudly when a persisted worktree is missing", () => {
    const registry = new EnvironmentRegistry().register(
      createLocalEnvironmentDefinition({
        worktree: {
          manageEnvironmentAgent: false,
        },
      }),
    );

    expect(() =>
      registry.restore(
        {
          kind: "local",
          state: {
            workspaceRoot: "/tmp/does-not-exist",
            branchName: "bb/thread-test",
          },
        },
        {
          projectId: "proj-1",
          threadId: "thread-1",
          projectRootPath: "/tmp/project",
          environmentProperties: {
            provisioningSystemKind: "worktree",
            location: "localhost",
            workspaceKind: "worktree",
          },
          runtimeEnv: {},
        },
      )).toThrow(/Worktree workspace is unavailable/);
  });

  it("creates docker environments with a direct environment-agent target", () => {
    const projectRoot = makeTempDir("bb-docker-env-project-");

    try {
      git(projectRoot, "init", "-b", "main");
      git(projectRoot, "config", "user.name", "BB");
      git(projectRoot, "config", "user.email", "bb@example.com");
      spawnSync("sh", ["-lc", "printf 'hello\\n' > README.md"], { cwd: projectRoot });
      git(projectRoot, "add", "README.md");
      git(projectRoot, "commit", "-m", "init");

      const registry = new EnvironmentRegistry()
        .register(createLocalEnvironmentDefinition())
        .register(
          createDockerEnvironmentDefinition({
            image: "bb/test-image:latest",
            worktree: { worktreeRootName: ".worktrees" },
          }),
        );

      const environment = registry.create("docker", {
        projectId: "proj-1",
        threadId: "thread-1",
        projectRootPath: projectRoot,
        runtimeEnv: {
          BB_ENV_DAEMON_BASE_URL: "http://127.0.0.1:4312",
          BB_ENV_DAEMON_AUTH_TOKEN: "secret-token",
        },
      });

      expect(environment.kind).toBe("docker");
      expect(environment.getAgentConnectionTarget()).toEqual({
        transport: "http",
        baseUrl: "http://127.0.0.1:4312",
        headers: {
          authorization: "Bearer secret-token",
        },
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("includes docker in the default environment registry", () => {
    const registry = createDefaultEnvironmentRegistry();

    expect(registry.list().map((item) => item.id)).toEqual(["local", "docker"]);
  });
});
