import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import type {
  EnvironmentAgentCommandRepository,
  EnvironmentAgentCursorRepository,
  EnvironmentAgentSessionRepository,
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
import { EnvironmentAgentCommandDispatcher } from "./environment-agent-command-dispatcher.js";
import { EnvironmentAgentEventApplier } from "./environment-agent-event-applier.js";
import { EnvironmentAgentSessionManager } from "./environment-agent-session-manager.js";
import { EnvironmentAgentSessionService } from "./environment-agent-session-service.js";
import { resolveManagedArtifactSweepIntervalMs } from "./managed-artifact-reconciler.js";
import { createSystemHealthReporter } from "./system-health-report.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerDeps {
  projectRepo: ProjectRepository;
  threadRepo: ThreadRepository;
  eventRepo: EventRepository;
  environmentAgentSessionRepo: EnvironmentAgentSessionRepository;
  environmentAgentCursorRepo: EnvironmentAgentCursorRepository;
  environmentAgentCommandRepo: EnvironmentAgentCommandRepository;
  provider?: ProviderAdapter;
  runtimeEnv?: NodeJS.ProcessEnv;
  daemonBaseUrl?: string;
  dbPath: string;
  daemonLogFilePath: string;
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
  const environmentAgentSessionManager = new EnvironmentAgentSessionManager(
    deps.environmentAgentSessionRepo,
  );
  const environmentAgentCommandDispatcher = new EnvironmentAgentCommandDispatcher(
    deps.environmentAgentSessionRepo,
    deps.environmentAgentCommandRepo,
  );
  const daemonRuntimeEnv = {
    ...(deps.runtimeEnv ?? process.env),
    ...(deps.daemonBaseUrl
      ? { BEANBAG_DAEMON_URL: deps.daemonBaseUrl }
      : {}),
  };
  let threadManager: Orchestrator;
  const environmentAgentEventApplier = new EnvironmentAgentEventApplier(
    deps.environmentAgentCursorRepo,
    {
      ingestReplayedEnvironmentAgentEvents: ({ threadId, events }) =>
        threadManager.ingestReplayedEnvironmentAgentEvents({ threadId, events }),
    },
  );
  const environmentAgentSessionService = new EnvironmentAgentSessionService(
    environmentAgentSessionManager,
    deps.environmentAgentCursorRepo,
    {
      commandDispatcher: environmentAgentCommandDispatcher,
      eventApplier: environmentAgentEventApplier,
      onSessionInvalidated: (session) => {
        threadManager.handleEnvironmentAgentSessionInvalidated(session.threadId);
      },
    },
  );
  threadManager = new Orchestrator(
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
    environmentAgentCommandDispatcher,
    environmentAgentSessionService,
    deps.environmentAgentSessionRepo,
  );
  const environmentAgentLeaseSweepInterval = setInterval(() => {
    environmentAgentSessionService.expireLeases();
  }, 5_000);
  environmentAgentLeaseSweepInterval.unref();
  const managedArtifactSweepIntervalMs = resolveManagedArtifactSweepIntervalMs(daemonRuntimeEnv);
  const managedArtifactSweepInterval = managedArtifactSweepIntervalMs > 0
    ? setInterval(() => {
      void threadManager.reconcileManagedArtifacts().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Managed artifact cleanup skipped: ${message}`);
      });
    }, managedArtifactSweepIntervalMs)
    : undefined;
  managedArtifactSweepInterval?.unref();

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
    environmentAgentSessionService,
    wsManager,
    startTime,
    requestShutdown: deps.requestShutdown,
    requestRestart: deps.requestRestart,
    shouldRestart: () => restartRecommendationMonitor.shouldRestart(),
    getHealthReport: createSystemHealthReporter({
      projectRepo: deps.projectRepo,
      threadRepo: deps.threadRepo,
      getRunningCount: () => threadManager.getRunningCount(),
      startTime,
      dbPath: deps.dbPath,
      daemonLogFilePath: deps.daemonLogFilePath,
      runtimeEnv: daemonRuntimeEnv,
    }),
    runtimeEnv: daemonRuntimeEnv,
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
    close: () => {
      clearInterval(environmentAgentLeaseSweepInterval);
      if (managedArtifactSweepInterval) {
        clearInterval(managedArtifactSweepInterval);
      }
      restartRecommendationMonitor.close();
    },
  };
}

export type AppType = ReturnType<typeof createServer>["app"];
