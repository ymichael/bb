import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  createAgentRuntimeWithAdapters,
  createFakeAdapter,
  type ProviderAdapterFactory,
} from "@bb/agent-runtime/test";
import type { DbConnection } from "@bb/db";
import {
  acquireDaemonLock,
  createHostDaemonApp,
  loadHostIdentity,
  type HostDaemon,
  type HostDaemonApp,
} from "@bb/host-daemon/test";
import { createHostDaemonClient } from "@bb/host-daemon-contract";
import { defaultFeatureFlags } from "@bb/domain";
import { initDb } from "../../../apps/server/src/db.js";
import { createLifecycleDedupers } from "../../../apps/server/src/lifecycle-dedupers.js";
import { createApp } from "../../../apps/server/src/server.js";
import { createCloudAuthService } from "../../../apps/server/src/services/cloud-auth/service.js";
import { createHostLifecycleService } from "../../../apps/server/src/services/hosts/host-lifecycle-service.js";
import { createSandboxHostRegistry } from "../../../apps/server/src/services/hosts/sandbox-registry.js";
import {
  DEFAULT_SANDBOX_PENDING_INTERACTION_EXPIRY_MS,
  PendingInteractionLifecycle,
} from "../../../apps/server/src/services/interactions/pending-interactions.js";
import { createMachineAuthService } from "../../../apps/server/src/services/machine-auth.js";
import { createSandboxEnvService } from "../../../apps/server/src/services/sandbox-env/service.js";
import type { ServerRuntimeConfig } from "../../../apps/server/src/types.js";
import { NotificationHub } from "../../../apps/server/src/ws/hub.js";
import { createPublicApiClient } from "@bb/server-contract";
import { waitForHostConnected } from "./assertions.js";
import { removePathWithRetry } from "./remove-path.js";
import { createTestGitRepo } from "./seed.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const HARNESS_DAEMON_START_RETRY_DELAY_MS = 50;
const HARNESS_DAEMON_START_MAX_ATTEMPTS = 2;
const TEST_SERVER_HOST = "127.0.0.1";

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
  machineAuth: Awaited<ReturnType<typeof createMachineAuthService>>;
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
  adapterFactory?: ProviderAdapterFactory;
}

export type WithHarnessCallback<T> = (
  harness: IntegrationHarness,
) => Promise<T>;
type WithHarnessInvocation<T> = CreateHarnessOptions | WithHarnessCallback<T>;

