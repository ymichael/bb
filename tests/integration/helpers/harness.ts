import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { DbConnection } from "@bb/db";
import { defaultFeatureFlags } from "@bb/domain";
import {
  acquireDaemonLock,
  createHostDaemonApp,
  loadHostIdentity,
  persistHostId,
  type HostDaemon,
  type HostDaemonApp,
} from "@bb/host-daemon/test";
import { createHostDaemonClient } from "@bb/host-daemon-contract";
import { initDb } from "../../../apps/server/src/db.js";
import { createLifecycleDedupers } from "../../../apps/server/src/lifecycle-dedupers.js";
import { createApp } from "../../../apps/server/src/server.js";
import { createAiServiceRegistry } from "../../../apps/server/src/services/ai/ai-service-registry.js";
import { PendingInteractionLifecycle } from "../../../apps/server/src/services/interactions/pending-interactions.js";
import { createMachineAuthService } from "../../../apps/server/src/services/machine-auth.js";
import {
  createProviderRegistryService,
  type ProviderRegistryService,
} from "../../../apps/server/src/services/providers/provider-registry.js";
import {
  recordFirstPartyProviderBridgeArtifacts,
  registerFakeProviders,
  registerFirstPartyProviders,
} from "../../../apps/server/test/helpers/provider-registry.js";
import {
  copyBuiltinSkills,
  resolveBuiltinSkillsRootPath,
} from "../../../apps/server/src/services/skills/builtin-skills-copy.js";
import { SkillTreeRegistry } from "../../../apps/server/src/services/skills/injected-skills.js";
import { PluginHostArtifactRegistry } from "../../../apps/server/src/services/plugins/plugin-host-artifact-registry.js";
import { createAppVersionService } from "../../../apps/server/src/services/system/app-version.js";
import { createProviderNativeRootsCache } from "../../../apps/server/src/services/providers/native-roots.js";
import { createBbAppManagedConfigReloader } from "../../../apps/server/src/services/system/bb-app-managed-config.js";
import { createNoopTelemetryService } from "../../../apps/server/src/services/system/telemetry.js";
import { TerminalSessionLifecycle } from "../../../apps/server/src/services/terminals/terminal-session-lifecycle.js";
import type {
  ServerLogger,
  ServerRuntimeConfig,
} from "../../../apps/server/src/types.js";
import { HostSharedPortCoordinator } from "../../../apps/server/src/ws/host-shared-ports.js";
import { NotificationHub } from "../../../apps/server/src/ws/hub.js";
import { WatchInterestCoordinator } from "../../../apps/server/src/ws/watch-interests.js";
import { WorkspaceReadCaches } from "../../../apps/server/src/services/environments/workspace-read-cache.js";
import { createPublicApiClient } from "@bb/server-contract";
import { waitForHostConnected } from "./assertions.js";
import { createIntegrationFetch } from "./fetch.js";
import { isNodeError, removePathWithRetry } from "./remove-path.js";
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

const testLogger: ServerLogger = {
  debug(): void {},
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
  providerRegistry: ProviderRegistryService;
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
  threadStorageRootPath: string;
}

