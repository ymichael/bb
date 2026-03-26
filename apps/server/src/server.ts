import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppDeps } from "./types.js";
import { errorToResponse } from "./errors.js";
import { registerEnvironmentRoutes } from "./routes/environments.js";
import { registerHostRoutes } from "./routes/hosts.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerThreadRoutes } from "./routes/threads/index.js";
import { registerInternalCommandRoutes } from "./internal/commands.js";
import { registerInternalCommandResultRoutes } from "./internal/command-result-route.js";
import { registerInternalEventRoutes } from "./internal/events.js";
import { registerInternalSessionRoutes } from "./internal/session.js";
import { registerInternalToolCallRoutes } from "./internal/tool-calls.js";
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

export function createApp(deps: AppDeps): ServerApp {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.use("*", cors());
  app.onError((error) => errorToResponse(error));
  app.use("/internal/*", async (context, next) => {
    const isWebSocketPath = context.req.path === "/internal/ws";
    const authorized = isWebSocketPath
      ? context.req.query("token") === deps.config.authToken
      : context.req.header("authorization") === `Bearer ${deps.config.authToken}`;
    if (!authorized) {
      return unauthorizedResponse();
    }
    return next();
  });

  const publicApi = new Hono();
  registerProjectRoutes(publicApi, deps);
  registerHostRoutes(publicApi, deps);
  registerEnvironmentRoutes(publicApi, deps);
  registerThreadRoutes(publicApi, deps);
  registerSystemRoutes(publicApi, deps);
  app.route("/api/v1", publicApi);

  const internalApi = new Hono();
  registerInternalSessionRoutes(internalApi, deps);
  registerInternalCommandRoutes(internalApi, deps);
  registerInternalCommandResultRoutes(internalApi, deps);
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
    upgradeWebSocket((context) => {
      const websocketContext = validateDaemonWebSocket(deps, {
        sessionId: context.req.query("sessionId") ?? null,
        token: context.req.query("token") ?? null,
      });
      return {
        onOpen: (_event, socket) =>
          onDaemonSocketOpen(deps, {
            ...websocketContext,
            socket,
          }),
        onMessage: (event) =>
          onDaemonSocketMessage(deps, websocketContext.sessionId, event.data),
        onClose: () =>
          onDaemonSocketClose(deps, websocketContext.sessionId),
      };
    }),
  );

  return {
    app,
    injectWebSocket,
  };
}
