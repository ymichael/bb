import { createNodeWebSocket } from "@hono/node-ws";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppDeps } from "./types.js";
import { errorToResponse } from "./errors.js";
import { registerAutomationRoutes } from "./routes/automations.js";
import { registerEnvironmentRoutes } from "./routes/environments.js";
import { registerHostRoutes } from "./routes/hosts.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerThreadRoutes } from "./routes/threads/index.js";
import { registerInternalCommandRoutes } from "./internal/commands.js";
import { registerInternalCommandResultRoutes } from "./internal/command-result-route.js";
import { registerInternalEnvironmentChangeRoutes } from "./internal/environment-changes.js";
import { registerInternalEventRoutes } from "./internal/events.js";
import { registerInternalHostRoutes } from "./internal/hosts.js";
import { registerInternalSessionRoutes } from "./internal/session.js";
import { registerInternalToolCallRoutes } from "./internal/tool-calls.js";
import {
  setAuthenticatedDaemon,
  verifyAuthenticatedDaemon,
} from "./internal/auth.js";
import { onClientSocketClose, onClientSocketMessage, onClientSocketOpen } from "./ws/client-protocol.js";
import {
  onDaemonSocketClose,
  onDaemonSocketMessage,
  onDaemonSocketOpen,
  validateDaemonWebSocket,
} from "./ws/daemon-protocol.js";

export interface ServerApp {
  app: Hono;
  injectWebSocket: ReturnType<typeof createNodeWebSocket>["injectWebSocket"];
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
  staticDir?: string;
}

export function createApp(deps: AppDeps, options?: CreateAppOptions): ServerApp {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.use("*", cors());
  app.onError((error) => errorToResponse(error));
  app.get("/health", (context) => context.json({ ok: true }));
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
  app.route("/api/v1", publicApi);

  const internalApi = new Hono();
  registerInternalHostRoutes(internalApi, deps);
  registerInternalSessionRoutes(internalApi, deps);
  registerInternalCommandRoutes(internalApi, deps);
  registerInternalCommandResultRoutes(internalApi, deps);
  registerInternalEnvironmentChangeRoutes(internalApi, deps);
  registerInternalEventRoutes(internalApi, deps);
  registerInternalToolCallRoutes(internalApi, deps);
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
        onClose: () =>
          onDaemonSocketClose(deps, websocketContext.sessionId),
      };
    }),
  );

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
      const urlPath = context.req.path === "/" ? "/index.html" : context.req.path;
      const filePath = join(root, urlPath);
      if (!filePath.startsWith(root)) {
        return context.notFound();
      }
      try {
        const fileStat = await stat(filePath);
        if (fileStat.isFile()) {
          const content = await readFile(filePath);
          const contentType = MIME[extname(filePath)] ?? "application/octet-stream";
          return new Response(content, { headers: { "content-type": contentType } });
        }
      } catch {
        // File not found — fall through to SPA fallback
      }
      const indexHtml = await readFile(join(root, "index.html"));
      return new Response(indexHtml, { headers: { "content-type": "text/html" } });
    });
  }

  return {
    app,
    injectWebSocket,
  };
}
