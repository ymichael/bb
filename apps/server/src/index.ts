import { serve } from "@hono/node-server";
import { commonConfig, serverConfig } from "@bb/config/server";
import { createLogger } from "@bb/logger";
import { sweepExpiredCommands, sweepExpiredLeases, sweepManagedEnvironments } from "@bb/db";
import { initDb } from "./db.js";
import { createApp } from "./server.js";
import { maybeCleanupEnvironment } from "./services/environment-cleanup.js";
import { NotificationHub } from "./ws/hub.js";

const logger = createLogger({ component: "server" });
const db = initDb(serverConfig.BB_DATABASE_URL);
const hub = new NotificationHub();
const { app, injectWebSocket } = createApp({
  config: {
    authToken: commonConfig.BB_SECRET_TOKEN,
    dataDir: commonConfig.BB_DATA_DIR,
    hostDaemonPort: Number.isFinite(Number.parseInt(process.env.BB_HOST_DAEMON_PORT ?? "3001", 10))
      ? Number.parseInt(process.env.BB_HOST_DAEMON_PORT ?? "3001", 10)
      : null,
    inferenceModel: serverConfig.BB_INFERENCE_MODEL,
    openAiApiKey: serverConfig.OPENAI_API_KEY,
    serverUrl: process.env.BB_SERVER_URL ?? `http://localhost:${serverConfig.BB_SERVER_PORT}`,
  },
  db,
  hub,
  logger,
});

setInterval(() => {
  sweepExpiredCommands(db, hub);
  sweepExpiredLeases(db, hub);
  for (const environment of sweepManagedEnvironments(db)) {
    void maybeCleanupEnvironment({ db, hub }, environment.id);
  }
}, 10_000).unref();

const server = serve({
  port: serverConfig.BB_SERVER_PORT,
  fetch: app.fetch,
});
injectWebSocket(server);

logger.info({ port: serverConfig.BB_SERVER_PORT }, "Server listening");
