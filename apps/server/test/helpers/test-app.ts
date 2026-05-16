import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { DbConnection } from "@bb/db";
import {
  defaultFeatureFlags,
  type FeatureFlags,
  type HostType,
} from "@bb/domain";
import { initDb } from "../../src/db.js";
import { createApp } from "../../src/server.js";
import { createHostLifecycleService } from "../../src/services/hosts/host-lifecycle-service.js";
import { PendingInteractionLifecycle } from "../../src/services/interactions/pending-interactions.js";
import { createMachineAuthService } from "../../src/services/machine-auth.js";
import { TerminalSessionLifecycle } from "../../src/services/terminals/terminal-session-lifecycle.js";
import { createLifecycleDedupers } from "../../src/lifecycle-dedupers.js";
import type { AppDeps, ServerRuntimeConfig } from "../../src/types.js";
import type { NotificationHub } from "../../src/ws/hub.js";
import { NotificationHub as NotificationHubImpl } from "../../src/ws/hub.js";

const TEST_MACHINE_KEY_PREFIX = "test-daemon-key";
const TEST_SERVER_HOST = "127.0.0.1";

export interface TestAppHarness {
  app: ReturnType<typeof createApp>["app"];
  config: ServerRuntimeConfig;
  db: DbConnection;
  deps: AppDeps;
  hub: NotificationHub;
  cleanup(): Promise<void>;
}

export interface RunningTestServer extends TestAppHarness {
  baseUrl: string;
  close(): Promise<void>;
}

type TestFeatureFlagOverrides = Partial<FeatureFlags>;
type OptionalTestFeatureFlagOverrides = TestFeatureFlagOverrides | undefined;

export type TestAppHarnessConfigOverrides = Omit<
  Partial<ServerRuntimeConfig>,
  "featureFlags"
> & {
  featureFlags?: TestFeatureFlagOverrides;
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

function resolveTestFeatureFlags(
  overrides: OptionalTestFeatureFlagOverrides,
): FeatureFlags {
  return {
    askUserQuestion:
      overrides?.askUserQuestion ?? defaultFeatureFlags.askUserQuestion,
    terminals: overrides?.terminals ?? defaultFeatureFlags.terminals,
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

export async function createTestAppHarness(
  overrides: TestAppHarnessConfigOverrides = {},
): Promise<TestAppHarness> {
  const { featureFlags: featureFlagOverrides, ...configOverrides } = overrides;
  const dataDir = await mkdtemp(join(tmpdir(), "bb-server-test-"));
  const db = initDb(":memory:");
  const hub = new NotificationHubImpl();
  const hostLifecycle = createHostLifecycleService();
  const pendingInteractions = new PendingInteractionLifecycle({
    db,
    hub,
    logger: testLogger,
  });
  const terminalSessions = new TerminalSessionLifecycle({
    attachTimeoutMs: 50,
    db,
    hub,
    logger: testLogger,
    openTimeoutMs: 50,
  });
  pendingInteractions.start();
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
    dataDir,
    featureFlags: resolveTestFeatureFlags(featureFlagOverrides),
    hostDaemonPort: 3001,
    inferenceModel: "test/mock-model",
    isDevelopment: true,
    openAiApiKey: "test-openai-key",
    serverPort: 3334,
    appUrl: "https://bb.example.test",
    ...configOverrides,
  };
  const deps: AppDeps = {
    config,
    db,
    hostLifecycle,
    hub,
    lifecycleDedupers,
    logger: testLogger,
    machineAuth: testMachineAuth,
    pendingInteractions,
    terminalSessions,
  };
  const { app } = createApp(deps);

  return {
    app,
    config,
    db,
    deps,
    hub,
    async cleanup(): Promise<void> {
      hostLifecycle.dispose();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export async function startTestServer(
  overrides: TestAppHarnessConfigOverrides = {},
): Promise<RunningTestServer> {
  const harness = await createTestAppHarness(overrides);
  let addressInfo: AddressInfo | null = null;
  const { app, closeWebSockets, injectWebSocket } = createApp(harness.deps);
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
