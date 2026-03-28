import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createFakeAdapter } from "@bb/agent-runtime/test";
import type { AgentRuntimeOptions } from "@bb/agent-runtime";
import type { DbConnection } from "@bb/db";
import {
  acquireDaemonLock,
  createHostDaemonApp,
  loadHostIdentity,
  type HostDaemon,
  type HostDaemonApp,
} from "@bb/host-daemon/test";
import { createHostDaemonClient } from "@bb/host-daemon-contract";
import {
  createApp,
  initDb,
  NotificationHub,
  type ServerRuntimeConfig,
} from "@bb/server/test";
import { createPublicApiClient } from "@bb/server-contract";
import { waitForHostConnected } from "./assertions.js";
import { removePathWithRetry } from "./remove-path.js";
import { createTestGitRepo } from "./seed.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TEST_SERVER_HOST = "127.0.0.1";
const DEFAULT_TEST_AUTH_TOKEN = "test-integration-token";

let loadedProjectEnvPath: string | null | undefined;

type PublicApiClient = ReturnType<typeof createPublicApiClient>;
type InternalHostDaemonClient = ReturnType<typeof createHostDaemonClient>;

const testLogger = {
  error(): void {},
  info(): void {},
  warn(): void {},
};

export interface RunningTestServer {
  baseUrl: string;
  close(): Promise<void>;
  config: ServerRuntimeConfig;
  db: DbConnection;
  hub: NotificationHub;
}

export interface IntegrationHarness {
  api: PublicApiClient;
  cleanup(): Promise<void>;
  crashDaemon(): Promise<void>;
  daemon: HostDaemon;
  daemonApp: HostDaemonApp;
  daemonDataDir: string;
  db: DbConnection;
  hostId: string;
  hub: NotificationHub;
  internal: InternalHostDaemonClient;
  repoDir: string;
  restartDaemon(reason?: string): Promise<void>;
  server: RunningTestServer;
  serverUrl: string;
  shutdownDaemon(reason?: string): Promise<void>;
  startDaemon(): Promise<void>;
}

export interface CreateHarnessOptions {
  adapterFactory?: AgentRuntimeOptions["adapterFactory"];
}

export type WithHarnessCallback<T> = (harness: IntegrationHarness) => Promise<T>;
type WithHarnessInvocation<T> = CreateHarnessOptions | WithHarnessCallback<T>;

interface HarnessDaemonResources {
  daemon: HostDaemon;
  daemonApp: HostDaemonApp;
  hostId: string;
  releaseLock: () => Promise<void>;
}

interface ListeningAddress {
  port: number;
}

function requireListeningAddress(
  address: ListeningAddress | null,
): ListeningAddress {
  if (!address) {
    throw new Error("Server address was not assigned");
  }
  return address;
}

function hasAdapterFactoryOverride(
  options: CreateHarnessOptions,
): boolean {
  return Object.prototype.hasOwnProperty.call(options, "adapterFactory");
}

