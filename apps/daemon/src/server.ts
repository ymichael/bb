import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import type {
  ProjectRepository,
  ThreadRepository,
  EventRepository,
} from "@beanbag/db";
import {
  createCodexLlmCompletionService,
  createProviderAdapter,
  listAvailableProviderInfos,
  type ProviderAdapter,
} from "@beanbag/agent-server";
import {
  createDefaultEnvironmentRegistry,
  listAvailableEnvironmentInfos,
} from "@beanbag/environment";
import { WSManager } from "./ws.js";
import { Orchestrator } from "./orchestrator.js";
import { createApiRoutes } from "./routes/index.js";
import { InMemorySchedulerService } from "./scheduler-service.js";
import { createRestartRecommendationMonitor } from "./restart-recommendation.js";
import { isPerfDebugEnabled, logPerf } from "./perf.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerDeps {
  projectRepo: ProjectRepository;
  threadRepo: ThreadRepository;
  eventRepo: EventRepository;
  provider?: ProviderAdapter;
  daemonBaseUrl?: string;
  requestShutdown?: (reason: string) => void;
  requestRestart?: (reason: string) => void;
}

export function createServer(deps: ServerDeps) {
  const app = new Hono();

  // Request logging
  app.use(logger());
  app.use(async (c, next) => {
    const startedAt = performance.now();
    await next();
    if (!isPerfDebugEnabled()) {
      return;
    }
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    c.header("x-beanbag-handler-ms", String(durationMs));
    logPerf("http.request", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs,
    });
  });

  // WebSocket setup
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Create managers
  const wsManager = new WSManager();
  const provider = deps.provider ?? createProviderAdapter();
  const providerCatalog = listAvailableProviderInfos();
  const environmentRegistry = createDefaultEnvironmentRegistry();
  const environmentCatalog = listAvailableEnvironmentInfos(environmentRegistry);
  const scheduler = new InMemorySchedulerService();
  const llmCompletionService = createCodexLlmCompletionService();
  const daemonRuntimeEnv = {
    ...process.env,
    ...(deps.daemonBaseUrl
      ? { BEANBAG_DAEMON_URL: deps.daemonBaseUrl }
      : {}),
  };
  const threadManager = new Orchestrator(
    deps.threadRepo,
    deps.eventRepo,
    deps.projectRepo,
    wsManager,
    llmCompletionService,
    provider,
    daemonRuntimeEnv,
    environmentRegistry,
    providerCatalog,
    environmentCatalog,
    scheduler,
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
  const restartRecommendationMonitor = createRestartRecommendationMonitor(startTime, {
    onChange: () => {
      wsManager.broadcast("system", undefined, ["restart-policy-changed"]);
    },
  });
  const apiRoutes = createApiRoutes({
    projectRepo: deps.projectRepo,
    threadRepo: deps.threadRepo,
    eventRepo: deps.eventRepo,
    threadManager,
    wsManager,
    startTime,
    requestShutdown: deps.requestShutdown,
    requestRestart: deps.requestRestart,
    shouldRestart: () => restartRecommendationMonitor.shouldRestart(),
  });

  const appWithRoutes = app.route("/api/v1", apiRoutes);

  // Static file serving for the web UI
  const webDistPath = resolve(__dirname, "../../app/dist");
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
          "Beanbag daemon is running. Web UI not built yet — run `pnpm build` in apps/app.",
      });
    });
  }

  return {
    app: appWithRoutes,
    injectWebSocket,
    wsManager,
    threadManager,
    restartRecommendationMonitor,
  };
}

export type AppType = ReturnType<typeof createServer>["app"];
