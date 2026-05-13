import { createNodeWebSocket } from "@hono/node-ws";
import { readFile, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { extname, join, resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { buildLocalAppOrigins } from "@bb/config/local-app-origins";
import { devEnvConfig } from "@bb/config/dev-env";
import { serverConfig } from "@bb/config/server";
import type { AppDeps } from "./types.js";
import { ApiError, errorToResponse } from "./errors.js";
import { registerAutomationRoutes } from "./routes/automations.js";
import { registerEnvironmentRoutes } from "./routes/environments.js";
import { registerHostRoutes } from "./routes/hosts.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerDevelopmentOnlyReplayRoutes } from "./routes/internal-replay.js";
import { registerThreadRoutes } from "./routes/threads/index.js";
import { registerInternalCommandRoutes } from "./internal/commands.js";
import { registerInternalCommandResultRoutes } from "./internal/command-result-route.js";
import { registerInternalEnvironmentChangeRoutes } from "./internal/environment-changes.js";
import { registerInternalEventRoutes } from "./internal/events.js";
import { registerInternalHostRoutes } from "./internal/hosts.js";
import { registerInternalInteractiveRequestRoutes } from "./internal/interactive-requests.js";
import { registerInternalSessionRoutes } from "./internal/session.js";
import { registerInternalToolCallRoutes } from "./internal/tool-calls.js";
import {
  setAuthenticatedDaemon,
  verifyAuthenticatedDaemon,
} from "./internal/auth.js";
import {
  onClientSocketClose,
  onClientSocketMessage,
  onClientSocketOpen,
} from "./ws/client-protocol.js";
import {
  onDaemonSocketClose,
  onDaemonSocketMessage,
  onDaemonSocketOpen,
  validateDaemonWebSocket,
} from "./ws/daemon-protocol.js";
import { roundDurationMs } from "./services/lib/duration.js";

export type CloseWebSockets = () => Promise<void>;
type NodeWebSocketServer = ReturnType<typeof createNodeWebSocket>["wss"];
type WebSocketCloseError = Error | undefined;

export interface ServerApp {
  app: Hono;
  closeWebSockets: CloseWebSockets;
  injectWebSocket: ReturnType<typeof createNodeWebSocket>["injectWebSocket"];
}

interface CloseWebSocketServerArgs {
  forceCloseAfterMs: number;
  reason: string;
  server: NodeWebSocketServer;
}

function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({ code: "unauthorized", message: "Unauthorized" }),
    {
      status: 401,
      headers: { "content-type": "application/json" },
    },
  );
}

function normalizeInternalAuthPath(path: string): string {
  if (path === "/") {
    return path;
  }
  return path.replace(/\/+$/u, "");
}

interface CreateAppOptions {
  slowApiRequestLogThresholdMs?: number;
  staticDir?: string;
}

const WEB_SOCKET_SHUTDOWN_CODE = 1001;
const WEB_SOCKET_SHUTDOWN_FORCE_CLOSE_MS = 1_000;
const WEB_SOCKET_SHUTDOWN_REASON = "server-shutdown";
const SLOW_API_REQUEST_LOG_THRESHOLD_MS = 1_000;
const THREAD_EVENT_WAIT_PATH_PATTERN =
  /^\/api\/v1\/threads\/[^/]+\/events\/wait$/u;

interface ShouldLogSlowApiRequestArgs {
  durationMs: number;
  path: string;
  thresholdMs: number;
}

function shouldLogSlowApiRequest(args: ShouldLogSlowApiRequestArgs): boolean {
  if (args.durationMs < args.thresholdMs) {
    return false;
  }
  return !THREAD_EVENT_WAIT_PATH_PATTERN.test(args.path);
}

function buildAllowedCorsOrigins(deps: AppDeps): Set<string> {
  return new Set<string>(
    buildLocalAppOrigins({
      serverPort: serverConfig.BB_SERVER_PORT,
      devAppPort: devEnvConfig.BB_DEV_APP_PORT,
      appUrl: deps.config.appUrl,
    }),
  );
}

