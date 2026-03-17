import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { IEnvironment } from "../contracts.js";
import {
  createDockerEnvironmentDefinition,
  ensureDockerEnvironmentArtifacts,
  removeDockerEnvironmentArtifacts,
  resolveDockerEnvironmentState,
  type DockerEnvironmentState,
} from "../docker-environment.js";
import {
  ensureLocalGitWorkspace,
  removeLocalGitWorkspace,
  type LocalGitWorkspaceState,
} from "../local-git-workspace.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const WORKSPACE_ROOT = resolve(__dirname, "..", "..", "..", "..");

const tempDirs: string[] = [];
const environments: Array<{
  environment: IEnvironment;
  projectRoot: string;
  dockerState: DockerEnvironmentState;
}> = [];

function makeTempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function hasDocker(): boolean {
  const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0;
}

function ensureEnvironmentAgentBundle(): void {
  execFileSync("pnpm", ["--filter", "@bb/environment-daemon", "build"], {
    cwd: WORKSPACE_ROOT,
    stdio: "pipe",
  });
}

async function createDockerEnvironmentForTest() {
  ensureEnvironmentAgentBundle();

  const repoRoot = makeTempDir("bb-docker-integration-repo-");
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.name", "BB Test");
  git(repoRoot, "config", "user.email", "bb-test@example.com");
  writeFileSync(join(repoRoot, "README.md"), "hello\n", "utf8");
  git(repoRoot, "add", "README.md");
  git(repoRoot, "commit", "-m", "init");

  const projectId = `project-${Date.now()}`;
  const threadId = `thread-${Date.now()}`;
  const definition = createDockerEnvironmentDefinition();
  const seed = definition.create({
    projectId,
    threadId,
    projectRootPath: repoRoot,
    runtimeEnv: {},
  });
  const seedState = seed.serialize() as DockerEnvironmentState;
  await ensureLocalGitWorkspace({
    projectRootPath: repoRoot,
    state: seedState.worktree as LocalGitWorkspaceState,
    runtimeEnv: {},
  });
  const dockerState = await resolveDockerEnvironmentState({
    projectId,
    threadId,
    runtimeEnv: {},
    worktree: seedState.worktree,
  });
  await ensureDockerEnvironmentArtifacts({
    projectId,
    threadId,
    projectRootPath: repoRoot,
    state: dockerState,
    runtimeEnv: {},
  });
  const environment = definition.restore(dockerState, {
    projectId,
    threadId,
    projectRootPath: repoRoot,
    runtimeEnv: {},
  });
  environments.push({ environment, projectRoot: repoRoot, dockerState });
  await environment.prepare?.();
  return environment;
}

afterEach(async () => {
  for (const entry of environments.splice(0)) {
    await entry.environment.destroy();
    await removeDockerEnvironmentArtifacts({
      state: entry.dockerState,
      runtimeEnv: {},
    });
    await removeLocalGitWorkspace({
      projectRootPath: entry.projectRoot,
      workspaceRoot: entry.dockerState.worktree.workspaceRoot,
      runtimeEnv: {},
    });
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!hasDocker())("DockerEnvironment integration", () => {
  it(
    "starts an in-container environment-agent and exposes the baseline toolchain",
    async () => {
      const environment = await createDockerEnvironmentForTest();
      const target = environment.getAgentConnectionTarget();

      expect(target.transport).toBe("http");
      const statusResponse = await fetch(`${target.baseUrl}/control/status`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(target.headers ?? {}),
        },
        body: "{}",
      });
      expect(statusResponse.status).toBe(200);

      const gitTopLevel = await environment.run("git", ["rev-parse", "--show-toplevel"], {
        rawOutput: true,
        timeoutMs: 20_000,
      });
      expect(gitTopLevel.exitCode).toBe(0);
      expect(gitTopLevel.stdout.trim()).toBe("/workspace");

      const gitDir = await environment.run("git", ["rev-parse", "--git-dir"], {
        rawOutput: true,
        timeoutMs: 20_000,
      });
      expect(gitDir.exitCode).toBe(0);
      expect(gitDir.stdout.trim().length).toBeGreaterThan(0);

      const commands = [
        ["node", "--version"],
        ["git", "--version"],
        ["bun", "--version"],
        ["pnpm", "--version"],
        ["docker", "--version"],
        ["codex", "--help"],
      ] as const;

      for (const [command, arg] of commands) {
        const result = await environment.run(command, [arg], {
          rawOutput: true,
          timeoutMs: 20_000,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
      }
    },
    120_000,
  );
});
