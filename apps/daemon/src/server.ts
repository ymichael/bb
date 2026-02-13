import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import type {
  ProjectRepository,
  ThreadRepository,
  EventRepository,
  TaskRepository,
} from "@beanbag/db";
import { WSManager } from "./ws.js";
import { ThreadManager } from "./thread-manager.js";
import { generateCodexThreadTitle } from "./codex-title-generator.js";
import { createApiRoutes } from "./routes/index.js";
import { createProviderAdapter } from "./provider-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerDeps {
  projectRepo: ProjectRepository;
  threadRepo: ThreadRepository;
  eventRepo: EventRepository;
  taskRepo: TaskRepository;
}

export function createServer(deps: ServerDeps) {
  const app = new Hono();

  // Request logging
  app.use(logger());

  // WebSocket setup
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Create managers
  const wsManager = new WSManager();
  const provider = createProviderAdapter({
    codexTitleGenerator: async ({ input, cwd }) =>
      generateCodexThreadTitle({ input, cwd }),
  });
  const threadManager = new ThreadManager(
    deps.threadRepo,
    deps.eventRepo,
    deps.projectRepo,
    wsManager,
    provider,
  );

  // WebSocket handler
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        wsManager.handleConnection(ws.raw!);
      },
    })),
  );

  // API routes
  const startTime = Date.now();
  const apiRoutes = createApiRoutes({
    projectRepo: deps.projectRepo,
    taskRepo: deps.taskRepo,
    threadManager,
    startTime,
  });

  const appWithRoutes = app.route("/api/v1", apiRoutes);

  // Static file serving for the web UI
  const webDistPath = resolve(__dirname, "../../web/dist");
  if (existsSync(webDistPath)) {
    app.use(
      "/*",
      serveStatic({
        root: resolve(webDistPath),
      }),
    );

    // SPA fallback — serve index.html for non-API, non-WS routes
    app.use("/*", serveStatic({ root: resolve(webDistPath), path: "index.html" }));
  } else {
    console.warn(
      `Web UI not found at ${webDistPath}. Static file serving disabled.`,
    );
    app.get("/*", (c) => {
      return c.json({
        message:
          "Beanbag daemon is running. Web UI not built yet — run `pnpm build` in apps/web.",
      });
    });
  }

  return {
    app: appWithRoutes,
    injectWebSocket,
    wsManager,
    threadManager,
  };
}

export type AppType = ReturnType<typeof createServer>["app"];