export interface CreateHarnessOptions {
  serverPort?: number;
  bindHost?: "127.0.0.1" | "0.0.0.0";
  staticDir?: string;
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
  options: CreateHarnessOptions,
): Promise<RunningTestServer> {
  const serverDataDir = path.join(tmpRoot, "server-data");
  await fs.mkdir(serverDataDir, { recursive: true });
  const builtinSkillsRootPath = path.join(serverDataDir, "builtin-skills");
  await copyBuiltinSkills({
    skillsRootPath: resolveBuiltinSkillsRootPath(),
    targetPath: builtinSkillsRootPath,
  });

  const db = initDb(":memory:");
  const hub = new NotificationHub();
  const sharedPorts = new HostSharedPortCoordinator({ db, hub });
  const watchInterests = new WatchInterestCoordinator({ db, hub });
  const workspaceReadCaches = new WorkspaceReadCaches({ hub });
  const config: ServerRuntimeConfig = {
    appVersion: "0.0.0-dev",
    builtinSkillsRootPath,
    customModels: [],
    dataDir: serverDataDir,
    featureFlags: defaultFeatureFlags,
    hostDaemonPort: 3001,
    inferenceFallbackModel: "test/mock-fallback-model",
    inferenceModel: "test/mock-model",
    inheritedSkillsRootPaths: [],
    marketplaceUrl: "https://marketplace.invalid/marketplace.json",
    openAiApiKey: process.env.OPENAI_API_KEY ?? "test-openai-key",
    appUrl: "https://bb.example.test",
    serverPort: 0,
    sharedSkillRoots: { user: [], project: [] },
    transcriptionModel: "test/mock-transcription",
    isDevelopment: false,
    managedEnvironmentRetireGraceMs: 0,
  };
  const terminalSessions = new TerminalSessionLifecycle({
    attachTimeoutMs: 50,
    config,
    db,
    hub,
    logger: testLogger,
    openTimeoutMs: 50,
  });
  const machineAuth = await createMachineAuthService({
    dataDir: serverDataDir,
    db,
    logger: testLogger,
  });
  await machineAuth.ensureReady();
  const lifecycleDedupers = createLifecycleDedupers();
  const bbAppManagedConfig = await createBbAppManagedConfigReloader({
    config,
    hub,
    logger: testLogger,
  });
  const telemetry = createNoopTelemetryService();
  const skillTreeRegistry = new SkillTreeRegistry();
  const providerRegistry = createProviderRegistryService({});
  await registerFirstPartyProviders(providerRegistry);
  const pluginHostArtifacts = new PluginHostArtifactRegistry();
  await registerFakeProviders(providerRegistry, pluginHostArtifacts);
  await recordFirstPartyProviderBridgeArtifacts(pluginHostArtifacts);
  const aiServices = createAiServiceRegistry();
  const pendingInteractions = new PendingInteractionLifecycle({
    config,
    db,
    hub,
    lifecycleDedupers,
    logger: testLogger,
    machineAuth,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    skillTreeRegistry,
    telemetry,
    terminalSessions,
  });
  pendingInteractions.start();
  const appVersion = createAppVersionService({
    config,
    logger: testLogger,
  });
  const { app, injectWebSocket } = createApp(
    {
      appVersion,
      bbAppManagedConfig,
      providerRegistry,
      providerNativeRoots: createProviderNativeRootsCache(),
      pluginHostArtifacts,
      aiServices,
      config,
      db,
      hub,
      lifecycleDedupers,
      logger: testLogger,
      machineAuth,
      pendingInteractions,
      sharedPorts,
      skillTreeRegistry,
      telemetry,
      terminalSessions,
      watchInterests,
      workspaceReadCaches,
    },
    options.staticDir === undefined
      ? undefined
      : { staticDir: options.staticDir },
  );

  let addressInfo: ListeningAddress | null = null;
  const server = serve(
    {
      hostname: options.bindHost ?? TEST_SERVER_HOST,
      port: options.serverPort ?? 0,
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
    providerRegistry,
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
  server: RunningTestServer,
  threadStorageRootPath: string,
  options: CreateHarnessOptions,
): Promise<HarnessDaemonResources> {
  const releaseLock = await acquireDaemonLock(dataDir);

  try {
    const identity = await loadHostIdentity({ dataDir });
    const hostKey = await server.machineAuth.issueDaemonHostKey({
      hostId: identity.hostId,
      hostType: "persistent",
    });
    await persistHostId({ dataDir, hostId: identity.hostId });
    const daemonApp = await createHostDaemonApp({
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
  const threadStorageRootPath = path.join(daemonDataDir, "thread-storage");
  await fs.mkdir(threadStorageRootPath, { recursive: true });
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
      server,
      threadStorageRootPath,
      options,
    );
    if (daemonResources.hostId !== harness.hostId) {
      const mismatchedResources = daemonResources;
      daemonResources = null;
      await mismatchedResources.daemon
        .shutdown("integration-host-id-mismatch", 0)
        .catch(() => undefined);
      throw new Error(
        `Restarted daemon host ID ${mismatchedResources.hostId} did not match existing harness host ID ${harness.hostId}`,
      );
    }
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
    await currentResources.daemon.shutdown(reason, 0);
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
    await currentResources.daemonApp.eventSink.dispose().catch(() => undefined);
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
    server = await startIntegrationServer(tmpRoot, options);
    const api = createPublicApiClient(server.baseUrl, {
      fetch: createIntegrationFetch(),
    });
    daemonResources = await startHarnessDaemon(
      daemonDataDir,
      server,
      threadStorageRootPath,
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
      internal: createHostDaemonClient(server.baseUrl, daemonResources.hostKey),
      repoDir,
      restartDaemon,
      server,
      serverUrl: server.baseUrl,
      shutdownDaemon,
      startDaemon,
      threadStorageRootPath,
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
