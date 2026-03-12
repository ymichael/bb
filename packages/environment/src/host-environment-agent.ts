import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { EnvironmentAgentConnectionTarget } from "@beanbag/environment-agent";
import { resolveBeanbagPath } from "@beanbag/agent-core/storage-paths";
import { resolveDockerEnvironmentAgentArtifactEntry } from "./docker-environment-agent.js";

const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 500;
const STATE_VERSION = 1 as const;

interface ManagedHostEnvironmentAgentRecord {
  version: typeof STATE_VERSION;
  pid: number;
  port: number;
  baseUrl: string;
  authToken: string;
  threadId: string;
  projectId: string;
  environmentId: string;
  workspaceRoot: string;
}

interface ManagedHostEnvironmentAgentIdentity {
  projectId: string;
  threadId: string;
  environmentId: string;
  workspaceRootPath: string;
}

interface EnsureManagedHostEnvironmentAgentDeps {
  allocatePort?: () => Promise<number>;
  generateAuthToken?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  resolveLaunchCommand?: () => {
    command: string;
    args: string[];
  };
  spawnProcess?: typeof spawn;
  waitForAgent?: (baseUrl: string, authToken: string) => Promise<void>;
}

const hostEnvironmentAgentLocks = new Map<string, Promise<void>>();

function managedHostEnvironmentAgentIdentityKey(
  args: ManagedHostEnvironmentAgentIdentity,
): string {
  return [
    args.projectId,
    args.threadId,
    args.environmentId,
    args.workspaceRootPath,
  ].join("\0");
}

async function withManagedHostEnvironmentAgentLock(
  args: ManagedHostEnvironmentAgentIdentity,
  action: () => Promise<void>,
): Promise<void> {
  const key = managedHostEnvironmentAgentIdentityKey(args);
  const existing = hostEnvironmentAgentLocks.get(key);
  if (existing) {
    await existing;
    return;
  }

  let inFlight: Promise<void>;
  inFlight = action().finally(() => {
    if (hostEnvironmentAgentLocks.get(key) === inFlight) {
      hostEnvironmentAgentLocks.delete(key);
    }
  });
  hostEnvironmentAgentLocks.set(key, inFlight);
  await inFlight;
}

function sanitizeSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "environment";
}

function hashWorkspaceRoot(workspaceRootPath: string): string {
  return createHash("sha1")
    .update(workspaceRootPath)
    .digest("hex")
    .slice(0, 12);
}

function resolveLegacyStateFilePath(args: {
  projectId: string;
  threadId: string;
  environmentId: string;
  runtimeEnv?: Record<string, string | undefined>;
}): string {
  return join(
    resolveBeanbagPath(args.runtimeEnv, "environment-agents"),
    sanitizeSegment(args.projectId),
    `${sanitizeSegment(args.environmentId)}-${sanitizeSegment(args.threadId)}.json`,
  );
}

function resolveStateFilePath(args: {
  projectId: string;
  threadId: string;
  environmentId: string;
  workspaceRootPath: string;
  runtimeEnv?: Record<string, string | undefined>;
}): string {
  return join(
    resolveBeanbagPath(args.runtimeEnv, "environment-agents"),
    sanitizeSegment(args.projectId),
    `${sanitizeSegment(args.environmentId)}-${sanitizeSegment(args.threadId)}-${hashWorkspaceRoot(args.workspaceRootPath)}.json`,
  );
}

function resolveStateFilePathCandidates(args: {
  projectId: string;
  threadId: string;
  environmentId: string;
  workspaceRootPath?: string;
  runtimeEnv?: Record<string, string | undefined>;
}): string[] {
  const candidates: string[] = [];
  if (args.workspaceRootPath) {
    candidates.push(resolveStateFilePath({
      projectId: args.projectId,
      threadId: args.threadId,
      environmentId: args.environmentId,
      workspaceRootPath: args.workspaceRootPath,
      runtimeEnv: args.runtimeEnv,
    }));
  }
  candidates.push(resolveLegacyStateFilePath(args));
  return Array.from(new Set(candidates));
}

