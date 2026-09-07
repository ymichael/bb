import { registerDesktopBrowserRoutes } from "./routes/desktop-browsers.js";
import { createNodeWebSocket } from "@hono/node-ws";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { terminalWebSocketQuerySchema } from "@bb/server-contract";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import type { ServerAppDeps } from "./types.js";
import { ApiError, errorToResponse } from "./errors.js";
import { registerEnvironmentRoutes } from "./routes/environments.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerHostRoutes } from "./routes/hosts.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerThreadSectionRoutes } from "./routes/thread-sections.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerTerminalRoutes } from "./routes/terminals.js";
import { registerThreadRoutes } from "./routes/threads/index.js";
import { registerQueueRoutes } from "./routes/queue.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerPluginCatalogRoutes } from "./routes/plugin-catalog.js";
import { registerSkillsRegistryRoutes } from "./routes/skills-registry.js";
import {
  createPluginService,
  type PluginService,
} from "./services/plugins/plugin-service.js";
import { setPluginAgentContributions } from "./services/plugins/plugin-agent-contributions.js";
import { setPluginThreadEventEmitter } from "./services/plugins/plugin-thread-events.js";
import { setPluginHookProvider } from "./services/plugins/plugin-hook-registry.js";
import { requestQueuedMessageDispatch } from "./services/threads/queued-message-dispatch.js";
import { registerInternalEventRoutes } from "./internal/events.js";
import { registerInternalHostRoutes } from "./internal/hosts.js";
import { registerInternalInteractiveRequestRoutes } from "./internal/interactive-requests.js";
import { registerInternalPluginHostArtifactRoutes } from "./internal/plugin-host-artifacts.js";
import { registerInternalSessionRoutes } from "./internal/session.js";
import { registerInternalSkillRoutes } from "./internal/skills.js";
import { registerInternalToolCallRoutes } from "./internal/tool-calls.js";
import {
  setAuthenticatedDaemon,
  verifyAuthenticatedDaemon,
} from "./internal/auth.js";
import {
  captureTrustedRemoteAddress,
  resolveRequestAppSurface,
} from "./request-context.js";
import { runEventLoopWork } from "./services/system/event-loop-work.js";
import { runWithTelemetryAppSurface } from "./services/system/telemetry.js";
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
import {
  onTerminalSocketClose,
  onTerminalSocketMessage,
  onTerminalSocketOpen,
} from "./ws/terminal-protocol.js";
import {
  createBbAppArtifactService,
  type BbAppArtifactService,
} from "./services/install/bb-app-artifact.js";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import {
  createPluginCatalogService,
  type PluginCatalogService,
} from "./services/plugin-catalog/plugin-catalog-service.js";
import { callHostRetryableOnlineRpc } from "./services/hosts/online-rpc.js";
import {
  allowedAppOrigins,
  browserRequestProblem,
} from "./browser-request-guard.js";
import {
  callPluginHostRpc,
  disposePluginHostWorkers,
} from "./services/plugins/plugin-host-rpc.js";

const PLUGIN_WIRE_HTTP_PATH = /^\/api\/v1\/plugins\/[^/]+\/http(?:\/|$)/u;
import { rankAcceptedAssetEncodings } from "./asset-content-encoding.js";
import { apiJsonCompression } from "./api-response-compression.js";

type CloseWebSockets = () => Promise<void>;
type NodeWebSocketServer = ReturnType<typeof createNodeWebSocket>["wss"];
type WebSocketCloseError = Error | undefined;

interface ServerApp {
  app: Hono;
  closeWebSockets: CloseWebSockets;
  injectWebSocket: ReturnType<typeof createNodeWebSocket>["injectWebSocket"];
  pluginService: PluginService;
  pluginCatalogService: PluginCatalogService;
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
  bbAppArtifactService?: BbAppArtifactService;
  slowApiRequestLogThresholdMs?: number;
  staticDir?: string;
}

interface StaticResponseHeadersArgs {
  contentEncoding?: string;
  contentLength?: number;
  contentType: string;
  etag?: string;
  urlPath: string;
}

