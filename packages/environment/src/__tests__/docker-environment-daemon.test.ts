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
  __testOnly__getManagedDockerEnvironmentDaemonRecord,
  __testOnly__resolveDockerServerUrl,
  DEFAULT_DOCKER_ENVIRONMENT_IMAGE,
  ensureDockerEnvironmentImageAvailable,
  ensureManagedDockerEnvironmentDaemon,
  resolveDefaultDockerEnvironmentAssetsRoot,
  resolveDockerEnvironmentDaemonArtifactEntry,
  resolveDockerEnvironmentImage,
} from "../docker-environment-daemon.js";

const tempDirs: string[] = [];
const originalBbRoot = process.env.BB_ROOT;

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
  process.env.BB_ROOT = originalBbRoot;
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("docker environment-daemon helper", () => {
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

  it("resolves the built environment-daemon artifact entry", () => {
    const artifactEntry = fileURLToPath(
      new URL("../../../environment-daemon/dist/environment-daemon.bundle.mjs", import.meta.url),
    );
    mkdirSync(dirname(artifactEntry), { recursive: true });
    if (!existsSync(artifactEntry)) {
      writeFileSync(artifactEntry, "console.log('agent')\n", "utf8");
    }
    const entry = resolveDockerEnvironmentDaemonArtifactEntry();

    expect(entry.endsWith("/packages/environment-daemon/dist/environment-daemon.bundle.mjs")).toBe(true);
    expect(existsSync(entry)).toBe(true);
  });

  it("falls back to the default local image tag", () => {
    expect(
      resolveDockerEnvironmentImage({
        runtimeEnv: {},
      }),
    ).toBe(DEFAULT_DOCKER_ENVIRONMENT_IMAGE);
  });

  it("rewrites loopback server URLs for docker containers", () => {
    expect(
      __testOnly__resolveDockerServerUrl({
        BB_SERVER_URL: "http://127.0.0.1:3333/api/v1",
      }),
    ).toBe("http://host.docker.internal:3333/api/v1");
    expect(
      __testOnly__resolveDockerServerUrl({
        BB_SERVER_URL: "http://localhost:3333/api/v1",
      }),
    ).toBe("http://host.docker.internal:3333/api/v1");
  });

  it("keeps non-loopback server URLs unchanged", () => {
    expect(
      __testOnly__resolveDockerServerUrl({
        BB_SERVER_URL: "http://10.0.0.5:3333/api/v1",
      }),
    ).toBe("http://10.0.0.5:3333/api/v1");
  });

  it("uses an explicit docker daemon host override when provided", () => {
    expect(
      __testOnly__resolveDockerServerUrl({
        BB_SERVER_URL: "http://127.0.0.1:3333/api/v1",
        BB_DOCKER_DAEMON_HOST: "docker-host.internal",
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

  it("installs and starts the environment-daemon in the container", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const bbRoot = makeTempDir("bb-docker-agent-root-");
    process.env.BB_ROOT = bbRoot;
    const workspaceRoot = makeTempDir("bb-docker-agent-workspace-");
    const artifactRoot = makeTempDir("bb-docker-agent-artifact-");
    const artifactEntry = join(artifactRoot, "dist", "environment-daemon.bundle.mjs");
    mkdirSync(dirname(artifactEntry), { recursive: true });
    writeFileSync(artifactEntry, "console.log('agent')\n", "utf8");

    await ensureManagedDockerEnvironmentDaemon(
      {
        workspaceRootPath: workspaceRoot,
        projectId: "project-1",
        environmentId: "docker",
        runtimeEnv: {
          BB_ROOT: bbRoot,
          BB_SERVER_URL: "http://127.0.0.1:9000",
        },
        dockerBin: "docker",
        containerName: "bb-thread-thread-1",
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
          "bb-thread-thread-1",
          "mkdir",
          "-p",
          "/opt/bb/environment-daemon",
        ],
      },
      {
        command: "docker",
        args: [
          "cp",
          artifactEntry,
          "bb-thread-thread-1:/opt/bb/environment-daemon/environment-daemon.bundle.mjs",
        ],
      },
      {
        command: "docker",
        args: [
          "exec",
          "-d",
          "-e",
          "BB_PROJECT_ID=project-1",
          "-e",
          "BB_ENVIRONMENT_ID=docker",
          "-e",
          "BB_ENV_DAEMON_AUTH_TOKEN=auth-token",
          "-e",
          "BB_ENV_DAEMON_CONTROL_BASE_URL=http://127.0.0.1:4311",
          "-e",
          `BB_ROOT=${bbRoot}`,
          "-e",
          "BB_SERVER_URL=http://host.docker.internal:9000",
          "bb-thread-thread-1",
          "node",
          "/opt/bb/environment-daemon/environment-daemon.bundle.mjs",
          "--http-host",
          "0.0.0.0",
          "--http-port",
          "4310",
        ],
      },
    ]);
  });

  it("serializes concurrent docker managed agent startup for the same thread", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const bbRoot = makeTempDir("bb-docker-agent-lock-root-");
    process.env.BB_ROOT = bbRoot;
    const workspaceRoot = makeTempDir("bb-docker-agent-lock-workspace-");
    const artifactRoot = makeTempDir("bb-docker-agent-lock-artifact-");
    const artifactEntry = join(artifactRoot, "dist", "environment-daemon.bundle.mjs");
    mkdirSync(dirname(artifactEntry), { recursive: true });
    writeFileSync(artifactEntry, "console.log('agent')\n", "utf8");

    const waitGate = createDeferred();
    const ensureArgs = {
      workspaceRootPath: workspaceRoot,
      projectId: "project-lock",
      environmentId: "docker",
      runtimeEnv: {
        BB_ROOT: bbRoot,
        BB_SERVER_URL: "http://127.0.0.1:9000",
      },
      dockerBin: "docker",
      containerName: "bb-thread-thread-lock",
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

    const first = ensureManagedDockerEnvironmentDaemon(ensureArgs, deps);
    const second = ensureManagedDockerEnvironmentDaemon(ensureArgs, deps);

    await Promise.resolve();
    await Promise.resolve();

    waitGate.resolve();
    await Promise.all([first, second]);

    // Both callers execute their action sequentially (the second waits
    // for the first). The docker ensure action always replaces, so both
    // callers spawn — 3 commands each = 6 total.
    expect(commands).toHaveLength(6);
    expect(__testOnly__getManagedDockerEnvironmentDaemonRecord({
      projectId: "project-lock",
      environmentId: "docker",
      workspaceRootPath: workspaceRoot,
    })).toMatchObject({
      baseUrl: "http://127.0.0.1:4311",
      authToken: "auth-token",
      projectId: "project-lock",
      environmentId: "docker",
      workspaceRoot,
      containerName: "bb-thread-thread-lock",
      hostPort: 4311,
      containerPort: 4310,
    });
  });

  it("replaces an existing managed environment-daemon for the same docker container", async () => {
    const bbRoot = makeTempDir("bb-docker-agent-existing-root-");
    process.env.BB_ROOT = bbRoot;
    const workspaceRoot = makeTempDir("bb-docker-agent-existing-workspace-");

    const artifactRoot = makeTempDir("bb-docker-agent-existing-artifact-");
    const artifactEntry = join(artifactRoot, "dist", "environment-daemon.bundle.mjs");
    mkdirSync(dirname(artifactEntry), { recursive: true });
    writeFileSync(artifactEntry, "console.log('agent')\n", "utf8");

    const run = vi.fn(() => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));

    await ensureManagedDockerEnvironmentDaemon({
      workspaceRootPath: workspaceRoot,
      projectId: "project-existing",
      environmentId: "docker",
      runtimeEnv: { BB_ROOT: bbRoot },
      dockerBin: "docker",
      containerName: "bb-thread-thread-existing",
      hostPort: 4311,
    }, {
      run,
      waitForAgent: async () => {},
      generateAuthToken: () => "existing-auth-token",
      resolveArtifactEntry: () => artifactEntry,
    });

    await ensureManagedDockerEnvironmentDaemon({
      workspaceRootPath: workspaceRoot,
      projectId: "project-existing",
      environmentId: "docker",
      runtimeEnv: { BB_ROOT: bbRoot },
      dockerBin: "docker",
      containerName: "bb-thread-thread-existing",
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
