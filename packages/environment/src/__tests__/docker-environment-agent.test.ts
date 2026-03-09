import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DOCKER_ENVIRONMENT_IMAGE,
  ensureDockerEnvironmentImageAvailable,
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
    expect(dockerfile).toContain("unzip");
    expect(dockerfile).toContain("curl -fsSL https://bun.sh/install | bash");
    expect(dockerfile).toContain("corepack prepare pnpm@9.15.0 --activate");
    expect(dockerfile).toContain("npm install -g @openai/codex@latest");
  });

  it("resolves the built environment-agent artifact entry", () => {
    const artifactEntry = fileURLToPath(
      new URL("../../../environment-agent/dist/environment-agent.bundle.mjs", import.meta.url),
    );
    mkdirSync(dirname(artifactEntry), { recursive: true });
    if (!existsSync(artifactEntry)) {
      writeFileSync(artifactEntry, "console.log('agent')\n", "utf8");
    }
    const entry = resolveDockerEnvironmentAgentArtifactEntry();

    expect(entry.endsWith("/packages/environment-agent/dist/environment-agent.bundle.mjs")).toBe(true);
    expect(existsSync(entry)).toBe(true);
  });

  it("falls back to the default local image tag", () => {
    expect(
      resolveDockerEnvironmentImage({
        runtimeEnv: {},
      }),
    ).toBe(DEFAULT_DOCKER_ENVIRONMENT_IMAGE);
  });

  it("builds the default local image when it is missing", () => {
    const commands: Array<{ command: string; args: string[] }> = [];

    ensureDockerEnvironmentImageAvailable(
      {
        dockerBin: "docker",
        image: DEFAULT_DOCKER_ENVIRONMENT_IMAGE,
        runtimeEnv: {},
        cwd: "/tmp/workspace",
      },
      {
        run(command, args) {
          commands.push({ command, args });
          if (args[0] === "image" && args[1] === "inspect") {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "missing",
            };
          }
          return {
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
        resolveAssetsRoot: () => "/repo/packages/environment/docker",
      },
    );

    expect(commands).toEqual([
      {
        command: "docker",
        args: ["image", "inspect", DEFAULT_DOCKER_ENVIRONMENT_IMAGE],
      },
      {
        command: "docker",
        args: [
          "build",
          "-t",
          DEFAULT_DOCKER_ENVIRONMENT_IMAGE,
          "/repo/packages/environment/docker",
        ],
      },
    ]);
  });

  it("fails fast when a custom docker image is missing", () => {
    expect(() =>
      ensureDockerEnvironmentImageAvailable(
        {
          dockerBin: "docker",
          image: "custom/environment:dev",
          runtimeEnv: {},
          cwd: "/tmp/workspace",
        },
        {
          run() {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "missing",
            };
          },
        },
      ),
    ).toThrow(/custom\/environment:dev/);
  });

  it("installs and starts the environment-agent in the container", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const workspaceRoot = makeTempDir("bb-docker-agent-workspace-");
    const artifactRoot = makeTempDir("bb-docker-agent-artifact-");
    const artifactEntry = join(artifactRoot, "dist", "environment-agent.bundle.mjs");
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
          "/opt/beanbag/environment-agent",
        ],
      },
      {
        command: "docker",
        args: [
          "cp",
          artifactEntry,
          "beanbag-thread-thread-1:/opt/beanbag/environment-agent/environment-agent.bundle.mjs",
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
          "/opt/beanbag/environment-agent/environment-agent.bundle.mjs",
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
      }),
    ).toEqual({
      transport: "http",
      baseUrl: "http://127.0.0.1:4311",
      headers: {
        authorization: "Bearer auth-token",
      },
    });

    const stateDir = join(homedir(), ".beanbag", "environment-agents", "project-1");
    cleanupPaths.push(stateDir);
  });

  it("reuses an already running environment-agent for the same docker container", async () => {
    const workspaceRoot = makeTempDir("bb-docker-agent-existing-workspace-");
    const server = await new Promise<import("node:http").Server>((resolve) => {
      const next = createServer((request, response) => {
        if (request.url === "/control/status" && request.method === "POST") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        response.writeHead(404);
        response.end();
      });
      next.listen(0, "127.0.0.1", () => resolve(next));
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected test server address");
    }
    cleanupPaths.push(join(homedir(), ".beanbag", "environment-agents", "project-existing"));

    const stateFile = join(
      homedir(),
      ".beanbag",
      "environment-agents",
      "project-existing",
      "docker-thread-existing.json",
    );
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(
      stateFile,
      JSON.stringify(
        {
          version: 1,
          baseUrl: `http://127.0.0.1:${address.port}`,
          authToken: "existing-auth-token",
          threadId: "thread-existing",
          projectId: "project-existing",
          environmentId: "docker",
          workspaceRoot,
          containerName: "beanbag-thread-thread-existing",
          hostPort: address.port,
          containerPort: 4310,
          installRoot: "/opt/beanbag/environment-agent",
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      const run = vi.fn(() => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }));

      await ensureManagedDockerEnvironmentAgent({
        workspaceRootPath: workspaceRoot,
        threadId: "thread-existing",
        projectId: "project-existing",
        environmentId: "docker",
        runtimeEnv: {},
        dockerBin: "docker",
        containerName: "beanbag-thread-thread-existing",
        hostPort: address.port,
      }, {
        run,
      });

      expect(run).not.toHaveBeenCalled();
      expect(
        resolveManagedDockerEnvironmentAgentTarget({
          projectId: "project-existing",
          threadId: "thread-existing",
          environmentId: "docker",
          runtimeEnv: {},
        }),
      ).toEqual({
        transport: "http",
        baseUrl: `http://127.0.0.1:${address.port}`,
        headers: {
          authorization: "Bearer existing-auth-token",
        },
      });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
