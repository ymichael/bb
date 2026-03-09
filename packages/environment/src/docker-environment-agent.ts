import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvironmentAgentConnectionTarget } from "@beanbag/environment-agent";
import { runCommand } from "./process.js";

const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 500;
const STATE_VERSION = 1 as const;
export const DEFAULT_DOCKER_ENVIRONMENT_AGENT_CONTAINER_PORT = 4310;
export const DEFAULT_DOCKER_ENVIRONMENT_IMAGE = "beanbag/environment:local";
const DEFAULT_DOCKER_ENVIRONMENT_AGENT_INSTALL_ROOT = "/opt/beanbag/environment-agent";

export interface ManagedDockerEnvironmentAgentRecord {
  version: typeof STATE_VERSION;
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
  };
}

function sanitizeSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "environment";
}

function resolveStateFilePath(args: {
  projectId: string;
  threadId: string;
  environmentId: string;
}): string {
  return join(
    homedir(),
    ".beanbag",
    "environment-agents",
    sanitizeSegment(args.projectId),
    `${sanitizeSegment(args.environmentId)}-${sanitizeSegment(args.threadId)}.json`,
  );
}

function readRecord(args: {
  projectId: string;
  threadId: string;
  environmentId: string;
}): ManagedDockerEnvironmentAgentRecord | undefined {
  const stateFilePath = resolveStateFilePath(args);
  if (!existsSync(stateFilePath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(stateFilePath, "utf8")) as Partial<ManagedDockerEnvironmentAgentRecord>;
    if (
      parsed.version !== STATE_VERSION ||
      typeof parsed.baseUrl !== "string" ||
      typeof parsed.authToken !== "string" ||
      typeof parsed.threadId !== "string" ||
      typeof parsed.projectId !== "string" ||
      typeof parsed.environmentId !== "string" ||
      typeof parsed.workspaceRoot !== "string" ||
      typeof parsed.containerName !== "string" ||
      typeof parsed.hostPort !== "number" ||
      typeof parsed.containerPort !== "number" ||
      typeof parsed.installRoot !== "string"
    ) {
      return undefined;
    }
    return parsed as ManagedDockerEnvironmentAgentRecord;
  } catch {
    return undefined;
  }
}

function writeRecord(
  args: {
    projectId: string;
    threadId: string;
    environmentId: string;
  },
  record: ManagedDockerEnvironmentAgentRecord,
): void {
  const stateFilePath = resolveStateFilePath(args);
  mkdirSync(dirname(stateFilePath), { recursive: true });
  writeFileSync(stateFilePath, JSON.stringify(record, null, 2), "utf8");
}

function removeRecord(args: {
  projectId: string;
  threadId: string;
  environmentId: string;
}): void {
  rmSync(resolveStateFilePath(args), { force: true });
}

function pingEnvironmentAgent(
  baseUrl: string,
  authToken: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const url = new URL("/control/status", baseUrl);
    const req = httpRequest(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`,
        },
      },
      (response) => {
        response.resume();
        resolvePromise(response.statusCode === 200);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolvePromise(false);
    });
    req.on("error", () => {
      resolvePromise(false);
    });
    req.end("{}");
  });
}

async function waitForEnvironmentAgent(baseUrl: string, authToken: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await pingEnvironmentAgent(baseUrl, authToken, HEALTH_TIMEOUT_MS)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for docker environment-agent at ${baseUrl}`);
}

export function resolveDockerEnvironmentAgentArtifactEntry(): string {
  const entry = fileURLToPath(
    new URL("../../environment-agent/dist/environment-agent.bundle.mjs", import.meta.url),
  );
  if (!existsSync(entry)) {
    throw new Error(
      `Missing environment-agent artifact at ${entry}; build @beanbag/environment-agent first`,
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
  const image = args.configuredImage ?? args.runtimeEnv.BEANBAG_DOCKER_IMAGE;
  if (image?.trim()) {
    return image.trim();
  }
  return DEFAULT_DOCKER_ENVIRONMENT_IMAGE;
}

function executeOrThrow(args: {
  executor: CommandExecutor;
  command: string;
  commandArgs: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  description: string;
}): void {
  const result = args.executor(args.command, args.commandArgs, {
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

export function ensureDockerEnvironmentImageAvailable(
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
): void {
  const executor = deps?.run ?? runCommand;
  const inspectResult = executor(
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
  executeOrThrow({
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
): Promise<void> {
  if (args.runtimeEnv.BEANBAG_ENVIRONMENT_AGENT_BASE_URL?.trim()) {
    return;
  }

  const stateIdentity = {
    projectId: args.projectId,
    threadId: args.threadId,
    environmentId: args.environmentId,
  };
  const existing = readRecord(stateIdentity);
  if (existing) {
    if (
      existing.workspaceRoot === args.workspaceRootPath &&
      existing.containerName === args.containerName &&
      existing.hostPort === args.hostPort &&
      await pingEnvironmentAgent(existing.baseUrl, existing.authToken, HEALTH_TIMEOUT_MS)
    ) {
      return;
    }
    removeRecord(stateIdentity);
  }

  const executor = deps?.run ?? runCommand;
  const waitForAgent = deps?.waitForAgent ?? waitForEnvironmentAgent;
  const artifactEntry = (deps?.resolveArtifactEntry ?? resolveDockerEnvironmentAgentArtifactEntry)();
  const authToken = (deps?.generateAuthToken ?? (() => randomBytes(24).toString("hex")))();
  const containerPort = args.containerPort ?? DEFAULT_DOCKER_ENVIRONMENT_AGENT_CONTAINER_PORT;
  const installRoot = args.installRoot ?? DEFAULT_DOCKER_ENVIRONMENT_AGENT_INSTALL_ROOT;

  executeOrThrow({
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

  executeOrThrow({
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

  executeOrThrow({
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
      "-e",
      `BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN=${authToken}`,
      ...(args.runtimeEnv.BEANBAG_DAEMON_URL
        ? ["-e", `BEANBAG_DAEMON_URL=${args.runtimeEnv.BEANBAG_DAEMON_URL}`]
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

  writeRecord(stateIdentity, {
    version: STATE_VERSION,
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
  });
}

export function resolveManagedDockerEnvironmentAgentTarget(args: {
  projectId: string;
  threadId: string;
  environmentId: string;
  runtimeEnv: Record<string, string | undefined>;
  providerLaunch?: {
    command: string;
    args: string[];
  };
}): EnvironmentAgentConnectionTarget | undefined {
  const record = readRecord(args);
  if (!record) {
    return undefined;
  }

  return {
    transport: "http",
    baseUrl: record.baseUrl,
    headers: {
      authorization: `Bearer ${record.authToken}`,
    },
    ...(args.providerLaunch ? { providerLaunch: args.providerLaunch } : {}),
  };
}

export function disposeManagedDockerEnvironmentAgent(args: {
  projectId: string;
  threadId: string;
  environmentId: string;
}): void {
  removeRecord(args);
}