function resolveAdapterFactory(
  options: CreateHarnessOptions,
): AgentRuntimeOptions["adapterFactory"] | undefined {
  if (hasAdapterFactoryOverride(options)) {
    return options.adapterFactory;
  }
  return () => createFakeAdapter();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

async function resolveProjectEnvCandidates(): Promise<string[]> {
  const candidates = new Set<string>([path.join(repoRoot, ".env")]);
  const gitMetadataPath = path.join(repoRoot, ".git");

  try {
    const gitMetadata = await fs.stat(gitMetadataPath);
    if (!gitMetadata.isFile()) {
      return [...candidates];
    }

    const gitdirPointer = await fs.readFile(gitMetadataPath, "utf8");
    const match = /^gitdir:\s*(.+)\s*$/m.exec(gitdirPointer);
    if (!match?.[1]) {
      return [...candidates];
    }

    const worktreeGitDir = path.resolve(repoRoot, match[1]);
    const commonGitDir = path.dirname(path.dirname(worktreeGitDir));
    candidates.add(path.join(path.dirname(commonGitDir), ".env"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [...candidates];
    }
    throw error;
  }

  return [...candidates];
}

export async function loadProjectEnvFile(): Promise<string | null> {
  if (loadedProjectEnvPath !== undefined) {
    return loadedProjectEnvPath;
  }

  for (const candidate of await resolveProjectEnvCandidates()) {
    try {
      await fs.access(candidate);
      process.loadEnvFile(candidate);
      loadedProjectEnvPath = candidate;
      return candidate;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  loadedProjectEnvPath = null;
  return loadedProjectEnvPath;
}

async function startIntegrationServer(
  tmpRoot: string,
  authToken: string,
): Promise<RunningTestServer> {
  const serverDataDir = path.join(tmpRoot, "server-data");
  await fs.mkdir(serverDataDir, { recursive: true });

  const db = initDb(":memory:");
  const hub = new NotificationHub();
  const config: ServerRuntimeConfig = {
    authToken,
    dataDir: serverDataDir,
    hostDaemonPort: 3001,
    inferenceModel: "test/mock-model",
    openAiApiKey: process.env.OPENAI_API_KEY ?? "test-openai-key",
  };
  const { app, injectWebSocket } = createApp({
    config,
    db,
    hub,
    logger: testLogger,
  });

  let addressInfo: ListeningAddress | null = null;
  const server = serve(
    {
      // The client connects to 127.0.0.1 (IPv4), so bind the test server to
      // 127.0.0.1 too. Otherwise the server can listen on a different loopback
      // address family, and another local IPv4 process on the same port can
      // receive the request instead.
      hostname: TEST_SERVER_HOST,
      port: 0,
      fetch: app.fetch,
    },
    (info) => {
      addressInfo = { port: info.port };
    },
  );
  injectWebSocket(server);

  while (!addressInfo) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const baseUrl = `http://${TEST_SERVER_HOST}:${requireListeningAddress(addressInfo).port}`;

  return {
    baseUrl,
    config,
    db,
    hub,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function startHarnessDaemon(
  dataDir: string,
  serverUrl: string,
  authToken: string,
  options: CreateHarnessOptions,
): Promise<HarnessDaemonResources> {
  const releaseLock = await acquireDaemonLock(dataDir);

  try {
    const identity = await loadHostIdentity({ dataDir });
    const daemonApp = await createHostDaemonApp({
      adapterFactory: resolveAdapterFactory(options),
      authToken,
      dataDir,
      enableLocalApi: false,
      hostId: identity.hostId,
      hostName: identity.hostName,
      hostType: "persistent",
      instanceId: randomUUID(),
      localApiPort: 0,
      logger: testLogger,
      releaseLock,
      restart: async () => undefined,
      serverUrl,
    });
    await daemonApp.daemon.start();
    return {
      daemon: daemonApp.daemon,
      daemonApp,
      hostId: identity.hostId,
      releaseLock,
    };
  } catch (error) {
    await releaseLock().catch(() => undefined);
    throw error;
  }
}

export async function createIntegrationHarness(
  options: CreateHarnessOptions = {},
): Promise<IntegrationHarness> {
  await loadProjectEnvFile();
  const authToken = process.env.BB_SECRET_TOKEN ?? DEFAULT_TEST_AUTH_TOKEN;
  const tmpRoot = await fs.mkdtemp(path.join(tmpdir(), "bb-integration-"));
  await fs.writeFile(path.join(tmpRoot, "parent.pid"), `${process.pid}\n`, "utf8");
  const reposRoot = path.join(tmpRoot, "repos");
  const daemonDataDir = path.join(tmpRoot, "daemon-data");
  const repoDir = await createTestGitRepo({
    repoDir: path.join(reposRoot, "test-project"),
  });

  let server: RunningTestServer | null = null;
  let daemonResources: HarnessDaemonResources | null = null;
  let cleanedUp = false;
  let harness: IntegrationHarness | null = null;

  async function startDaemon(): Promise<void> {
    if (!server) {
      throw new Error("Server has not been started");
    }
    if (!harness) {
      throw new Error("Harness has not been initialized");
    }
    if (daemonResources) {
      return;
    }

    daemonResources = await startHarnessDaemon(
      daemonDataDir,
      server.baseUrl,
      authToken,
      options,
    );
    harness.daemon = daemonResources.daemon;
    harness.daemonApp = daemonResources.daemonApp;
    harness.hostId = daemonResources.hostId;
    await waitForHostConnected(harness.api);
  }

  async function shutdownDaemon(reason = "integration-shutdown"): Promise<void> {
    if (!daemonResources) {
      return;
    }
    const currentResources = daemonResources;
    daemonResources = null;
    await currentResources.daemon.shutdown(reason);
  }

  async function restartDaemon(reason = "integration-restart"): Promise<void> {
    await shutdownDaemon(reason);
    await startDaemon();
  }

  async function crashDaemon(): Promise<void> {
    if (!daemonResources) {
      return;
    }
    const currentResources = daemonResources;
    daemonResources = null;
    await currentResources.daemonApp.connection.shutdown().catch(() => undefined);
    currentResources.daemonApp.eventBuffer.dispose();
    await currentResources.daemonApp.localApi?.close().catch(() => undefined);
    await currentResources.daemonApp.runtimeManager.shutdownAll().catch(
      () => undefined,
    );
    await currentResources.releaseLock().catch(() => undefined);
  }

  async function cleanup(): Promise<void> {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

    await shutdownDaemon("integration-cleanup").catch(() => undefined);
    await server?.close().catch(() => undefined);
    await removePathWithRetry(tmpRoot);
  }

  try {
    server = await startIntegrationServer(tmpRoot, authToken);
    const api = createPublicApiClient(server.baseUrl);
    daemonResources = await startHarnessDaemon(
      daemonDataDir,
      server.baseUrl,
      authToken,
      options,
    );
    await waitForHostConnected(api);

    harness = {
      api,
      cleanup,
      crashDaemon,
      daemon: daemonResources.daemon,
      daemonApp: daemonResources.daemonApp,
      daemonDataDir,
      db: server.db,
      hostId: daemonResources.hostId,
      hub: server.hub,
      internal: createHostDaemonClient(server.baseUrl, authToken),
      repoDir,
      restartDaemon,
      server,
      serverUrl: server.baseUrl,
      shutdownDaemon,
      startDaemon,
    };

    return harness;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function withHarness<T>(
  run: WithHarnessCallback<T>,
): Promise<T>;
export async function withHarness<T>(
  options: CreateHarnessOptions,
  run: WithHarnessCallback<T>,
): Promise<T>;
export async function withHarness<T>(
  arg1: WithHarnessInvocation<T>,
  arg2?: WithHarnessCallback<T>,
): Promise<T> {
  const options = typeof arg1 === "function" ? {} : arg1;
  const run = typeof arg1 === "function" ? arg1 : arg2;
  if (!run) {
    throw new Error("withHarness requires a callback");
  }

  const harness = await createIntegrationHarness(options);
  try {
    return await run(harness);
  } finally {
    await harness.cleanup();
  }
}
