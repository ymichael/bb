import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { IEnvironment } from "../contracts.js";
import { createDockerEnvironmentDefinition } from "../docker-environment.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const WORKSPACE_ROOT = resolve(__dirname, "..", "..", "..", "..");

const tempDirs: string[] = [];
const environments: IEnvironment[] = [];

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
  execFileSync("pnpm", ["--filter", "@beanbag/environment-agent", "build"], {
    cwd: WORKSPACE_ROOT,
    stdio: "pipe",
  });
}

async function createDockerEnvironmentForTest() {
  ensureEnvironmentAgentBundle();

  const repoRoot = makeTempDir("bb-docker-integration-repo-");
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.name", "Beanbag Test");
  git(repoRoot, "config", "user.email", "beanbag-test@example.com");
  writeFileSync(join(repoRoot, "README.md"), "hello\n", "utf8");
  git(repoRoot, "add", "README.md");
  git(repoRoot, "commit", "-m", "init");

  const environment = createDockerEnvironmentDefinition().create({
    projectId: `project-${Date.now()}`,
    threadId: `thread-${Date.now()}`,
    projectRootPath: repoRoot,
    runtimeEnv: {},
  });
  environments.push(environment);
  await environment.prepare?.();
  return environment;
}

afterEach(async () => {
  for (const environment of environments.splice(0)) {
    await environment.dispose();
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

      const commands = [
        ["node", "--version"],
        ["git", "--version"],
        ["bun", "--version"],
        ["pnpm", "--version"],
        ["docker", "--version"],
        ["codex", "--help"],
      ] as const;

      for (const [command, arg] of commands) {
        const result = environment.run(command, [arg], {
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
