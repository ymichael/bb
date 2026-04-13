import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { DbConnection } from "@bb/db";
import type { HostType } from "@bb/domain";
import { initDb } from "../../src/db.js";
import { createApp } from "../../src/server.js";
import { createCloudAuthService } from "../../src/services/cloud-auth/service.js";
import { createHostLifecycleService } from "../../src/services/hosts/host-lifecycle-service.js";
import { createSandboxHostRegistry } from "../../src/services/hosts/sandbox-registry.js";
import {
  DEFAULT_SANDBOX_PENDING_INTERACTION_EXPIRY_MS,
  PendingInteractionLifecycle,
} from "../../src/services/interactions/pending-interactions.js";
import { createMachineAuthService } from "../../src/services/machine-auth.js";
import { createSandboxEnvService } from "../../src/services/sandbox-env/service.js";
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

const testLogger = {
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
  if (
    (hostType !== "persistent" && hostType !== "ephemeral") ||
    hostId.length === 0
  ) {
    return null;
  }

  return {
    hostId,
    hostType,
  };
}

export function createTestDaemonHostKey(args: Partial<TestDaemonKeyParts> = {}): string {
  return encodeTestDaemonKey({
    hostId: args.hostId ?? "host-1",
    hostType: args.hostType ?? "persistent",
  });
}

export async function createTestAppHarness(
  overrides: Partial<ServerRuntimeConfig> = {},
): Promise<TestAppHarness> {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-server-test-"));
  const db = initDb(":memory:");
  const hub = new NotificationHubImpl();
  const hostLifecycle = createHostLifecycleService();
  const pendingInteractions = new PendingInteractionLifecycle({
    db,
    hub,
    sandboxInteractionExpiryMs: DEFAULT_SANDBOX_PENDING_INTERACTION_EXPIRY_MS,
  });
  pendingInteractions.start();
  const sandboxRegistry = createSandboxHostRegistry();
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
  const cloudAuth = await createCloudAuthService({
    dataDir,
    db,
    logger: testLogger,
  });
  const sandboxEnv = await createSandboxEnvService({
    dataDir,
    db,
    logger: testLogger,
  });
  const config: ServerRuntimeConfig = {
    anthropicApiKey: "",
    dataDir,
    e2bApiKey: "test-e2b-api-key",
    e2bTemplate: "test-e2b-template",
    githubPat: "",
    hostDaemonPort: 3001,
    inferenceModel: "test/mock-model",
    openAiApiKey: "test-openai-key",
    publicUrl: "https://bb.example.test",
    sandboxActivityExtensionDebounceMs: 30_000,
    sandboxIdleThresholdMs: 300_000,
    ...overrides,
  };
  const deps: AppDeps = {
    cloudAuth,
    config,
    db,
    hostLifecycle,
    hub,
    logger: testLogger,
    machineAuth: testMachineAuth,
    sandboxEnv,
    pendingInteractions,
    sandboxRegistry,
  };
  const { app } = createApp(deps);

  return {
    app,
    config,
    db,
    deps,
    hub,
    async cleanup(): Promise<void> {
      await cloudAuth.dispose();
      hostLifecycle.dispose();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export async function startTestServer(
  overrides: Partial<ServerRuntimeConfig> = {},
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

  return {
    ...harness,
    app,
    baseUrl: `http://${TEST_SERVER_HOST}:${addressInfo.port}`,
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
