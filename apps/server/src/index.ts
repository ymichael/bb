import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toOptionalString } from "@bb/config/strings";
import { commonConfig, serverConfig } from "@bb/config/server";
import { createLogger } from "@bb/logger";
import { initDb } from "./db.js";
import { createApp } from "./server.js";
import { createCloudAuthService } from "./services/cloud-auth/service.js";
import { createHostLifecycleService } from "./services/hosts/host-lifecycle-service.js";
import { createSandboxHostRegistry } from "./services/hosts/sandbox-registry.js";
import { createMachineAuthService } from "./services/machine-auth.js";
import { createSandboxEnvService } from "./services/sandbox-env/service.js";
import { runPeriodicSweeps } from "./services/system/periodic-sweeps.js";
import type { ServerRuntimeConfig } from "./types.js";
import { NotificationHub } from "./ws/hub.js";

async function main(): Promise<void> {
  const logger = createLogger({ component: "server" });
  const db = initDb(serverConfig.BB_DATABASE_URL);
  const hub = new NotificationHub();
  const hostLifecycle = createHostLifecycleService();
  const sandboxRegistry = createSandboxHostRegistry();
  const publicUrl = toOptionalString(serverConfig.BB_PUBLIC_URL);

  const selfDir = dirname(fileURLToPath(import.meta.url));
  const appDistDir = resolve(selfDir, "../../app/dist");
  const staticDir =
    process.env.NODE_ENV === "production" && existsSync(appDistDir) ? appDistDir : undefined;
  const runtimeConfig: ServerRuntimeConfig = {
    anthropicApiKey: serverConfig.ANTHROPIC_API_KEY,
    dataDir: commonConfig.BB_DATA_DIR,
    e2bApiKey: serverConfig.E2B_API_KEY,
    e2bTemplate: serverConfig.E2B_TEMPLATE,
    githubPat: serverConfig.BB_GITHUB_PAT,
    hostDaemonPort: serverConfig.BB_HOST_DAEMON_PORT,
    inferenceModel: serverConfig.BB_INFERENCE_MODEL,
    openAiApiKey: serverConfig.OPENAI_API_KEY,
    sandboxActivityExtensionDebounceMs:
      serverConfig.BB_SANDBOX_ACTIVITY_EXTENSION_DEBOUNCE_MS,
    sandboxIdleThresholdMs: serverConfig.BB_SANDBOX_IDLE_THRESHOLD_MS,
  };

  if (publicUrl !== undefined) {
    runtimeConfig.publicUrl = publicUrl;
  }

  const machineAuth = await createMachineAuthService({
    dataDir: commonConfig.BB_DATA_DIR,
    db,
    logger,
  });
  await machineAuth.ensureReady();
  const cloudAuth = await createCloudAuthService({
    dataDir: commonConfig.BB_DATA_DIR,
    db,
    logger,
  });
  const sandboxEnv = await createSandboxEnvService({
    dataDir: commonConfig.BB_DATA_DIR,
    db,
    logger,
  });

  const { app, injectWebSocket } = createApp(
    {
      cloudAuth,
      config: runtimeConfig,
      db,
      hostLifecycle,
      hub,
      logger,
      machineAuth,
      sandboxEnv,
      sandboxRegistry,
    },
    { staticDir },
  );

  const server = serve({
    port: serverConfig.BB_SERVER_PORT,
    fetch: app.fetch,
  });
  injectWebSocket(server);

  logger.info(
    {
      port: serverConfig.BB_SERVER_PORT,
      dataDir: commonConfig.BB_DATA_DIR,
    },
    "Server listening",
  );

  const sweepInterval = setInterval(() => {
    void runPeriodicSweeps({
      cloudAuth,
      config: runtimeConfig,
      db,
      hostLifecycle,
      hub,
      logger,
      machineAuth,
      sandboxEnv,
      sandboxRegistry,
    });
  }, 10_000);
  sweepInterval.unref();

  let shutdownPromise: Promise<void> | null = null;
  const runShutdown = (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      clearInterval(sweepInterval);
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
    })();
    return shutdownPromise;
  };

  process.once("SIGINT", () => {
    void runShutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void runShutdown().finally(() => process.exit(0));
  });
}

void main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
