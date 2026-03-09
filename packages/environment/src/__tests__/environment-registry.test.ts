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
  createWorktreeEnvironmentDefinition,
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

    try {
      git(projectRoot, "init", "-b", "main");
      git(projectRoot, "config", "user.name", "Beanbag");
      git(projectRoot, "config", "user.email", "beanbag@example.com");
      spawnSync("sh", ["-lc", "printf 'hello\\n' > README.md"], { cwd: projectRoot });
      git(projectRoot, "add", "README.md");
      git(projectRoot, "commit", "-m", "init");

      const registry = new EnvironmentRegistry()
        .register(createLocalEnvironmentDefinition())
        .register(
          createWorktreeEnvironmentDefinition({
            worktreeRootName: ".worktrees",
            manageEnvironmentAgent: false,
          }),
        );
      const environment = registry.create("worktree", {
        projectId: "proj-1",
        threadId: "thread-1",
        projectRootPath: projectRoot,
        runtimeEnv: {},
      });
      await environment.prepare?.();
      const restored = registry.restore(
        {
          kind: "worktree",
          state: environment.serialize(),
        },
        {
          projectId: "proj-1",
          threadId: "thread-1",
          projectRootPath: projectRoot,
          runtimeEnv: {},
        },
      );

      expect(restored.kind).toBe("worktree");
      expect(restored.getWorkspaceRootUnsafe()).toBe(join(worktreeRoot, "thread-1"));

      await restored.dispose();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("fails loudly when a persisted worktree is missing", () => {
    const registry = new EnvironmentRegistry()
      .register(createLocalEnvironmentDefinition())
      .register(createWorktreeEnvironmentDefinition());

    expect(() =>
      registry.restore(
        {
          kind: "worktree",
          state: {
            workspaceRoot: "/tmp/does-not-exist",
            branchName: "bb/thread-test",
          },
        },
        {
          projectId: "proj-1",
          threadId: "thread-1",
          projectRootPath: "/tmp/project",
          runtimeEnv: {},
        },
      )).toThrow(/Worktree workspace is unavailable/);
  });

  it("creates docker environments with a direct environment-agent target", () => {
    const projectRoot = makeTempDir("bb-docker-env-project-");

    try {
      git(projectRoot, "init", "-b", "main");
      git(projectRoot, "config", "user.name", "Beanbag");
      git(projectRoot, "config", "user.email", "beanbag@example.com");
      spawnSync("sh", ["-lc", "printf 'hello\\n' > README.md"], { cwd: projectRoot });
      git(projectRoot, "add", "README.md");
      git(projectRoot, "commit", "-m", "init");

      const registry = new EnvironmentRegistry()
        .register(createLocalEnvironmentDefinition())
        .register(
          createDockerEnvironmentDefinition({
            image: "beanbag/test-image:latest",
            worktree: { worktreeRootName: ".worktrees" },
          }),
        );

      const environment = registry.create("docker", {
        projectId: "proj-1",
        threadId: "thread-1",
        projectRootPath: projectRoot,
        runtimeEnv: {
          BEANBAG_ENVIRONMENT_AGENT_BASE_URL: "http://127.0.0.1:4312",
          BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN: "secret-token",
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

    expect(registry.list().map((item) => item.id)).toEqual([
      "local",
      "worktree",
      "docker",
    ]);
  });
});
