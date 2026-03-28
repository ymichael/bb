import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { DbConnection } from "@bb/db";
import { initDb } from "../../src/db.js";
import { createApp } from "../../src/server.js";
import type { AppDeps, ServerRuntimeConfig } from "../../src/types.js";
import type { NotificationHub } from "../../src/ws/hub.js";
import { NotificationHub as NotificationHubImpl } from "../../src/ws/hub.js";

export const TEST_AUTH_TOKEN = "test-secret-token";
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

export async function createTestAppHarness(
  overrides: Partial<ServerRuntimeConfig> = {},
): Promise<TestAppHarness> {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-server-test-"));
  const db = initDb(":memory:");
  const hub = new NotificationHubImpl();
  const config: ServerRuntimeConfig = {
    authToken: TEST_AUTH_TOKEN,
    dataDir,
    hostDaemonPort: 3001,
    inferenceModel: "test/mock-model",
    openAiApiKey: "test-openai-key",
    ...overrides,
  };
  const deps: AppDeps = {
    config,
    db,
    hub,
    logger: testLogger,
  };
  const { app } = createApp(deps);

  return {
    app,
    config,
    db,
    deps,
    hub,
    async cleanup(): Promise<void> {
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export async function startTestServer(
  overrides: Partial<ServerRuntimeConfig> = {},
): Promise<RunningTestServer> {
  const harness = await createTestAppHarness(overrides);
  let addressInfo: AddressInfo | null = null;
  const { app, injectWebSocket } = createApp(harness.deps);
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
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await harness.cleanup();
    },
  };
}
