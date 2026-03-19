import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EnvironmentDaemonConnectionTarget } from "@bb/environment-daemon";
import { runCommandAsync } from "./process.js";

const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 5_000;
const DOCKER_DAEMON_HOST_OVERRIDE_ENV = "BB_DOCKER_DAEMON_HOST";
const DEFAULT_DOCKER_DAEMON_HOST = "host.docker.internal";
export const DEFAULT_DOCKER_ENVIRONMENT_DAEMON_CONTAINER_PORT = 4310;
export const DEFAULT_DOCKER_ENVIRONMENT_IMAGE = "bb/environment:local";
const DEFAULT_DOCKER_ENVIRONMENT_DAEMON_INSTALL_ROOT = "/opt/bb/environment-daemon";

export interface ManagedDockerEnvironmentDaemonRecord {
  baseUrl: string;
  authToken: string;
  projectId: string;
  environmentId: string;
  workspaceRoot: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
  installRoot: string;
}

interface ManagedDockerEnvironmentDaemonIdentity {
  projectId: string;
  environmentId: string;
  workspaceRootPath: string;
}

interface CommandExecutor {
  (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      rawOutput?: boolean;
      timeoutMs?: number;
    },
  ): {
    exitCode: number | null;
    stdout: string;
    stderr: string;
  } | Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>;
}

const dockerEnvironmentDaemonLocks = new Map<string, Promise<void>>();
const managedDockerEnvironmentDaemons = new Map<string, ManagedDockerEnvironmentDaemonRecord>();

function managedDockerEnvironmentDaemonIdentityKey(
  args: ManagedDockerEnvironmentDaemonIdentity,
): string {
  // Intentionally excludes threadId — multiple threads can share one
  // docker environment and its agent process, matching the host pattern.
  return [
    args.projectId,
    args.environmentId,
    args.workspaceRootPath,
  ].join("\0");
}

async function withManagedDockerEnvironmentDaemonLock(
  args: ManagedDockerEnvironmentDaemonIdentity,
  action: () => Promise<void>,
): Promise<void> {
  const key = managedDockerEnvironmentDaemonIdentityKey(args);
  const existing = dockerEnvironmentDaemonLocks.get(key);
  if (existing) {
    await existing;
  }

  let inFlight: Promise<void>;
  inFlight = action().finally(() => {
    if (dockerEnvironmentDaemonLocks.get(key) === inFlight) {
      dockerEnvironmentDaemonLocks.delete(key);
    }
  });
  dockerEnvironmentDaemonLocks.set(key, inFlight);
  await inFlight;
}

function toManagedDockerEnvironmentDaemonTarget(args: {
  record: ManagedDockerEnvironmentDaemonRecord;
  providerLaunch?: {
    command: string;
    args: string[];
  };
}): EnvironmentDaemonConnectionTarget {
  return {
    transport: "http",
    baseUrl: args.record.baseUrl,
    headers: {
      authorization: `Bearer ${args.record.authToken}`,
    },
    ...(args.providerLaunch ? { providerLaunch: args.providerLaunch } : {}),
  };
}

