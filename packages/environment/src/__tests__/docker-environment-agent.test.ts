import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DOCKER_ENVIRONMENT_IMAGE,
  ensureManagedDockerEnvironmentAgent,
  resolveDefaultDockerEnvironmentAssetsRoot,
  resolveDockerEnvironmentAgentArtifactEntry,
  resolveDockerEnvironmentImage,
  resolveManagedDockerEnvironmentAgentTarget,
} from "../docker-environment-agent.js";

const tempDirs: string[] = [];
const cleanupPaths: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("docker environment-agent helper", () => {
  it("resolves the repo docker assets root", () => {
    const assetsRoot = resolveDefaultDockerEnvironmentAssetsRoot();

    expect(existsSync(join(assetsRoot, "Dockerfile"))).toBe(true);
    const dockerfile = readFileSync(join(assetsRoot, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("FROM node:22-bookworm-slim");
    expect(dockerfile).toContain("git");
    expect(dockerfile).toContain("docker-ce-cli");
    expect(dockerfile).toContain("curl -fsSL https://bun.sh/install | bash");
    expect(dockerfile).toContain("corepack prepare pnpm@9.15.0 --activate");
  });

  it("resolves the built environment-agent artifact entry", () => {
    const artifactEntry = fileURLToPath(
      new URL("../../../environment-agent/dist/bin/environment-agent.js", import.meta.url),
    );
    mkdirSync(dirname(artifactEntry), { recursive: true });
    if (!existsSync(artifactEntry)) {
      writeFileSync(artifactEntry, "console.log('agent')\n", "utf8");
    }
    const entry = resolveDockerEnvironmentAgentArtifactEntry();

    expect(entry.endsWith("/packages/environment-agent/dist/bin/environment-agent.js")).toBe(true);
    expect(existsSync(entry)).toBe(true);
  });

  it("falls back to the default local image tag", () => {
    expect(
      resolveDockerEnvironmentImage({
        runtimeEnv: {},
      }),
    ).toBe(DEFAULT_DOCKER_ENVIRONMENT_IMAGE);
  });

  it("installs and starts the environment-agent in the container", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const workspaceRoot = makeTempDir("bb-docker-agent-workspace-");
    const artifactRoot = makeTempDir("bb-docker-agent-artifact-");
    const artifactEntry = join(artifactRoot, "dist", "bin", "environment-agent.js");
    mkdirSync(dirname(artifactEntry), { recursive: true });
    writeFileSync(artifactEntry, "console.log('agent')\n", "utf8");

    await ensureManagedDockerEnvironmentAgent(
      {
        workspaceRootPath: workspaceRoot,
        threadId: "thread-1",
        projectId: "project-1",
        environmentId: "docker",
        runtimeEnv: {
          BEANBAG_DAEMON_URL: "http://127.0.0.1:9000",
        },
        dockerBin: "docker",
        containerName: "beanbag-thread-thread-1",
        hostPort: 4311,
      },
      {
        run(command, args) {
          commands.push({ command, args });
          return {
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
        waitForAgent: async () => {},
        generateAuthToken: () => "auth-token",
        resolveArtifactEntry: () => artifactEntry,
      },
    );

    expect(commands).toEqual([
      {
        command: "docker",
        args: [
          "exec",
          "beanbag-thread-thread-1",
          "mkdir",
          "-p",
          "/opt/beanbag/environment-agent/dist",
        ],
      },
      {
        command: "docker",
        args: [
          "cp",
          `${join(artifactRoot, "dist")}/.`,
          "beanbag-thread-thread-1:/opt/beanbag/environment-agent/dist",
        ],
      },
      {
        command: "docker",
        args: [
          "exec",
          "-d",
          "-e",
          "BB_THREAD_ID=thread-1",
          "-e",
          "BB_PROJECT_ID=project-1",
          "-e",
          "BB_ENVIRONMENT_ID=docker",
          "-e",
          "BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN=auth-token",
          "-e",
          "BEANBAG_DAEMON_URL=http://127.0.0.1:9000",
          "beanbag-thread-thread-1",
          "node",
          "/opt/beanbag/environment-agent/dist/bin/environment-agent.js",
          "--http-host",
          "0.0.0.0",
          "--http-port",
          "4310",
        ],
      },
    ]);

    expect(
      resolveManagedDockerEnvironmentAgentTarget({
        projectId: "project-1",
        threadId: "thread-1",
        environmentId: "docker",
        runtimeEnv: {},
        providerLaunch: {
          command: "docker",
          args: ["exec", "-i", "beanbag-thread-thread-1"],
        },
      }),
    ).toEqual({
      transport: "http",
      baseUrl: "http://127.0.0.1:4311",
      headers: {
        authorization: "Bearer auth-token",
      },
      providerLaunch: {
        command: "docker",
        args: ["exec", "-i", "beanbag-thread-thread-1"],
      },
    });

    const stateDir = join(homedir(), ".beanbag", "environment-agents", "project-1");
    cleanupPaths.push(stateDir);
  });
});