function readRecord(args: {
  projectId: string;
  threadId: string;
  environmentId: string;
  workspaceRootPath?: string;
  runtimeEnv?: Record<string, string | undefined>;
}): ManagedHostEnvironmentAgentRecord | undefined {
  for (const stateFilePath of resolveStateFilePathCandidates(args)) {
    if (!existsSync(stateFilePath)) {
      continue;
    }

    try {
      const parsed = JSON.parse(readFileSync(stateFilePath, "utf8")) as Partial<ManagedHostEnvironmentAgentRecord>;
      if (
        parsed.version !== STATE_VERSION ||
        typeof parsed.pid !== "number" ||
        typeof parsed.port !== "number" ||
        typeof parsed.baseUrl !== "string" ||
        typeof parsed.authToken !== "string" ||
        typeof parsed.threadId !== "string" ||
        typeof parsed.projectId !== "string" ||
        typeof parsed.environmentId !== "string" ||
        typeof parsed.workspaceRoot !== "string"
      ) {
        continue;
      }
      return parsed as ManagedHostEnvironmentAgentRecord;
    } catch {
      continue;
    }
  }
  return undefined;
}

function writeRecord(
  args: {
    projectId: string;
    threadId: string;
    environmentId: string;
    workspaceRootPath: string;
    runtimeEnv?: Record<string, string | undefined>;
  },
  record: ManagedHostEnvironmentAgentRecord,
): void {
  const stateFilePath = resolveStateFilePath(args);
  mkdirSync(dirname(stateFilePath), { recursive: true });
  writeFileSync(stateFilePath, JSON.stringify(record, null, 2), "utf8");
  const legacyStateFilePath = resolveLegacyStateFilePath(args);
  if (legacyStateFilePath !== stateFilePath) {
    rmSync(legacyStateFilePath, { force: true });
  }
}

function removeRecord(args: {
  projectId: string;
  threadId: string;
  environmentId: string;
  workspaceRootPath?: string;
  runtimeEnv?: Record<string, string | undefined>;
}): void {
  for (const stateFilePath of resolveStateFilePathCandidates(args)) {
    rmSync(stateFilePath, { force: true });
  }
}

function toManagedHostEnvironmentAgentTarget(args: {
  record: ManagedHostEnvironmentAgentRecord;
  providerLaunch?: EnvironmentAgentConnectionTarget["providerLaunch"];
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

async function allocatePort(): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate environment-agent port")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise(address.port);
      });
    });
  });
}