function closeWebSocketServer(args: CloseWebSocketServerArgs): Promise<void> {
  for (const client of args.server.clients) {
    client.close(WEB_SOCKET_SHUTDOWN_CODE, args.reason);
  }

  return new Promise<void>((resolvePromise, reject) => {
    const forceCloseTimeout = setTimeout(() => {
      for (const client of args.server.clients) {
        client.terminate();
      }
    }, args.forceCloseAfterMs);
    forceCloseTimeout.unref();

    args.server.close((error: WebSocketCloseError) => {
      clearTimeout(forceCloseTimeout);
      if (error) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });
}

export function createApp(
  deps: AppDeps,
  options?: CreateAppOptions,
): ServerApp {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({
    app,
  });
  const allowedCorsOrigins = buildAllowedCorsOrigins(deps);
  const slowApiRequestLogThresholdMs =
    options?.slowApiRequestLogThresholdMs ?? SLOW_API_REQUEST_LOG_THRESHOLD_MS;

  app.use(
    "*",
    cors({
      origin: (origin, context) => {
        const requestOrigin = new URL(context.req.url).origin;
        if (origin === requestOrigin || allowedCorsOrigins.has(origin)) {
          return origin;
        }
        return null;
      },
    }),
  );
  app.onError((error) => errorToResponse(error, deps.logger));
  app.get("/health", (context) => context.json({ ok: true }));
  app.use("/api/v1/*", async (context, next) => {
    const startedAt = performance.now();
    await next();
    const durationMs = performance.now() - startedAt;
    const path = context.req.path;
    if (
      shouldLogSlowApiRequest({
        durationMs,
        path,
        thresholdMs: slowApiRequestLogThresholdMs,
      })
    ) {
      deps.logger.warn(
        {
          durationMs: roundDurationMs(durationMs),
          method: context.req.method,
          path,
          status: context.res.status,
        },
        "Slow API request",
      );
    }
  });
  app.use("/api/v1/development-only/*", async (_context, next) => {
    if (!deps.config.isDevelopment) {
      throw new ApiError(404, "not_found", "Not found");
    }
    return next();
  });
  app.use("/internal/*", async (context, next) => {
    const normalizedPath = normalizeInternalAuthPath(context.req.path);
    if (normalizedPath === "/internal/hosts/enroll") {
      return next();
    }
    if (normalizedPath === "/internal/ws") {
      return next();
    }
    try {
      const daemon = await verifyAuthenticatedDaemon(
        deps,
        context.req.header("authorization"),
      );
      setAuthenticatedDaemon(context, daemon);
    } catch {
      return unauthorizedResponse();
    }
    return next();
  });
  const publicApi = new Hono();
  registerProjectRoutes(publicApi, deps);
  registerAutomationRoutes(publicApi, deps);
  registerHostRoutes(publicApi, deps);
  registerEnvironmentRoutes(publicApi, deps);
  registerThreadRoutes(publicApi, deps);
  registerSystemRoutes(publicApi, deps);
  registerDevelopmentOnlyReplayRoutes(publicApi, deps);
  app.route("/api/v1", publicApi);

  const internalApi = new Hono();
  registerInternalHostRoutes(internalApi, deps);
  registerInternalSessionRoutes(internalApi, deps);
  registerInternalCommandRoutes(internalApi, deps);
  registerInternalCommandResultRoutes(internalApi, deps);
  registerInternalEnvironmentChangeRoutes(internalApi, deps);
  registerInternalEventRoutes(internalApi, deps);
  registerInternalToolCallRoutes(internalApi, deps);
  registerInternalInteractiveRequestRoutes(internalApi, deps);
  app.route("/internal", internalApi);

  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen: (_event, socket) => onClientSocketOpen(deps.hub, socket),
      onMessage: (event, socket) =>
        onClientSocketMessage(deps.hub, socket, event.data),
      onClose: (_event, socket) => onClientSocketClose(deps.hub, socket),
    })),
  );

  app.get(
    "/internal/ws",
    upgradeWebSocket(async (context) => {
      const websocketContext = await validateDaemonWebSocket(deps, {
        authorizationHeader: context.req.header("authorization"),
        protocolHeader: context.req.header("sec-websocket-protocol"),
        sessionId: context.req.query("sessionId") ?? null,
      });
      return {
        onOpen: (_event, socket) =>
          onDaemonSocketOpen(deps, {
            ...websocketContext,
            socket,
          }),
        onMessage: (event, socket) =>
          onDaemonSocketMessage(deps, {
            hostId: websocketContext.hostId,
            raw: event.data,
            sessionId: websocketContext.sessionId,
            socket,
          }),
        onClose: () => onDaemonSocketClose(deps, websocketContext.sessionId),
      };
    }),
  );

  if (!options?.staticDir) {
    app.get("/", (context) => context.text("bb server"));
  }

  if (options?.staticDir) {
    const root = resolve(options.staticDir);
    const MIME: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".webp": "image/webp",
      ".map": "application/json",
    };

    app.get("*", async (context) => {
      const urlPath =
        context.req.path === "/" ? "/index.html" : context.req.path;
      const filePath = join(root, urlPath);
      if (!filePath.startsWith(root)) {
        return context.notFound();
      }
      try {
        const fileStat = await stat(filePath);
        if (fileStat.isFile()) {
          const content = await readFile(filePath);
          const contentType =
            MIME[extname(filePath)] ?? "application/octet-stream";
          return new Response(content, {
            headers: { "content-type": contentType },
          });
        }
      } catch {
        // File not found — fall through to SPA fallback
      }
      const indexHtml = await readFile(join(root, "index.html"));
      return new Response(indexHtml, {
        headers: { "content-type": "text/html" },
      });
    });
  }

  return {
    app,
    closeWebSockets: () =>
      closeWebSocketServer({
        forceCloseAfterMs: WEB_SOCKET_SHUTDOWN_FORCE_CLOSE_MS,
        reason: WEB_SOCKET_SHUTDOWN_REASON,
        server: wss,
      }),
    injectWebSocket,
  };
}