async function waitForEnvironmentDaemon(baseUrl: string, authToken: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/control/status", baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`,
        },
        body: "{}",
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the startup deadline expires.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for docker environment-daemon at ${baseUrl}`);
}

export function resolveDockerEnvironmentDaemonArtifactEntry(): string {
  const entry = fileURLToPath(
    new URL("../../environment-daemon/dist/environment-daemon.bundle.mjs", import.meta.url),
  );
  if (!existsSync(entry)) {
    throw new Error(
      `Missing environment-daemon artifact at ${entry}; build @bb/environment-daemon first`,
    );
  }
  return entry;
}

export function resolveDefaultDockerEnvironmentAssetsRoot(): string {
  return fileURLToPath(new URL("../docker", import.meta.url));
}

export function resolveDockerEnvironmentImage(args: {
  configuredImage?: string;
  runtimeEnv: Record<string, string | undefined>;
}): string {
  const image = args.configuredImage ?? args.runtimeEnv.BB_DOCKER_IMAGE;
  if (image?.trim()) {
    return image.trim();
  }
  return DEFAULT_DOCKER_ENVIRONMENT_IMAGE;
}

async function executeOrThrow(args: {
  executor: CommandExecutor;
  command: string;
  commandArgs: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  description: string;
}): Promise<void> {
  const result = await args.executor(args.command, args.commandArgs, {
    cwd: args.cwd,
    env: args.env,
    rawOutput: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr || result.stdout || `Failed to ${args.description}`,
    );
  }
}

function resolveDockerServerUrl(
  runtimeEnv: Record<string, string | undefined>,
): string | undefined {
  const serverUrl = runtimeEnv.BB_SERVER_URL?.trim();
  if (!serverUrl) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return serverUrl;
  }

  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    return serverUrl;
  }

  const dockerHost =
    runtimeEnv[DOCKER_DAEMON_HOST_OVERRIDE_ENV]?.trim() || DEFAULT_DOCKER_DAEMON_HOST;
  parsed.hostname = dockerHost;
  return parsed.toString().replace(/\/$/, "");
}

export async function ensureDockerEnvironmentImageAvailable(
  args: {
    dockerBin: string;
    image: string;
    runtimeEnv: Record<string, string | undefined>;
    cwd: string;
  },
  deps?: {
    run?: CommandExecutor;
    resolveAssetsRoot?: () => string;
  },
): Promise<void> {
  const executor = deps?.run ?? runCommandAsync;
  const inspectResult = await executor(
    args.dockerBin,
    ["image", "inspect", args.image],
    {
      cwd: args.cwd,
      env: args.runtimeEnv,
      rawOutput: true,
    },
  );
  if (inspectResult.exitCode === 0) {
    return;
  }

  if (args.image !== DEFAULT_DOCKER_ENVIRONMENT_IMAGE) {
    throw new Error(
      `Docker image ${args.image} is unavailable. Build or pull it first, or use ${DEFAULT_DOCKER_ENVIRONMENT_IMAGE}.`,
    );
  }

  const assetsRoot = (deps?.resolveAssetsRoot ?? resolveDefaultDockerEnvironmentAssetsRoot)();
  await executeOrThrow({
    executor,
    command: args.dockerBin,
    commandArgs: [
      "build",
      "-t",
      args.image,
      assetsRoot,
    ],
    cwd: args.cwd,
    env: args.runtimeEnv,
    description: `build docker image ${args.image}`,
  });
}

export async function ensureManagedDockerEnvironmentDaemon(
  args: {
    workspaceRootPath: string;
    projectId: string;
    environmentId: string;
    runtimeEnv: Record<string, string | undefined>;
    dockerBin: string;
    containerName: string;
    hostPort: number;
    containerPort?: number;
    installRoot?: string;
  },
  deps?: {
    run?: CommandExecutor;
    waitForAgent?: (baseUrl: string, authToken: string) => Promise<void>;
    generateAuthToken?: () => string;
    resolveArtifactEntry?: () => string;
  },
): Promise<EnvironmentDaemonConnectionTarget | undefined> {
  if (args.runtimeEnv.BB_ENV_DAEMON_BASE_URL?.trim()) {
    return undefined;
  }

  const stateIdentity: ManagedDockerEnvironmentDaemonIdentity = {
    projectId: args.projectId,
    environmentId: args.environmentId,
    workspaceRootPath: args.workspaceRootPath,
  };
  let managedTarget: EnvironmentDaemonConnectionTarget | undefined;
  await withManagedDockerEnvironmentDaemonLock(stateIdentity, async () => {
    const identityKey = managedDockerEnvironmentDaemonIdentityKey(stateIdentity);
    const existing = managedDockerEnvironmentDaemons.get(identityKey);
    if (existing) {
      managedDockerEnvironmentDaemons.delete(identityKey);
    }

    const executor = deps?.run ?? runCommandAsync;
    const waitForAgent = deps?.waitForAgent ?? waitForEnvironmentDaemon;
    const artifactEntry =
      (deps?.resolveArtifactEntry ?? resolveDockerEnvironmentDaemonArtifactEntry)();
    const authToken =
      (deps?.generateAuthToken ?? (() => randomBytes(24).toString("hex")))();
    const containerPort =
      args.containerPort ?? DEFAULT_DOCKER_ENVIRONMENT_DAEMON_CONTAINER_PORT;
    const installRoot =
      args.installRoot ?? DEFAULT_DOCKER_ENVIRONMENT_DAEMON_INSTALL_ROOT;
    const dockerServerUrl = resolveDockerServerUrl(args.runtimeEnv);

    await executeOrThrow({
      executor,
      command: args.dockerBin,
      commandArgs: [
        "exec",
        args.containerName,
        "mkdir",
        "-p",
        installRoot,
      ],
      cwd: args.workspaceRootPath,
      env: args.runtimeEnv,
      description: "create docker environment-daemon install directory",
    });

    await executeOrThrow({
      executor,
      command: args.dockerBin,
      commandArgs: [
        "cp",
        artifactEntry,
        `${args.containerName}:${installRoot}/environment-daemon.bundle.mjs`,
      ],
      cwd: args.workspaceRootPath,
      env: args.runtimeEnv,
      description: "copy environment-daemon artifact into docker container",
    });

    await executeOrThrow({
      executor,
      command: args.dockerBin,
      commandArgs: [
        "exec",
        "-d",
        "-e",
        `BB_PROJECT_ID=${args.projectId}`,
        "-e",
        `BB_ENVIRONMENT_ID=${args.environmentId}`,
        ...(args.runtimeEnv.BB_THREAD_PROVIDER_ID?.trim()
          ? ["-e", `BB_THREAD_PROVIDER_ID=${args.runtimeEnv.BB_THREAD_PROVIDER_ID.trim()}`]
          : []),
        "-e",
        `BB_ENV_DAEMON_AUTH_TOKEN=${authToken}`,
        "-e",
        `BB_ENV_DAEMON_CONTROL_BASE_URL=http://${HOST}:${args.hostPort}`,
        ...((args.runtimeEnv.BB_ROOT?.trim() || args.runtimeEnv.BB_ROOT?.trim())
          ? ["-e", `BB_ROOT=${args.runtimeEnv.BB_ROOT?.trim() || args.runtimeEnv.BB_ROOT}`]
          : []),
        ...(dockerServerUrl
          ? ["-e", `BB_SERVER_URL=${dockerServerUrl}`]
          : []),
        args.containerName,
        "node",
        `${installRoot}/environment-daemon.bundle.mjs`,
        "--http-host",
        "0.0.0.0",
        "--http-port",
        String(containerPort),
      ],
      cwd: args.workspaceRootPath,
      env: args.runtimeEnv,
      description: "start docker environment-daemon",
    });

    const baseUrl = `http://${HOST}:${args.hostPort}`;
    await waitForAgent(baseUrl, authToken);

    const record = {
      baseUrl,
      authToken,
      projectId: args.projectId,
      environmentId: args.environmentId,
      workspaceRoot: args.workspaceRootPath,
      containerName: args.containerName,
      hostPort: args.hostPort,
      containerPort,
      installRoot,
    };
    managedDockerEnvironmentDaemons.set(identityKey, record);
    managedTarget = toManagedDockerEnvironmentDaemonTarget({
      record,
    });
  });
  return managedTarget;
}