const STATIC_INDEX_CACHE_CONTROL = "no-cache";
const STATIC_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const STATIC_PUBLIC_FILE_CACHE_CONTROL = "public, max-age=86400";
const WEB_SOCKET_SHUTDOWN_CODE = 1001;
const WEB_SOCKET_SHUTDOWN_FORCE_CLOSE_MS = 1_000;
const WEB_SOCKET_SHUTDOWN_REASON = "server-shutdown";
const SLOW_API_REQUEST_LOG_THRESHOLD_MS = 1_000;
const INSTALL_MACHINE_SCRIPT_PATH = fileURLToPath(
  new URL("./assets/install-machine.sh", import.meta.url),
);
const THREAD_EVENT_WAIT_PATH_PATTERN =
  /^\/api\/v1\/threads\/[^/]+\/events\/wait$/u;
const PLUGIN_APP_ASSET_PATH_PATTERN =
  /^\/api\/v1\/plugins\/[^/]+\/assets\/app\.(?:js|css)$/u;
const PRECOMPRESSED_STATIC_FILES = [
  { encoding: "br", extension: ".br" },
  { encoding: "gzip", extension: ".gz" },
] as const;

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

function staticCacheControlForPath(urlPath: string): string {
  if (urlPath.startsWith("/assets/")) {
    return STATIC_ASSET_CACHE_CONTROL;
  }
  if (urlPath.endsWith(".html")) {
    return STATIC_INDEX_CACHE_CONTROL;
  }
  return STATIC_PUBLIC_FILE_CACHE_CONTROL;
}

function createStaticResponseHeaders(args: StaticResponseHeadersArgs): Headers {
  const headers = new Headers();
  headers.set("content-type", args.contentType);
  headers.set("cache-control", staticCacheControlForPath(args.urlPath));
  if (args.etag !== undefined) {
    headers.set("etag", args.etag);
  }
  if (args.contentEncoding !== undefined) {
    headers.set("content-encoding", args.contentEncoding);
    headers.set("vary", "Accept-Encoding");
  }
  if (args.contentLength !== undefined) {
    headers.set("content-length", String(args.contentLength));
  }
  return headers;
}

const shellEtagCache = new Map<
  string,
  { etag: string; mtimeMs: number; size: number }
>();

async function shellEtag(filePath: string): Promise<string | undefined> {
  try {
    const fileStat = await stat(filePath);
    const cached = shellEtagCache.get(filePath);
    if (
      cached !== undefined &&
      cached.size === fileStat.size &&
      cached.mtimeMs === fileStat.mtimeMs
    ) {
      return cached.etag;
    }
    const digest = createHash("sha256")
      .update(await readFile(filePath))
      .digest("hex");
    const etag = `W/"${digest.slice(0, 32)}"`;
    shellEtagCache.set(filePath, {
      etag,
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
    });
    return etag;
  } catch {
    return undefined;
  }
}

export function ifNoneMatchSatisfied(
  ifNoneMatchHeader: string,
  etag: string,
): boolean {
  if (ifNoneMatchHeader.trim() === "*") return true;
  const opaque = (tag: string): string => tag.trim().replace(/^W\//u, "");
  const target = opaque(etag);
  return ifNoneMatchHeader
    .split(",")
    .some((candidate) => opaque(candidate) === target);
}

const STATIC_MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".map": "application/json",
};

