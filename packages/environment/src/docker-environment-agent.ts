import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EnvironmentAgentConnectionTarget } from "@bb/environment-daemon";
import { runCommandAsync } from "./process.js";

const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 5_000;
const DOCKER_DAEMON_HOST_OVERRIDE_ENV = "BB_DOCKER_DAEMON_HOST";
const DEFAULT_DOCKER_DAEMON_HOST = "host.docker.internal";
export const DEFAULT_DOCKER_ENVIRONMENT_AGENT_CONTAINER_PORT = 4310;
export const DEFAULT_DOCKER_ENVIRONMENT_IMAGE = "bb/environment:local";
const DEFAULT_DOCKER_ENVIRONMENT_AGENT_INSTALL_ROOT = "/opt/bb/environment-daemon";

export interface ManagedDockerEnvironmentAgentRecord {
  baseUrl: string;
  authToken: string;
  threadId: string;
  projectId: string;
  environmentId: string;
  workspaceRoot: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
  installRoot: string;
}

interface ManagedDockerEnvironmentAgentIdentity {
  projectId: string;
  threadId: string;
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

const dockerEnvironmentAgentLocks = new Map<string, Promise<void>>();
const managedDockerEnvironmentAgents = new Map<string, ManagedDockerEnvironmentAgentRecord>();

function managedDockerEnvironmentAgentIdentityKey(
  args: ManagedDockerEnvironmentAgentIdentity,
): string {
  // Intentionally excludes threadId — multiple threads can share one
  // docker environment and its agent process, matching the host pattern.
  return [
    args.projectId,
    args.environmentId,
    args.workspaceRootPath,
  ].join("\0");
}

async function withManagedDockerEnvironmentAgentLock(
  args: ManagedDockerEnvironmentAgentIdentity,
  action: () => Promise<void>,
): Promise<void> {
  const key = managedDockerEnvironmentAgentIdentityKey(args);
  const existing = dockerEnvironmentAgentLocks.get(key);
  if (existing) {
    await existing;
  }

  let inFlight: Promise<void>;
  inFlight = action().finally(() => {
    if (dockerEnvironmentAgentLocks.get(key) === inFlight) {
      dockerEnvironmentAgentLocks.delete(key);
    }
  });
  dockerEnvironmentAgentLocks.set(key, inFlight);
  await inFlight;
}

function toManagedDockerEnvironmentAgentTarget(args: {
  record: ManagedDockerEnvironmentAgentRecord;
  providerLaunch?: {
    command: string;
    args: string[];
  };
}): EnvironmentAgentConnectionTarget {
  return {
    transport: "http",
    baseUrl: args.record.baseUrl,
    headers: {
      authorization: `Bearer ${args.record.authToken}`,
    },
    ...(args.providerLaunch ? { providerLaunch: args.providerLaunch } : {}),
  };
}

async function waitForEnvironmentAgent(baseUrl: string, authToken: string): Promise<void> {
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
  throw new Error(`Timed out waiting for docker environment-agent at ${baseUrl}`);
}

export function resolveDockerEnvironmentAgentArtifactEntry(): string {
  const entry = fileURLToPath(
    new URL("../../environment-daemon/dist/environment-agent.bundle.mjs", import.meta.url),
  );
  if (!existsSync(entry)) {
    throw new Error(
      `Missing environment-agent artifact at ${entry}; build @bb/environment-daemon first`,
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

function resolveDockerDaemonUrl(
  runtimeEnv: Record<string, string | undefined>,
): string | undefined {
  const daemonUrl = runtimeEnv.BB_DAEMON_URL?.trim();
  if (!daemonUrl) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(daemonUrl);
  } catch {
    return daemonUrl;
  }

  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    return daemonUrl;
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

export async function ensureManagedDockerEnvironmentAgent(
  args: {
    workspaceRootPath: string;
    threadId: string;
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
): Promise<EnvironmentAgentConnectionTarget | undefined> {
  if (args.runtimeEnv.BB_ENV_DAEMON_BASE_URL?.trim()) {
    return undefined;
  }

  const stateIdentity: ManagedDockerEnvironmentAgentIdentity = {
    projectId: args.projectId,
    threadId: args.threadId,
    environmentId: args.environmentId,
    workspaceRootPath: args.workspaceRootPath,
  };
  let managedTarget: EnvironmentAgentConnectionTarget | undefined;
  await withManagedDockerEnvironmentAgentLock(stateIdentity, async () => {
    const identityKey = managedDockerEnvironmentAgentIdentityKey(stateIdentity);
    const existing = managedDockerEnvironmentAgents.get(identityKey);
    if (existing) {
      managedDockerEnvironmentAgents.delete(identityKey);
    }

    const executor = deps?.run ?? runCommandAsync;
    const waitForAgent = deps?.waitForAgent ?? waitForEnvironmentAgent;
    const artifactEntry =
      (deps?.resolveArtifactEntry ?? resolveDockerEnvironmentAgentArtifactEntry)();
    const authToken =
      (deps?.generateAuthToken ?? (() => randomBytes(24).toString("hex")))();
    const containerPort =
      args.containerPort ?? DEFAULT_DOCKER_ENVIRONMENT_AGENT_CONTAINER_PORT;
    const installRoot =
      args.installRoot ?? DEFAULT_DOCKER_ENVIRONMENT_AGENT_INSTALL_ROOT;
    const dockerDaemonUrl = resolveDockerDaemonUrl(args.runtimeEnv);

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
      description: "create docker environment-agent install directory",
    });

    await executeOrThrow({
      executor,
      command: args.dockerBin,
      commandArgs: [
        "cp",
        artifactEntry,
        `${args.containerName}:${installRoot}/environment-agent.bundle.mjs`,
      ],
      cwd: args.workspaceRootPath,
      env: args.runtimeEnv,
      description: "copy environment-agent artifact into docker container",
    });

    await executeOrThrow({
      executor,
      command: args.dockerBin,
      commandArgs: [
        "exec",
        "-d",
        "-e",
        `BB_THREAD_ID=${args.threadId}`,
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
        ...(dockerDaemonUrl
          ? ["-e", `BB_DAEMON_URL=${dockerDaemonUrl}`]
          : []),
        args.containerName,
        "node",
        `${installRoot}/environment-agent.bundle.mjs`,
        "--http-host",
        "0.0.0.0",
        "--http-port",
        String(containerPort),
      ],
      cwd: args.workspaceRootPath,
      env: args.runtimeEnv,
      description: "start docker environment-agent",
    });

    const baseUrl = `http://${HOST}:${args.hostPort}`;
    await waitForAgent(baseUrl, authToken);

    const record = {
      baseUrl,
      authToken,
      threadId: args.threadId,
      projectId: args.projectId,
      environmentId: args.environmentId,
      workspaceRoot: args.workspaceRootPath,
      containerName: args.containerName,
      hostPort: args.hostPort,
      containerPort,
      installRoot,
    };
    managedDockerEnvironmentAgents.set(identityKey, record);
    managedTarget = toManagedDockerEnvironmentAgentTarget({
      record,
    });
  });
  return managedTarget;
}

export function __testOnly__resolveDockerDaemonUrl(
  runtimeEnv: Record<string, string | undefined>,
): string | undefined {
  return resolveDockerDaemonUrl(runtimeEnv);
}

export async function disposeManagedDockerEnvironmentAgent(args: {
  projectId: string;
  threadId: string;
  environmentId: string;
  dockerBin: string;
  containerName: string;
  workspaceRootPath: string;
  runtimeEnv: Record<string, string | undefined>;
}): Promise<void> {
  await withManagedDockerEnvironmentAgentLock(args, async () => {
    if (!args.runtimeEnv.BB_ENV_DAEMON_BASE_URL?.trim()) {
      await runCommandAsync(
        args.dockerBin,
        [
          "exec",
          args.containerName,
          "sh",
          "-lc",
          "pkill -f 'environment-agent.bundle.mjs' || true",
        ],
        {
          cwd: args.workspaceRootPath,
          env: args.runtimeEnv,
          rawOutput: true,
        },
      );
    }
    managedDockerEnvironmentAgents.delete(managedDockerEnvironmentAgentIdentityKey(args));
  });
}

export function __testOnly__getManagedDockerEnvironmentAgentRecord(args: {
  projectId: string;
  threadId: string;
  environmentId: string;
  workspaceRootPath: string;
}): ManagedDockerEnvironmentAgentRecord | undefined {
  return managedDockerEnvironmentAgents.get(managedDockerEnvironmentAgentIdentityKey(args));
}