export function __testOnly__resolveDockerServerUrl(
  runtimeEnv: Record<string, string | undefined>,
): string | undefined {
  return resolveDockerServerUrl(runtimeEnv);
}

export async function disposeManagedDockerEnvironmentDaemon(args: {
  projectId: string;
  environmentId: string;
  dockerBin: string;
  containerName: string;
  workspaceRootPath: string;
  runtimeEnv: Record<string, string | undefined>;
}): Promise<void> {
  await withManagedDockerEnvironmentDaemonLock(args, async () => {
    if (!args.runtimeEnv.BB_ENV_DAEMON_BASE_URL?.trim()) {
      await runCommandAsync(
        args.dockerBin,
        [
          "exec",
          args.containerName,
          "sh",
          "-lc",
          "pkill -f 'environment-daemon.bundle.mjs' || true",
        ],
        {
          cwd: args.workspaceRootPath,
          env: args.runtimeEnv,
          rawOutput: true,
        },
      );
    }
    managedDockerEnvironmentDaemons.delete(managedDockerEnvironmentDaemonIdentityKey(args));
  });
}

export function __testOnly__getManagedDockerEnvironmentDaemonRecord(args: {
  projectId: string;
  environmentId: string;
  workspaceRootPath: string;
}): ManagedDockerEnvironmentDaemonRecord | undefined {
  return managedDockerEnvironmentDaemons.get(managedDockerEnvironmentDaemonIdentityKey(args));
}
