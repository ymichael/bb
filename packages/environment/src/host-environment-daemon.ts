import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import type { EnvironmentDaemonConnectionTarget } from "@bb/environment-daemon";
import { resolveDockerEnvironmentDaemonArtifactEntry } from "./docker-environment-daemon.js";

const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 500;
const STOP_TIMEOUT_MS = 1_000;
const STOP_POLL_INTERVAL_MS = 25;

interface TrackedHostEnvironmentDaemonRecordBase {
  port: number;
  baseUrl: string;
  authToken: string;
  projectId: string;
  environmentId: string;
  workspaceRoot: string;
}

interface OwnedHostEnvironmentDaemonRecord extends TrackedHostEnvironmentDaemonRecordBase {
  ownership: "owned";
  pid: number;
}

interface AdoptedHostEnvironmentDaemonRecord extends TrackedHostEnvironmentDaemonRecordBase {
  ownership: "adopted";
}

type TrackedHostEnvironmentDaemonRecord =
  | OwnedHostEnvironmentDaemonRecord
  | AdoptedHostEnvironmentDaemonRecord;

interface ManagedHostEnvironmentDaemonIdentity {
  projectId: string;
  environmentId: string;
  workspaceRootPath: string;
}

interface EnsureManagedHostEnvironmentDaemonDeps {
  allocatePort?: () => Promise<number>;
  generateAuthToken?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  sleepMs?: (ms: number) => Promise<void>;
  pingAgent?: (
    baseUrl: string,
    authToken: string,
    timeoutMs: number,
  ) => Promise<boolean>;
  resolveLaunchCommand?: () => {
    command: string;
    args: string[];
  };
  spawnProcess?: typeof spawn;
  waitForAgent?: (baseUrl: string, authToken: string) => Promise<void>;
  requestShutdown?: (baseUrl: string, authToken: string) => Promise<void>;
}

const hostEnvironmentDaemonLocks = new Map<string, Promise<void>>();
const trackedHostEnvironmentDaemons = new Map<string, TrackedHostEnvironmentDaemonRecord>();

function managedHostEnvironmentDaemonIdentityKey(
  args: ManagedHostEnvironmentDaemonIdentity,
): string {
  return [
    args.projectId,
    args.environmentId,
    args.workspaceRootPath,
  ].join("\0");
}

async function withManagedHostEnvironmentDaemonLock(
  args: ManagedHostEnvironmentDaemonIdentity,
  action: () => Promise<void>,
): Promise<void> {
  const key = managedHostEnvironmentDaemonIdentityKey(args);
  const existing = hostEnvironmentDaemonLocks.get(key);
  if (existing) {
    await existing;
  }

  let inFlight: Promise<void>;
  inFlight = action().finally(() => {
    if (hostEnvironmentDaemonLocks.get(key) === inFlight) {
      hostEnvironmentDaemonLocks.delete(key);
    }
  });
  hostEnvironmentDaemonLocks.set(key, inFlight);
  await inFlight;
}

