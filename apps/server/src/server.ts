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
  EnvironmentRepository,
  ProjectRepository,
  ThreadEnvironmentAttachmentRepository,
  ThreadRepository,
  EventRepository,
} from "@bb/db";
import type { ProviderToolCallResponse, SpawnThreadRequest } from "@bb/core";
import {
  createCodexLlmCompletionService,
  createProviderAdapter,
  listAvailableProviderInfos,
  resolveDefaultProviderId,
  type ProviderAdapter,
  type ProviderToolHost,
} from "@bb/provider-adapters";
import {
  createDefaultEnvironmentRegistry,
  listAvailableEnvironmentInfos,
} from "@bb/environment";
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
import {
  resolveEnvironmentAgentSessionTimingOptions,
  type EnvironmentAgentSessionTimingOptions,
} from "./environment-agent-timing.js";
import { composeProviderToolHosts, createManagerProviderToolHost } from "./manager-tools.js";
import { ProviderSessionController } from "./provider-session-controller.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function isToolCallResponseEnvelope(
  value: unknown,
): value is { toolCallResponse: ProviderToolCallResponse } {
  return (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && "toolCallResponse" in value
  );
}

export interface ServerDeps {
  projectRepo: ProjectRepository;
  environmentRepo?: EnvironmentRepository;
  threadEnvironmentAttachmentRepo?: ThreadEnvironmentAttachmentRepository;
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
  environmentAgentSessionOptions?: EnvironmentAgentSessionTimingOptions;
  providerToolHost?: ProviderToolHost;
  requestShutdown?: (reason: string) => void;
  requestRestart?: (reason: string) => void;
}

export function createServer(deps: ServerDeps) {
  const app = new Hono();
  const runtimeEnv = deps.runtimeEnv ?? process.env;

  // Request logging
  app.use(logger());
  app.use(async (c, next) => {
    const startedAt = performance.now();
    await next();
    if (!isPerfDebugEnabled()) {
      return;
    }
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    c.header("x-bb-handler-ms", String(durationMs));
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
  const defaultProviderId = resolveDefaultProviderId(runtimeEnv);
  const provider = deps.provider ?? createProviderAdapter({ providerId: defaultProviderId });
  let threadManager: Orchestrator;
  const managerToolHost = createManagerProviderToolHost({
    getThreadManager: () => threadManager,
  });
  const providerToolHost = composeProviderToolHosts([
    deps.providerToolHost,
    managerToolHost,
  ]);
  const configuredProviderController = new ProviderSessionController({
    provider,
    resolveDynamicTools: ({ request }: { request: SpawnThreadRequest }) =>
      request.type === "manager"
        ? providerToolHost?.listTools()
        : deps.providerToolHost?.listTools(),
    ...(providerToolHost ? { toolHost: providerToolHost } : {}),
    onNotification: (threadId, event) => {
      threadManager.handleAgentServerNotification(threadId, event);
    },
    logger: console,
  });
  const providerCatalog = listAvailableProviderInfos();
  const environmentRegistry = createDefaultEnvironmentRegistry();
  const environmentCatalog = listAvailableEnvironmentInfos(environmentRegistry);
  const scheduler = new InMemorySchedulerService();
  const llmCompletionService = createCodexLlmCompletionService();
  const environmentAgentSessionManager = new EnvironmentAgentSessionManager(
    deps.environmentAgentSessionRepo,
  );
  const resolveAttachedEnvironmentId = (threadId: string): string | undefined =>
    deps.threadEnvironmentAttachmentRepo?.getByThreadId(threadId)?.environmentId;
  const listAttachedThreadIds = (environmentId: string): string[] =>
    deps.threadEnvironmentAttachmentRepo?.listByEnvironmentId(environmentId).map((row) =>
      row.threadId
    ) ?? [];
  const environmentAgentCommandDispatcher = new EnvironmentAgentCommandDispatcher(
    deps.environmentAgentSessionRepo,
    deps.environmentAgentCommandRepo,
    {
      resolveEnvironmentId: resolveAttachedEnvironmentId,
    },
  );
  const daemonRuntimeEnv = {
    ...runtimeEnv,
    ...(deps.daemonBaseUrl
      ? { BB_DAEMON_URL: deps.daemonBaseUrl }
      : {}),
  };
  const environmentAgentSessionOptions = {
    ...resolveEnvironmentAgentSessionTimingOptions(daemonRuntimeEnv),
    ...(deps.environmentAgentSessionOptions ?? {}),
  };
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
      ...environmentAgentSessionOptions,
      commandDispatcher: environmentAgentCommandDispatcher,
      eventApplier: environmentAgentEventApplier,
      providerRequestHandler: ({ threadId, request }) =>
        threadManager.handleEnvironmentAgentProviderRequest({
          threadId,
          requestId: request.requestId,
          method: request.method,
          ...(request.params !== undefined ? { params: request.params } : {}),
          ...(request.providerId ? { providerId: request.providerId } : {}),
          ...(request.normalizedMethod
            ? { normalizedMethod: request.normalizedMethod }
            : {}),
          ...(request.toolCall ? { toolCall: request.toolCall } : {}),
        }).then((result) => (isToolCallResponseEnvelope(result) ? result : { result }))
        .catch((error: unknown) => ({
          errorMessage: error instanceof Error ? error.message : String(error),
        })),
      resolveEnvironmentId: resolveAttachedEnvironmentId,
      listAttachedThreadIds,
      onSessionInvalidated: (session) => {
        if (session.environmentId && deps.threadEnvironmentAttachmentRepo) {
          for (
            const attachment of deps.threadEnvironmentAttachmentRepo.listByEnvironmentId(
              session.environmentId,
            )
          ) {
            threadManager.handleEnvironmentAgentSessionInvalidated(
              attachment.threadId,
              session.closeReason,
            );
          }
          return;
        }
        threadManager.handleEnvironmentAgentSessionInvalidated(
          session.threadId,
          session.closeReason,
        );
      },
    },
  );
  threadManager = new Orchestrator(
    deps.threadRepo,
    deps.eventRepo,
    deps.projectRepo,
    wsManager,
    llmCompletionService,
    configuredProviderController,
    daemonRuntimeEnv,
    environmentRegistry,
    providerCatalog,
    environmentCatalog,
    scheduler,
    environmentAgentCommandDispatcher,
    environmentAgentSessionService,
    deps.environmentAgentSessionRepo,
    deps.environmentRepo,
    deps.threadEnvironmentAttachmentRepo,
    providerToolHost,
  );
  const environmentAgentLeaseSweepIntervalMs =
    environmentAgentSessionOptions.leaseSweepIntervalMs ?? 5_000;
  const environmentAgentLeaseSweepInterval = setInterval(() => {
    environmentAgentSessionService.expireLeases();
  }, environmentAgentLeaseSweepIntervalMs);
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
    environmentRepo: deps.environmentRepo,
    threadEnvironmentAttachmentRepo: deps.threadEnvironmentAttachmentRepo,
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
      environmentAgentSessionRepo: deps.environmentAgentSessionRepo,
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
          "BB server is running. Web UI not built yet — run `pnpm build` in apps/app.",
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