export function registerStaticAppRoutes(app: Hono, staticDir: string): void {
  const root = resolve(staticDir);

  const serveStaticAppFile = async (args: {
    acceptEncodingHeader: string | undefined;
    contentType: string;
    filePath: string;
    ifNoneMatchHeader: string | undefined;
    urlPath: string;
  }): Promise<Response> => {
    const etag =
      args.contentType === "text/html"
        ? await shellEtag(args.filePath)
        : undefined;
    if (
      etag !== undefined &&
      args.ifNoneMatchHeader !== undefined &&
      ifNoneMatchSatisfied(args.ifNoneMatchHeader, etag)
    ) {
      const headers = new Headers();
      headers.set("cache-control", staticCacheControlForPath(args.urlPath));
      headers.set("etag", etag);
      return new Response(null, { status: 304, headers });
    }
    const precompressedFile = await findPrecompressedStaticFile({
      acceptEncodingHeader: args.acceptEncodingHeader,
      contentType: args.contentType,
      filePath: args.filePath,
    });
    if (precompressedFile !== null) {
      const content = await readFile(precompressedFile.filePath);
      return new Response(content, {
        headers: createStaticResponseHeaders({
          contentEncoding: precompressedFile.encoding,
          contentLength: precompressedFile.contentLength,
          contentType: args.contentType,
          etag,
          urlPath: args.urlPath,
        }),
      });
    }
    const content = await readFile(args.filePath);
    return new Response(content, {
      headers: createStaticResponseHeaders({
        contentType: args.contentType,
        etag,
        urlPath: args.urlPath,
      }),
    });
  };

  app.get("*", async (context) => {
    const urlPath = context.req.path === "/" ? "/index.html" : context.req.path;
    const filePath = join(root, urlPath);
    if (!filePath.startsWith(root)) {
      return context.notFound();
    }
    try {
      const fileStat = await stat(filePath);
      if (fileStat.isFile()) {
        return await serveStaticAppFile({
          acceptEncodingHeader: context.req.header("accept-encoding"),
          contentType:
            STATIC_MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
          filePath,
          ifNoneMatchHeader: context.req.header("if-none-match"),
          urlPath,
        });
      }
    } catch {}
    if (urlPath.startsWith("/assets/")) {
      return context.notFound();
    }
    return serveStaticAppFile({
      acceptEncodingHeader: context.req.header("accept-encoding"),
      contentType: "text/html",
      filePath: join(root, "index.html"),
      ifNoneMatchHeader: context.req.header("if-none-match"),
      urlPath: "/index.html",
    });
  });
}

function canServePrecompressedStaticFile(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "application/javascript" ||
    contentType === "application/json" ||
    contentType === "application/manifest+json" ||
    contentType === "application/wasm" ||
    contentType === "application/xml" ||
    contentType === "image/svg+xml"
  );
}

