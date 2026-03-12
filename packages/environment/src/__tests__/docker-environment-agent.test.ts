import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testOnly__getManagedDockerEnvironmentAgentRecord,
  __testOnly__resolveDockerDaemonUrl,
  DEFAULT_DOCKER_ENVIRONMENT_IMAGE,
  ensureDockerEnvironmentImageAvailable,
  ensureManagedDockerEnvironmentAgent,
  resolveDefaultDockerEnvironmentAssetsRoot,
  resolveDockerEnvironmentAgentArtifactEntry,
  resolveDockerEnvironmentImage,
} from "../docker-environment-agent.js";

const tempDirs: string[] = [];
const originalBeanbagRoot = process.env.BEANBAG_ROOT;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createDeferred() {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

afterEach(() => {
  process.env.BEANBAG_ROOT = originalBeanbagRoot;
  vi.restoreAllMocks();
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

  it("rewrites loopback daemon URLs for docker containers", () => {
    expect(
      __testOnly__resolveDockerDaemonUrl({
        BEANBAG_DAEMON_URL: "http://127.0.0.1:3333/api/v1",
      }),
    ).toBe("http://host.docker.internal:3333/api/v1");
    expect(
      __testOnly__resolveDockerDaemonUrl({
        BEANBAG_DAEMON_URL: "http://localhost:3333/api/v1",
      }),
    ).toBe("http://host.docker.internal:3333/api/v1");
  });

  it("keeps non-loopback daemon URLs unchanged", () => {
    expect(
      __testOnly__resolveDockerDaemonUrl({
        BEANBAG_DAEMON_URL: "http://10.0.0.5:3333/api/v1",
      }),
    ).toBe("http://10.0.0.5:3333/api/v1");
  });

  it("uses an explicit docker daemon host override when provided", () => {
    expect(
      __testOnly__resolveDockerDaemonUrl({
        BEANBAG_DAEMON_URL: "http://127.0.0.1:3333/api/v1",
        BEANBAG_DOCKER_DAEMON_HOST: "docker-host.internal",
      }),
    ).toBe("http://docker-host.internal:3333/api/v1");
  });

  it("builds the default local image when it is missing", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];

    await ensureDockerEnvironmentImageAvailable(
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

  it("fails fast when a custom docker image is missing", async () => {
    await expect(
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
    ).rejects.toThrow(/custom\/environment:dev/);
  });

  it("installs and starts the environment-agent in the container", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const beanbagRoot = makeTempDir("bb-docker-agent-root-");
    process.env.BEANBAG_ROOT = beanbagRoot;
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
          BEANBAG_ROOT: beanbagRoot,
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
          "BEANBAG_ENVIRONMENT_AGENT_CONTROL_BASE_URL=http://127.0.0.1:4311",
          "-e",
          `BEANBAG_ROOT=${beanbagRoot}`,
          "-e",
          "BEANBAG_DAEMON_URL=http://host.docker.internal:9000",
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
  });

  it("coalesces concurrent docker managed agent startup for the same thread", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const beanbagRoot = makeTempDir("bb-docker-agent-lock-root-");
    process.env.BEANBAG_ROOT = beanbagRoot;
    const workspaceRoot = makeTempDir("bb-docker-agent-lock-workspace-");
    const artifactRoot = makeTempDir("bb-docker-agent-lock-artifact-");
    const artifactEntry = join(artifactRoot, "dist", "environment-agent.bundle.mjs");
    mkdirSync(dirname(artifactEntry), { recursive: true });
    writeFileSync(artifactEntry, "console.log('agent')\n", "utf8");

    const waitGate = createDeferred();
    const ensureArgs = {
      workspaceRootPath: workspaceRoot,
      threadId: "thread-lock",
      projectId: "project-lock",
      environmentId: "docker",
      runtimeEnv: {
        BEANBAG_ROOT: beanbagRoot,
        BEANBAG_DAEMON_URL: "http://127.0.0.1:9000",
      },
      dockerBin: "docker",
      containerName: "beanbag-thread-thread-lock",
      hostPort: 4311,
    };
    const deps = {
      run(command: string, args: string[]) {
        commands.push({ command, args });
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
      waitForAgent: async () => {
        await waitGate.promise;
      },
      generateAuthToken: () => "auth-token",
      resolveArtifactEntry: () => artifactEntry,
    };

    const first = ensureManagedDockerEnvironmentAgent(ensureArgs, deps);
    const second = ensureManagedDockerEnvironmentAgent(ensureArgs, deps);

    await Promise.resolve();
    await Promise.resolve();

    waitGate.resolve();
    await Promise.all([first, second]);

    expect(commands).toHaveLength(3);
    expect(__testOnly__getManagedDockerEnvironmentAgentRecord({
      projectId: "project-lock",
      threadId: "thread-lock",
      environmentId: "docker",
      workspaceRootPath: workspaceRoot,
    })).toMatchObject({
      baseUrl: "http://127.0.0.1:4311",
      authToken: "auth-token",
      threadId: "thread-lock",
      projectId: "project-lock",
      environmentId: "docker",
      workspaceRoot,
      containerName: "beanbag-thread-thread-lock",
      hostPort: 4311,
      containerPort: 4310,
    });
  });

  it("replaces an existing managed environment-agent for the same docker container", async () => {
    const beanbagRoot = makeTempDir("bb-docker-agent-existing-root-");
    process.env.BEANBAG_ROOT = beanbagRoot;
    const workspaceRoot = makeTempDir("bb-docker-agent-existing-workspace-");

    const artifactRoot = makeTempDir("bb-docker-agent-existing-artifact-");
    const artifactEntry = join(artifactRoot, "dist", "environment-agent.bundle.mjs");
    mkdirSync(dirname(artifactEntry), { recursive: true });
    writeFileSync(artifactEntry, "console.log('agent')\n", "utf8");

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
      runtimeEnv: { BEANBAG_ROOT: beanbagRoot },
      dockerBin: "docker",
      containerName: "beanbag-thread-thread-existing",
      hostPort: 4311,
    }, {
      run,
      waitForAgent: async () => {},
      generateAuthToken: () => "existing-auth-token",
      resolveArtifactEntry: () => artifactEntry,
    });

    await ensureManagedDockerEnvironmentAgent({
      workspaceRootPath: workspaceRoot,
      threadId: "thread-existing",
      projectId: "project-existing",
      environmentId: "docker",
      runtimeEnv: { BEANBAG_ROOT: beanbagRoot },
      dockerBin: "docker",
      containerName: "beanbag-thread-thread-existing",
      hostPort: 4311,
    }, {
      run,
      waitForAgent: async () => {},
      generateAuthToken: () => "new-auth-token",
      resolveArtifactEntry: () => artifactEntry,
    });

    expect(run).toHaveBeenCalledTimes(6);
  });
});