function toManagedHostEnvironmentDaemonTarget(args: {
  record: TrackedHostEnvironmentDaemonRecord;
  providerLaunch?: EnvironmentDaemonConnectionTarget["providerLaunch"];
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function defaultSleepMs(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function terminateProcess(args: {
  pid: number;
  isProcessAlive: (pid: number) => boolean;
  killProcess: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  sleepMs: (ms: number) => Promise<void>;
}): Promise<void> {
  if (!args.isProcessAlive(args.pid)) {
    return;
  }

  try {
    args.killProcess(args.pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!args.isProcessAlive(args.pid)) {
      return;
    }
    await args.sleepMs(STOP_POLL_INTERVAL_MS);
  }

  if (!args.isProcessAlive(args.pid)) {
    return;
  }

  try {
    args.killProcess(args.pid, "SIGKILL");
  } catch {
    return;
  }

  const forceKillDeadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < forceKillDeadline) {
    if (!args.isProcessAlive(args.pid)) {
      return;
    }
    await args.sleepMs(STOP_POLL_INTERVAL_MS);
  }
}

function pingEnvironmentDaemon(
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

function requestEnvironmentDaemonShutdown(
  baseUrl: string,
  authToken: string,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const url = new URL("/control/shutdown", baseUrl);
    const req = httpRequest(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        timeout: HEALTH_TIMEOUT_MS,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`,
        },
      },
      (response) => {
        response.resume();
        if (response.statusCode === 202 || response.statusCode === 204) {
          resolvePromise();
          return;
        }
        reject(new Error(`Unexpected shutdown response: ${response.statusCode ?? "unknown"}`));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timed out requesting environment-daemon shutdown"));
    });
    req.on("error", reject);
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
        server.close(() => reject(new Error("Failed to allocate environment-daemon port")));
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

async function waitForEnvironmentDaemon(baseUrl: string, authToken: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await pingEnvironmentDaemon(baseUrl, authToken, HEALTH_TIMEOUT_MS)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for environment-daemon at ${baseUrl}`);
}

export function resolveManagedHostEnvironmentDaemonLaunchCommand(): {
  command: string;
  args: string[];
} {
  try {
    const artifactEntry = resolveDockerEnvironmentDaemonArtifactEntry();
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
        args: [localCliEntry, "environment-daemon"],
      };
    }
    return {
      command: "bb",
      args: ["environment-daemon"],
    };
  }
}

function toEnvironmentDaemonRuntimeEnv(
  runtimeEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const {
    BB_THREAD_ID: _ignoredThreadId,
    BB_THREAD_PROVIDER_ID: _ignoredProviderId,
    ...daemonRuntimeEnv
  } = runtimeEnv;
  return daemonRuntimeEnv;
}

export async function ensureManagedHostEnvironmentDaemon(args: {
  workspaceRootPath: string;
  projectId: string;
  environmentId: string;
  runtimeEnv: Record<string, string | undefined>;
  reconnectTarget?: {
    baseUrl: string;
    authToken?: string;
  };
}, deps: EnsureManagedHostEnvironmentDaemonDeps = {}): Promise<EnvironmentDaemonConnectionTarget | undefined> {
  if (args.runtimeEnv.BB_ENV_DAEMON_BASE_URL?.trim()) {
    return undefined;
  }

  const stateIdentity = {
    projectId: args.projectId,
    environmentId: args.environmentId,
    workspaceRootPath: args.workspaceRootPath,
  };
  const checkProcessAlive = deps.isProcessAlive ?? isProcessAlive;
  const killProcess =
    deps.killProcess ??
    ((pid: number, signal?: NodeJS.Signals | number) => process.kill(pid, signal));
  const sleepMs = deps.sleepMs ?? defaultSleepMs;

  let managedTarget: EnvironmentDaemonConnectionTarget | undefined;
  await withManagedHostEnvironmentDaemonLock(stateIdentity, async () => {
    const identityKey = managedHostEnvironmentDaemonIdentityKey(stateIdentity);
    const existing = trackedHostEnvironmentDaemons.get(identityKey);
    if (existing) {
      const existingHealthy = existing.ownership === "owned"
        ? checkProcessAlive(existing.pid)
        : await (deps.pingAgent ?? pingEnvironmentDaemon)(
            existing.baseUrl,
            existing.authToken,
            HEALTH_TIMEOUT_MS,
          );
      if (existingHealthy) {
        managedTarget = toManagedHostEnvironmentDaemonTarget({ record: existing });
        return;
      }
      if (existing.ownership === "owned" && checkProcessAlive(existing.pid)) {
        await terminateProcess({
          pid: existing.pid,
          isProcessAlive: checkProcessAlive,
          killProcess,
          sleepMs,
        });
      }
      trackedHostEnvironmentDaemons.delete(identityKey);
    }

    const reconnectBaseUrl = args.reconnectTarget?.baseUrl?.trim();
    const reconnectAuthToken = args.reconnectTarget?.authToken?.trim() ?? "";
    if (reconnectBaseUrl) {
      const healthy = await (deps.pingAgent ?? pingEnvironmentDaemon)(
        reconnectBaseUrl,
        reconnectAuthToken,
        HEALTH_TIMEOUT_MS,
      );
      if (healthy) {
        const reconnectUrl = new URL(reconnectBaseUrl);
        const record: AdoptedHostEnvironmentDaemonRecord = {
          ownership: "adopted",
          port: reconnectUrl.port ? Number.parseInt(reconnectUrl.port, 10) : 80,
          baseUrl: reconnectBaseUrl.replace(/\/+$/, ""),
          authToken: reconnectAuthToken,
          projectId: args.projectId,
          environmentId: args.environmentId,
          workspaceRoot: args.workspaceRootPath,
        };
        trackedHostEnvironmentDaemons.set(identityKey, record);
        managedTarget = toManagedHostEnvironmentDaemonTarget({ record });
        return;
      }
    }

    const port = await (deps.allocatePort ?? allocatePort)();
    const authToken =
      (deps.generateAuthToken ?? (() => randomBytes(24).toString("hex")))();
    const baseUrl = `http://${HOST}:${port}`;
    const { command, args: commandArgs } =
      (deps.resolveLaunchCommand ?? resolveManagedHostEnvironmentDaemonLaunchCommand)();
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
          ...toEnvironmentDaemonRuntimeEnv(args.runtimeEnv),
          BB_PROJECT_ID: args.projectId,
          BB_ENVIRONMENT_ID: args.environmentId,
          BB_ENV_DAEMON_AUTH_TOKEN: authToken,
          BB_ENV_DAEMON_CONTROL_BASE_URL: baseUrl,
        },
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref?.();

    await (deps.waitForAgent ?? waitForEnvironmentDaemon)(baseUrl, authToken);
    const record: OwnedHostEnvironmentDaemonRecord = {
      ownership: "owned",
      pid: child.pid!,
      port,
      baseUrl,
      authToken,
      projectId: args.projectId,
      environmentId: args.environmentId,
      workspaceRoot: args.workspaceRootPath,
    };
    trackedHostEnvironmentDaemons.set(identityKey, record);
    managedTarget = toManagedHostEnvironmentDaemonTarget({
      record,
    });
  });
  return managedTarget;
}

