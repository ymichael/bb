import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toOptionalString } from "@bb/config/strings";
import { commonConfig, serverConfig } from "@bb/config/server";
import { createLogger } from "@bb/logger";
import { initDb } from "./db.js";
import { createApp } from "./server.js";
import { createSandboxHostRegistry } from "./services/hosts/sandbox-registry.js";
import { createMachineAuthService } from "./services/machine-auth.js";
import { runPeriodicSweeps } from "./services/system/periodic-sweeps.js";
import type { ServerRuntimeConfig } from "./types.js";
import { NotificationHub } from "./ws/hub.js";

async function main(): Promise<void> {
  const logger = createLogger({ component: "server" });
  const db = initDb(serverConfig.BB_DATABASE_URL);
  const hub = new NotificationHub();
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

  const { app, injectWebSocket } = createApp(
    {
      config: runtimeConfig,
      db,
      hub,
      logger,
      machineAuth,
      sandboxRegistry,
    },
    { staticDir },
  );

  setInterval(() => {
    void runPeriodicSweeps({
      config: runtimeConfig,
      db,
      hub,
      logger,
      machineAuth,
      sandboxRegistry,
    });
  }, 10_000).unref();

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
}

void main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