async function findPrecompressedStaticFile(args: {
  acceptEncodingHeader: string | undefined;
  contentType: string;
  filePath: string;
}): Promise<{
  contentLength: number;
  encoding: string;
  filePath: string;
} | null> {
  if (!canServePrecompressedStaticFile(args.contentType)) {
    return null;
  }

  for (const candidate of rankAcceptedAssetEncodings(
    args.acceptEncodingHeader,
    PRECOMPRESSED_STATIC_FILES,
  )) {
    const encodedFilePath = `${args.filePath}${candidate.extension}`;
    try {
      const encodedStat = await stat(encodedFilePath);
      if (encodedStat.isFile()) {
        return {
          contentLength: encodedStat.size,
          encoding: candidate.encoding,
          filePath: encodedFilePath,
        };
      }
    } catch {}
  }

  return null;
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
  deps: ServerAppDeps,
  options?: CreateAppOptions,
): ServerApp {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({
    app,
  });
  const slowApiRequestLogThresholdMs =
    options?.slowApiRequestLogThresholdMs ?? SLOW_API_REQUEST_LOG_THRESHOLD_MS;
  const bbAppArtifactService =
    options?.bbAppArtifactService ??
    createBbAppArtifactService({
      dataDir: deps.config.dataDir,
      serverEntryUrl: import.meta.url,
    });

  app.use("*", async (context, next) => {
    captureTrustedRemoteAddress(context);
    return runWithTelemetryAppSurface(resolveRequestAppSurface(context), next);
  });
  app.use("*", async (context, next) => {
    const path = context.req.path;
    if (!path.startsWith("/api/v1/") && !path.startsWith("/internal/")) {
      return next();
    }
    return runEventLoopWork(`${context.req.method} ${path}`, next);
  });
  app.use(
    "*",
    cors({
      origin: (origin, context) => {
        const allowedCorsOrigins = allowedAppOrigins(deps);
        const requestOrigin = new URL(context.req.url).origin;
        if (origin === requestOrigin || allowedCorsOrigins.has(origin)) {
          return origin;
        }
        return null;
      },
    }),
  );
  const compressResponse = compress();
  const compressApiJson = apiJsonCompression();
  app.use("*", (context, next) => {
    if (PLUGIN_APP_ASSET_PATH_PATTERN.test(context.req.path)) {
      return next();
    }
    return compressResponse(context, async () => {
      await compressApiJson(context, next);
    });
  });
  app.onError((error) => errorToResponse(error, deps.logger));
  app.get("/health", (context) =>
    context.json(
      deps.config.launchId === undefined
        ? { ok: true }
        : { ok: true, launchId: deps.config.launchId },
    ),
  );
  app.get("/install.sh", async (context) => {
    const script = await readFile(INSTALL_MACHINE_SCRIPT_PATH);
    return new Response(script, {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/x-shellscript; charset=utf-8",
      },
    });
  });
  app.get("/install/version", async (context) => {
    return context.json({
      version: await bbAppArtifactService.getVersion(),
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
    });
  });
  app.get("/install/bb-app.tgz", async (context) => {
    const artifact = await bbAppArtifactService.getArtifact();
    const etag = `"sha256-${artifact.digest}"`;
    const headers = {
      "cache-control": "public, max-age=300",
      "content-type": "application/gzip",
      etag,
      "x-bb-artifact-sha256": artifact.digest,
    };
    if (context.req.header("if-none-match") === etag) {
      return new Response(null, { headers, status: 304 });
    }
    const tarball = await readFile(artifact.path);
    return new Response(tarball, {
      headers: { ...headers, "content-length": String(artifact.size) },
    });
  });
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
      deps.logger.debug(
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
    if (normalizedPath === "/internal/hosts/enroll-key") {
      return next();
    }
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
  const pluginService = createPluginService({
    db: deps.db,
    hub: deps.hub,
    logger: deps.logger,
    telemetry: deps.telemetry,
    pendingInteractions: deps.pendingInteractions,
    dataDir: deps.config.dataDir,
    appVersion: deps.config.appVersion,
    getAppUrl: () => deps.config.appUrl ?? null,
    sharedPorts: deps.sharedPorts,
    providerRegistry: deps.providerRegistry,
    pluginHostArtifacts: deps.pluginHostArtifacts,
    aiServices: deps.aiServices,
    ensureSharedPortTunnel: (hostId) =>
      deps.sharedPorts.ensureTunnelIdentity(hostId, () =>
        callHostRetryableOnlineRpc(deps, {
          command: { type: "connect-tunnel.ensure-identity" },
          hostId,
          timeoutMs: 30_000,
        }),
      ),
    callPluginHost: (args) => callPluginHostRpc(deps, args),
    disposePluginHost: (args) => disposePluginHostWorkers(deps, args),
    onSettingsChanged: (pluginId) => {
      deps.providerNativeRoots.invalidate(pluginId);
      deps.providerRegistry.forgetAllInstalled();
    },
    onPluginUnregistered: (pluginId) => {
      requestQueuedMessageDispatch(deps, {
        kind: "plugin-unregistered",
        pluginId,
      });
    },
    // `bb.experimental_hooks.recheck()`: a plugin whose wait condition
    // may have changed asks core to re-attempt the plugin-queued rows. Core
    // owns the walk, the coalescing and the pacing; the plugin owns knowing
    // when to ask.
    requestQueueDrain: () => {
      requestQueuedMessageDispatch(deps, { kind: "plugin-recheck" });
    },
    watchBuiltinPluginSources:
      process.env.BB_MANAGED_DEV_BUILTIN_PLUGIN_HOT_RELOAD === "1",
  });
  // Messages queued while a thread awaited user interaction stop waiting once
  // that interaction settles (#1650); the idle drain then delivers them.
  deps.pendingInteractions.setThreadInteractionSettledListener((threadId) => {
    requestQueuedMessageDispatch(deps, {
      kind: "interaction-settled",
      threadId,
    });
  });
  setPluginThreadEventEmitter(pluginService.events);
  // Bridge the dispatch pipeline to this service's hooks. Until this runs
  // there are no hooks, which is exactly the zero-overhead path.
  setPluginHookProvider(pluginService.hooks);
  // Bridge runtime-config assembly to plugin skills + context (§4.4).
  setPluginAgentContributions(pluginService);
  const publicApi = new Hono();
  publicApi.use("*", async (context, next) => {
    if (PLUGIN_WIRE_HTTP_PATH.test(context.req.path)) {
      return next();
    }
    const problem = browserRequestProblem(context, deps);
    if (problem !== null) {
      throw new ApiError(problem.status, "forbidden_origin", problem.error);
    }
    return next();
  });
  const pluginCatalogService = createPluginCatalogService({
    db: deps.db,
    appVersion: deps.config.appVersion,
    marketplaceUrl: deps.config.marketplaceUrl,
    dataDir: deps.config.dataDir,
    plugins: pluginService,
    notifyCatalogChanged: () => deps.hub.notifySystem(["plugins-changed"]),
    warn: (message) => deps.logger.warn(message),
  });
  registerProjectRoutes(publicApi, deps);
  registerThreadSectionRoutes(publicApi, deps);
  registerFileRoutes(publicApi, deps);
  registerHostRoutes(publicApi, deps, pluginService);
  registerDesktopBrowserRoutes(publicApi, deps);
  registerTerminalRoutes(publicApi, deps);
  registerEnvironmentRoutes(publicApi, deps);
  registerThreadRoutes(publicApi, deps);
  registerQueueRoutes(publicApi, deps);
  registerSystemRoutes(publicApi, deps, pluginService);
  registerPluginCatalogRoutes(publicApi, pluginCatalogService);
  registerPluginRoutes(publicApi, deps, pluginService, upgradeWebSocket);
  registerSkillsRegistryRoutes(publicApi, deps);
  app.route("/api/v1", publicApi);
  app.use("/api/v1/*", () => {
    throw new ApiError(404, "not_found", "Not found");
  });

  const internalApi = new Hono();
  registerInternalHostRoutes(internalApi, deps);
  registerInternalSessionRoutes(internalApi, deps, pluginService);
  registerInternalSkillRoutes(internalApi, deps);
  registerInternalPluginHostArtifactRoutes(internalApi, deps);
  registerInternalEventRoutes(internalApi, deps);
  registerInternalToolCallRoutes(internalApi, deps);
  registerInternalInteractiveRequestRoutes(internalApi, deps);
  app.route("/internal", internalApi);

  app.get(
    "/ws",
    upgradeWebSocket((context) => {
      const problem = browserRequestProblem(context, deps);
      if (problem !== null) {
        throw new ApiError(
          problem.status,
          "forbidden_origin",
          problem.error,
          false,
        );
      }
      return {
        onOpen: (_event, socket) => onClientSocketOpen(deps.hub, socket),
        onMessage: (event, socket) =>
          onClientSocketMessage(deps, socket, event.data),
        onClose: (_event, socket) => onClientSocketClose(deps, socket),
      };
    }),
  );

  app.get(
    "/ws/terminals/:terminalId",
    upgradeWebSocket((context) => {
      const problem = browserRequestProblem(context, deps);
      if (problem !== null) {
        throw new ApiError(
          problem.status,
          "forbidden_origin",
          problem.error,
          false,
        );
      }
      const terminalId = context.req.param("terminalId");
      const query = terminalWebSocketQuerySchema.safeParse({
        sinceSeq: context.req.query("sinceSeq"),
      });
      if (!query.success) {
        throw new ApiError(
          400,
          "invalid_terminal_socket_query",
          "Terminal websocket sinceSeq must be a non-negative integer",
        );
      }
      return {
        onOpen: (_event, socket) =>
          onTerminalSocketOpen(deps, {
            socket,
            sinceSeq: query.data.sinceSeq,
            terminalId,
            threadId: null,
          }),
        onMessage: (event, socket) =>
          onTerminalSocketMessage(deps, {
            raw: event.data,
            socket,
            terminalId,
            threadId: null,
          }),
        onClose: (_event, socket) =>
          onTerminalSocketClose(deps, {
            socket,
            terminalId,
          }),
      };
    }),
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
          onDaemonSocketMessage(
            deps,
            {
              hostId: websocketContext.hostId,
              raw: event.data,
              sessionId: websocketContext.sessionId,
              socket,
            },
            pluginService,
          ),
        onClose: () => onDaemonSocketClose(deps, websocketContext.sessionId),
      };
    }),
  );

  if (!options?.staticDir) {
    app.get("/", (context) => context.text("bb server"));
  }

  if (options?.staticDir) {
    registerStaticAppRoutes(app, options.staticDir);
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
    pluginService,
    pluginCatalogService,
  };
}