interface HarnessDaemonResources {
  daemon: HostDaemon;
  daemonApp: HostDaemonApp;
  hostId: string;
  hostKey: string;
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

function hasAdapterFactoryOverride(options: CreateHarnessOptions): boolean {
  return Object.prototype.hasOwnProperty.call(options, "adapterFactory");
}

function resolveAdapterFactory(
  options: CreateHarnessOptions,
): ProviderAdapterFactory | undefined {
  if (hasAdapterFactoryOverride(options)) {
    return options.adapterFactory;
  }
  return () => createFakeAdapter();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function isRetryableSessionOpenFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Failed to open session: 401 Unauthorized")
  );
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
): Promise<RunningTestServer> {
  const serverDataDir = path.join(tmpRoot, "server-data");
  await fs.mkdir(serverDataDir, { recursive: true });

  const db = initDb(":memory:");
  const hub = new NotificationHub();
  const hostLifecycle = createHostLifecycleService();
  const pendingInteractions = new PendingInteractionLifecycle({
    db,
    hub,
    logger: testLogger,
    sandboxInteractionExpiryMs: DEFAULT_SANDBOX_PENDING_INTERACTION_EXPIRY_MS,
  });
  pendingInteractions.start();
  const sandboxRegistry = createSandboxHostRegistry();
  const config: ServerRuntimeConfig = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    dataDir: serverDataDir,
    e2bApiKey: process.env.E2B_API_KEY ?? "test-e2b-api-key",
    e2bTemplate: process.env.E2B_TEMPLATE ?? "",
    featureFlags: defaultFeatureFlags,
    githubPat: "",
    hostDaemonPort: 3001,
    inferenceModel: "test/mock-model",
    openAiApiKey: process.env.OPENAI_API_KEY ?? "test-openai-key",
    appUrl: "https://bb.example.test",
    externalUrl: "https://bb.example.test",
    serverPort: 0,
    sandboxActivityExtensionDebounceMs: 30_000,
    sandboxIdleThresholdMs: 300_000,
    isDevelopment: false,
  };
  const machineAuth = await createMachineAuthService({
    dataDir: serverDataDir,
    db,
    logger: testLogger,
  });
  await machineAuth.ensureReady();
  const cloudAuth = await createCloudAuthService({
    dataDir: serverDataDir,
    db,
    logger: testLogger,
  });
  const sandboxEnv = await createSandboxEnvService({
    dataDir: serverDataDir,
    db,
    logger: testLogger,
  });
  const lifecycleDedupers = createLifecycleDedupers();
  const { app, injectWebSocket } = createApp({
    cloudAuth,
    config,
    db,
    hostLifecycle,
    hub,
    lifecycleDedupers,
    logger: testLogger,
    machineAuth,
    sandboxEnv,
    pendingInteractions,
    sandboxRegistry,
  });

  let addressInfo: ListeningAddress | null = null;
  const server = serve(
    {
      // The client always connects to 127.0.0.1, so bind the test server to
      // 127.0.0.1 too. If we leave the host unspecified, this server can end
      // up on ::1 while another local process owns 127.0.0.1 on the same
      // port, and the client will hit that other process instead.
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

  const { port } = requireListeningAddress(addressInfo);
  config.serverPort = port;
  const baseUrl = `http://${TEST_SERVER_HOST}:${port}`;

  return {
    baseUrl,
    config,
    db,
    hub,
    machineAuth,
    async close(): Promise<void> {
      await cloudAuth.dispose();
      hostLifecycle.dispose();
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
  server: RunningTestServer,
  options: CreateHarnessOptions,
): Promise<HarnessDaemonResources> {
  const releaseLock = await acquireDaemonLock(dataDir);

  try {
    const identity = await loadHostIdentity({ dataDir });
    const hostKey = await server.machineAuth.issueDaemonHostKey({
      hostId: identity.hostId,
      hostType: "persistent",
    });
    const adapterFactory = resolveAdapterFactory(options);
    const daemonApp = await createHostDaemonApp({
      createRuntime: adapterFactory
        ? (runtimeOptions) =>
            createAgentRuntimeWithAdapters({
              ...runtimeOptions,
              adapterFactory,
            })
        : undefined,
      dataDir,
      hostKey,
      hostId: identity.hostId,
      hostName: identity.hostName,
      hostType: "persistent",
      instanceId: randomUUID(),
      localApiConfig: null,
      logger: testLogger,
      releaseLock,
      serverUrl: server.baseUrl,
    });
    for (
      let attempt = 1;
      attempt <= HARNESS_DAEMON_START_MAX_ATTEMPTS;
      attempt += 1
    ) {
      try {
        await daemonApp.daemon.start();
        break;
      } catch (error) {
        if (
          attempt === HARNESS_DAEMON_START_MAX_ATTEMPTS ||
          !isRetryableSessionOpenFailure(error)
        ) {
          throw error;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, HARNESS_DAEMON_START_RETRY_DELAY_MS),
        );
      }
    }
    return {
      daemon: daemonApp.daemon,
      daemonApp,
      hostId: identity.hostId,
      hostKey,
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
  const tmpRoot = await fs.mkdtemp(path.join(tmpdir(), "bb-integration-"));
  await fs.writeFile(
    path.join(tmpRoot, "parent.pid"),
    `${process.pid}\n`,
    "utf8",
  );
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

    daemonResources = await startHarnessDaemon(daemonDataDir, server, options);
    harness.daemon = daemonResources.daemon;
    harness.daemonApp = daemonResources.daemonApp;
    harness.hostId = daemonResources.hostId;
    harness.internal = createHostDaemonClient(
      server.baseUrl,
      daemonResources.hostKey,
    );
    await waitForHostConnected(harness.api);
  }

  async function shutdownDaemon(
    reason = "integration-shutdown",
  ): Promise<void> {
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
    await currentResources.daemonApp.connection
      .shutdown()
      .catch(() => undefined);
    await currentResources.daemonApp.localApi?.close().catch(() => undefined);
    await currentResources.daemonApp.runtimeManager
      .shutdownAll()
      .catch(() => undefined);
    await currentResources.daemonApp.eventBuffer
      .dispose()
      .catch(() => undefined);
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
    server = await startIntegrationServer(tmpRoot);
    const api = createPublicApiClient(server.baseUrl);
    daemonResources = await startHarnessDaemon(daemonDataDir, server, options);
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
      internal: createHostDaemonClient(server.baseUrl, daemonResources.hostKey),
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

export async function withHarness<T>(run: WithHarnessCallback<T>): Promise<T>;
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