export async function disposeManagedHostEnvironmentDaemon(args: {
  projectId: string;
  environmentId: string;
  workspaceRootPath: string;
  runtimeEnv: Record<string, string | undefined>;
}, deps: Pick<
  EnsureManagedHostEnvironmentDaemonDeps,
  "isProcessAlive" | "killProcess" | "sleepMs" | "requestShutdown" | "pingAgent"
> = {}): Promise<void> {
  if (args.runtimeEnv.BB_ENV_DAEMON_BASE_URL?.trim()) {
    return;
  }
  const stateIdentity: ManagedHostEnvironmentDaemonIdentity = {
    projectId: args.projectId,
    environmentId: args.environmentId,
    workspaceRootPath: args.workspaceRootPath,
  };

  await withManagedHostEnvironmentDaemonLock(stateIdentity, async () => {
    const identityKey = managedHostEnvironmentDaemonIdentityKey(stateIdentity);
    const existing = trackedHostEnvironmentDaemons.get(identityKey);
    if (existing) {
      const checkProcessAlive = deps.isProcessAlive ?? isProcessAlive;
      const killProcess =
        deps.killProcess ??
        ((pid: number, signal?: NodeJS.Signals | number) => process.kill(pid, signal));
      const sleepMs = deps.sleepMs ?? defaultSleepMs;
      if (existing.ownership === "owned" && checkProcessAlive(existing.pid)) {
        await terminateProcess({
          pid: existing.pid,
          isProcessAlive: checkProcessAlive,
          killProcess,
          sleepMs,
        });
      } else {
        const requestShutdown = deps.requestShutdown ?? requestEnvironmentDaemonShutdown;
        const pingAgent = deps.pingAgent ?? pingEnvironmentDaemon;
        try {
          await requestShutdown(
            existing.baseUrl,
            existing.authToken,
          );
        } catch {
          // Keep adopted agents visible if they are still reachable so later
          // cleanup or reuse can make progress without spawning duplicates.
          const stillReachable = await pingAgent(
            existing.baseUrl,
            existing.authToken,
            HEALTH_TIMEOUT_MS,
          );
          if (stillReachable) {
            return;
          }
        }
      }
    }
    trackedHostEnvironmentDaemons.delete(identityKey);
  });
}

export function __testOnly__getManagedHostEnvironmentDaemonRecord(args: {
  projectId: string;
  environmentId: string;
  workspaceRootPath: string;
}): TrackedHostEnvironmentDaemonRecord | undefined {
  return trackedHostEnvironmentDaemons.get(managedHostEnvironmentDaemonIdentityKey(args));
}

/**
 * Return the PIDs of all currently tracked managed host environment-daemon
 * processes.  Used by the test harness process-exit safety net to kill
 * orphaned agents when vitest kills a test on timeout.
 */
export function listManagedHostEnvironmentDaemonPids(): number[] {
  const pids: number[] = [];
  for (const record of trackedHostEnvironmentDaemons.values()) {
    if (record.ownership === "owned") {
      pids.push(record.pid);
    }
  }
  return pids;
}
