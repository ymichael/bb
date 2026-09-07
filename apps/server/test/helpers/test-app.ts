import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createConnection, type DbConnection } from "@bb/db";
import { defaultFeatureFlags, type HostType } from "@bb/domain";
import { initDb } from "../../src/db.js";
import { createApp } from "../../src/server.js";
import { PendingInteractionLifecycle } from "../../src/services/interactions/pending-interactions.js";
import { createMachineAuthService } from "../../src/services/machine-auth.js";
import { createProviderRegistryService } from "../../src/services/providers/provider-registry.js";
import { registerFirstPartyProviders } from "./provider-registry.js";
import { validatePluginProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import { buildPluginProviderRegistration } from "../../src/services/providers/plugin-provider-registration.js";
import { SkillTreeRegistry } from "../../src/services/skills/injected-skills.js";
import { PluginHostArtifactRegistry } from "../../src/services/plugins/plugin-host-artifact-registry.js";
import { createProviderNativeRootsCache } from "../../src/services/providers/native-roots.js";
import { createAiServiceRegistry } from "../../src/services/ai/ai-service-registry.js";
import {
  createAppVersionService,
  type AppVersionService,
} from "../../src/services/system/app-version.js";
import { createBbAppManagedConfigReloader } from "../../src/services/system/bb-app-managed-config.js";
import { createNoopTelemetryService } from "../../src/services/system/telemetry.js";
import { TerminalSessionLifecycle } from "../../src/services/terminals/terminal-session-lifecycle.js";
import { createLifecycleDedupers } from "../../src/lifecycle-dedupers.js";
import type { ServerAppDeps, ServerRuntimeConfig } from "../../src/types.js";
import { MANAGED_ENVIRONMENT_RETIRE_GRACE_MS } from "../../src/constants.js";
import type { NotificationHub } from "../../src/ws/hub.js";
import { NotificationHub as NotificationHubImpl } from "../../src/ws/hub.js";
import { WatchInterestCoordinator } from "../../src/ws/watch-interests.js";
import { HostSharedPortCoordinator } from "../../src/ws/host-shared-ports.js";
import { WorkspaceReadCaches } from "../../src/services/environments/workspace-read-cache.js";

const TEST_MACHINE_KEY_PREFIX = "test-daemon-key";
const TEST_SERVER_HOST = "127.0.0.1";

export interface TestAppHarness {
  app: ReturnType<typeof createApp>["app"];
  config: ServerRuntimeConfig;
  db: DbConnection;
  deps: ServerAppDeps;
  hub: NotificationHub;
  pluginService: ReturnType<typeof createApp>["pluginService"];
  pluginCatalogService: ReturnType<typeof createApp>["pluginCatalogService"];
  cleanup(): Promise<void>;
}

export interface RunningTestServer extends TestAppHarness {
  baseUrl: string;
  close(): Promise<void>;
}

export async function installTestBuiltinPlugin(
  harness: Pick<TestAppHarness, "pluginService">,
  name: "keep-awake",
): Promise<void> {
  const entry = await harness.pluginService.install(`builtin:${name}`, {
    kind: "root",
  });
  if (entry.status !== "running") {
    throw new Error(
      `test builtin ${name} did not start: ${entry.statusDetail ?? entry.status}`,
    );
  }
}

export type TestAppHarnessConfigOverrides = Partial<ServerRuntimeConfig> & {
  appVersionService?: AppVersionService;
  terminalCloseTimeoutMs?: number;
  nativeRootsClock?: () => number;
  seedFirstPartyProviders?: boolean;
  extraProviders?: readonly {
    declaration: PluginProviderDeclaration;
    pluginId: string;
  }[];
};

export const testLogger = {
  debug(): void {},
  error(): void {},
  info(): void {},
  warn(): void {},
};

interface TestDaemonKeyParts {
  hostId: string;
  hostType: HostType;
}

function encodeTestDaemonKey(args: TestDaemonKeyParts): string {
  return `${TEST_MACHINE_KEY_PREFIX}:${args.hostType}:${args.hostId}`;
}

function decodeTestDaemonKey(token: string): TestDaemonKeyParts | null {
  const parts = token.split(":");
  if (parts.length !== 3 || parts[0] !== TEST_MACHINE_KEY_PREFIX) {
    return null;
  }

  const hostType = parts[1];
  const hostId = parts[2];
  if (hostType !== "persistent" || hostId.length === 0) {
    return null;
  }

  return {
    hostId,
    hostType,
  };
}

export function createTestDaemonHostKey(
  args: Partial<TestDaemonKeyParts> = {},
): string {
  return encodeTestDaemonKey({
    hostId: args.hostId ?? "host-1",
    hostType: args.hostType ?? "persistent",
  });
}

let migratedTemplate: Buffer | null = null;

export function createTestDb(): DbConnection {
  if (migratedTemplate === null) {
    migratedTemplate = initDb(":memory:").$client.serialize();
  }
  return createConnection(migratedTemplate);
}

export async function createTestAppHarness(
  overrides: TestAppHarnessConfigOverrides = {},
): Promise<TestAppHarness> {
  const {
    appVersionService,
    terminalCloseTimeoutMs,
    nativeRootsClock,
    seedFirstPartyProviders = true,
    ...configOverrides
  } = overrides;
  const dataDir = await mkdtemp(join(tmpdir(), "bb-server-test-"));
  const db = createTestDb();
  const hub = new NotificationHubImpl();
  const watchInterests = new WatchInterestCoordinator({ db, hub });
  const sharedPorts = new HostSharedPortCoordinator({ db, hub });
  const workspaceReadCaches = new WorkspaceReadCaches({ hub });
  const providerRegistry = createProviderRegistryService({});
  const pluginHostArtifacts = new PluginHostArtifactRegistry();
  const providerNativeRoots = createProviderNativeRootsCache(
    nativeRootsClock === undefined ? {} : { now: nativeRootsClock },
  );
  for (const extra of overrides.extraProviders ?? []) {
    providerRegistry.register({
      ...buildPluginProviderRegistration({
        available: true,
        pluginId: extra.pluginId,
        declaration: validatePluginProviderDeclaration(extra.declaration),
        iconHash: null,
        readSettings: () => ({}),
      }),
      pluginId: extra.pluginId,
      iconNames: new Set<string>(),
    });
  }
  if (seedFirstPartyProviders) {
    await registerFirstPartyProviders(providerRegistry, {
      artifacts: pluginHostArtifacts,
    });
  }
  const lifecycleDedupers = createLifecycleDedupers();
  const machineAuth = await createMachineAuthService({
    dataDir,
    db,
    logger: testLogger,
  });
  await machineAuth.ensureReady();
  const testMachineAuth = {
    ...machineAuth,
    async verifyDaemonHostKey(token: string) {
      const testKey = decodeTestDaemonKey(token);
      if (testKey) {
        return {
          keyId: `test:${testKey.hostType}:${testKey.hostId}`,
          metadata: testKey,
        };
      }
      return machineAuth.verifyDaemonHostKey(token);
    },
  };
  const config: ServerRuntimeConfig = {
    appVersion: "0.0.0-test",
    builtinSkillsRootPath: join(dataDir, "builtin-skills"),
    customModels: [],
    dataDir,
    featureFlags: defaultFeatureFlags,
    hostDaemonPort: 3001,
    marketplaceUrl: "https://marketplace.invalid/marketplace.json",
    inheritedSkillsRootPaths: [],
    inferenceFallbackModel: "test/mock-fallback-model",
    inferenceModel: "test/mock-model",
    isDevelopment: true,
    managedEnvironmentRetireGraceMs: MANAGED_ENVIRONMENT_RETIRE_GRACE_MS,
    openAiApiKey: "test-openai-key",
    serverPort: 3334,
    sharedSkillRoots: { user: [], project: [] },
    transcriptionModel: "test/mock-transcription",
    appUrl: "https://bb.example.test",
    ...configOverrides,
  };
  const terminalSessions = new TerminalSessionLifecycle({
    attachTimeoutMs: 50,
    ...(terminalCloseTimeoutMs === undefined
      ? {}
      : { closeTimeoutMs: terminalCloseTimeoutMs }),
    config,
    db,
    hub,
    logger: testLogger,
    openTimeoutMs: 50,
  });
  const bbAppManagedConfig = await createBbAppManagedConfigReloader({
    config,
    hub,
    logger: testLogger,
  });
  const telemetry = createNoopTelemetryService();
  const skillTreeRegistry = new SkillTreeRegistry();
  const aiServices = createAiServiceRegistry();
  const pendingInteractions = new PendingInteractionLifecycle({
    config,
    db,
    hub,
    lifecycleDedupers,
    logger: testLogger,
    machineAuth: testMachineAuth,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    skillTreeRegistry,
    telemetry,
    terminalSessions,
  });
  pendingInteractions.start();
  const appVersion =
    appVersionService ??
    createAppVersionService({
      config,
      logger: testLogger,
    });
  const deps: ServerAppDeps = {
    appVersion,
    bbAppManagedConfig,
    config,
    db,
    hub,
    lifecycleDedupers,
    logger: testLogger,
    machineAuth: testMachineAuth,
    pendingInteractions,
    providerRegistry,
    pluginHostArtifacts,
    providerNativeRoots,
    aiServices,
    skillTreeRegistry,
    telemetry,
    terminalSessions,
    watchInterests,
    sharedPorts,
    workspaceReadCaches,
  };
  const { app, pluginCatalogService, pluginService } = createApp(deps);

  return {
    app,
    config,
    db,
    deps,
    hub,
    pluginService,
    pluginCatalogService,
    async cleanup(): Promise<void> {
      await pluginService.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export async function withTestHarness<T>(
  run: (harness: TestAppHarness) => Promise<T>,
): Promise<T>;
export async function withTestHarness<T>(
  overrides: TestAppHarnessConfigOverrides,
  run: (harness: TestAppHarness) => Promise<T>,
): Promise<T>;
export async function withTestHarness<T>(
  overridesOrRun:
    | TestAppHarnessConfigOverrides
    | ((harness: TestAppHarness) => Promise<T>),
  maybeRun?: (harness: TestAppHarness) => Promise<T>,
): Promise<T> {
  const overrides: TestAppHarnessConfigOverrides =
    typeof overridesOrRun === "function" ? {} : overridesOrRun;
  const run = typeof overridesOrRun === "function" ? overridesOrRun : maybeRun;
  if (!run) {
    throw new Error("withTestHarness requires a run callback");
  }
  const harness = await createTestAppHarness(overrides);
  try {
    return await run(harness);
  } finally {
    await harness.cleanup();
  }
}

export async function startTestServer(
  overrides: TestAppHarnessConfigOverrides = {},
): Promise<RunningTestServer> {
  const harness = await createTestAppHarness(overrides);
  let addressInfo: AddressInfo | null = null;
  const { app, closeWebSockets, injectWebSocket, pluginService } = createApp(
    harness.deps,
  );
  const server = serve(
    {
      hostname: TEST_SERVER_HOST,
      port: 0,
      fetch: app.fetch,
    },
    (info) => {
      addressInfo = info;
    },
  );
  injectWebSocket(server);

  while (!addressInfo) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const resolvedAddress: AddressInfo = addressInfo;
  harness.config.serverPort = resolvedAddress.port;

  return {
    ...harness,
    app,
    pluginService,
    baseUrl: `http://${TEST_SERVER_HOST}:${resolvedAddress.port}`,
    async close(): Promise<void> {
      const closeServer = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await closeWebSockets();
      await closeServer;
      await harness.cleanup();
    },
  };
}
