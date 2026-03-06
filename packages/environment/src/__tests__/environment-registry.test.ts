import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  EnvironmentRegistry,
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
    expect(environment.rootPath).toBe("/tmp/project");
    expect(registry.list().map((item) => item.id)).toEqual(["local"]);
  });

  it("restores worktree environments from persisted state", () => {
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
          createWorktreeEnvironmentDefinition({ worktreeRootName: ".worktrees" }),
        );
      const environment = registry.create("worktree", {
        projectId: "proj-1",
        threadId: "thread-1",
        projectRootPath: projectRoot,
        runtimeEnv: {},
      });
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
      expect(restored.rootPath).toBe(join(worktreeRoot, "thread-1"));

      restored.dispose();
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
});