async function waitForEnvironmentAgent(baseUrl: string, authToken: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await pingEnvironmentAgent(baseUrl, authToken, HEALTH_TIMEOUT_MS)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for environment-agent at ${baseUrl}`);
}

export function resolveManagedHostEnvironmentAgentLaunchCommand(): {
  command: string;
  args: string[];
} {
  try {
    const artifactEntry = resolveDockerEnvironmentAgentArtifactEntry();
    return {
      command: process.execPath,
      args: [artifactEntry],
    };
  } catch {
    const localCliEntry = fileURLToPath(
      new URL("../../../apps/cli/dist/index.js", import.meta.url),
    );
    if (existsSync(localCliEntry)) {
      return {
        command: process.execPath,
        args: [localCliEntry, "environment-agent"],
      };
    }
    return {
      command: "bb",
      args: ["environment-agent"],
    };
  }
}

export async function ensureManagedHostEnvironmentAgent(args: {
  workspaceRootPath: string;
  threadId: string;
  projectId: string;
  environmentId: string;
  runtimeEnv: Record<string, string | undefined>;
}, deps: EnsureManagedHostEnvironmentAgentDeps = {}): Promise<EnvironmentAgentConnectionTarget | undefined> {
  if (args.runtimeEnv.BEANBAG_ENVIRONMENT_AGENT_BASE_URL?.trim()) {
    return undefined;
  }

  const stateIdentity = {
    projectId: args.projectId,
    threadId: args.threadId,
    environmentId: args.environmentId,
    workspaceRootPath: args.workspaceRootPath,
  };
  const checkProcessAlive = deps.isProcessAlive ?? isProcessAlive;
  const killProcess =
    deps.killProcess ??
    ((pid: number, signal?: NodeJS.Signals | number) => process.kill(pid, signal));

  let managedTarget: EnvironmentAgentConnectionTarget | undefined;
  await withManagedHostEnvironmentAgentLock(stateIdentity, async () => {
    const stateRecordIdentity = { ...stateIdentity, runtimeEnv: args.runtimeEnv };
    const existing = readRecord(stateRecordIdentity);
    if (existing) {
      if (checkProcessAlive(existing.pid)) {
        try {
          killProcess(existing.pid, "SIGTERM");
        } catch {
          // Best-effort cleanup of stale managed agents.
        }
      }
      removeRecord(stateRecordIdentity);
    }

    const port = await (deps.allocatePort ?? allocatePort)();
    const authToken =
      (deps.generateAuthToken ?? (() => randomBytes(24).toString("hex")))();
    const baseUrl = `http://${HOST}:${port}`;
    const { command, args: commandArgs } =
      (deps.resolveLaunchCommand ?? resolveManagedHostEnvironmentAgentLaunchCommand)();
    const child = (deps.spawnProcess ?? spawn)(
      command,
      [
        ...commandArgs,
        "--http-host",
        HOST,
        "--http-port",
        String(port),
      ],
      {
        cwd: args.workspaceRootPath,
        env: {
          ...process.env,
          ...args.runtimeEnv,
          BB_THREAD_ID: args.threadId,
          BB_PROJECT_ID: args.projectId,
          BB_ENVIRONMENT_ID: args.environmentId,
          BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN: authToken,
          BEANBAG_ENVIRONMENT_AGENT_CONTROL_BASE_URL: baseUrl,
        },
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref?.();

    await (deps.waitForAgent ?? waitForEnvironmentAgent)(baseUrl, authToken);
    writeRecord(stateRecordIdentity, {
      version: STATE_VERSION,
      pid: child.pid!,
      port,
      baseUrl,
      authToken,
      threadId: args.threadId,
      projectId: args.projectId,
      environmentId: args.environmentId,
      workspaceRoot: args.workspaceRootPath,
    });
    managedTarget = toManagedHostEnvironmentAgentTarget({
      record: {
        version: STATE_VERSION,
        pid: child.pid!,
        port,
        baseUrl,
        authToken,
        threadId: args.threadId,
        projectId: args.projectId,
        environmentId: args.environmentId,
        workspaceRoot: args.workspaceRootPath,
      },
    });
  });
  return managedTarget ?? (() => {
    const record = readRecord({
      projectId: args.projectId,
      threadId: args.threadId,
      environmentId: args.environmentId,
      workspaceRootPath: args.workspaceRootPath,
      runtimeEnv: args.runtimeEnv,
    });
    return record ? toManagedHostEnvironmentAgentTarget({ record }) : undefined;
  })();
}

export async function disposeManagedHostEnvironmentAgent(args: {
  projectId: string;
  threadId: string;
  environmentId: string;
  workspaceRootPath: string;
  runtimeEnv: Record<string, string | undefined>;
}): Promise<void> {
  if (args.runtimeEnv.BEANBAG_ENVIRONMENT_AGENT_BASE_URL?.trim()) {
    return;
  }
  const stateIdentity: ManagedHostEnvironmentAgentIdentity = {
    projectId: args.projectId,
    threadId: args.threadId,
    environmentId: args.environmentId,
    workspaceRootPath: args.workspaceRootPath,
  };

  await withManagedHostEnvironmentAgentLock(stateIdentity, async () => {
    const stateRecordIdentity = { ...stateIdentity, runtimeEnv: args.runtimeEnv };
    const existing = readRecord(stateRecordIdentity);
    if (existing && isProcessAlive(existing.pid)) {
      try {
        process.kill(existing.pid, "SIGTERM");
      } catch {
        // Best-effort cleanup for already-exited processes.
      }
    }
    removeRecord(stateRecordIdentity);
  });
}

export function __testOnly__resolveManagedHostEnvironmentAgentStateFilePath(args: {
  projectId: string;
  threadId: string;
  environmentId: string;
  workspaceRootPath: string;
  runtimeEnv?: Record<string, string | undefined>;
}): string {
  return resolveStateFilePath(args);
}
