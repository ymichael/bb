import { syncDesktopBrowserTabs } from "../services/desktop-browsers.js";
import { heartbeatSession } from "@bb/db";
import {
  hasHostDaemonWebSocketProtocol,
  hostDaemonDaemonWsMessageSchema,
} from "@bb/host-daemon-contract";
import { ApiError } from "../errors.js";
import { verifyAuthenticatedDaemon } from "../internal/auth.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../types.js";
import { runtimeErrorLogFields } from "../services/lib/error-log-fields.js";
import {
  getInactiveSessionLogFields,
  requireAuthorizedOpenSession,
} from "../internal/session-state.js";
import { handleDaemonSocketClosed } from "../internal/session-owner-side-effects.js";
import {
  notifyDaemonEnvironmentChange,
  recordDaemonEnvironmentMetadataChange,
} from "../internal/environment-changes.js";
import { requestQueuedMessageDispatch } from "../services/threads/queued-message-dispatch.js";
import { runEventLoopWorkSync } from "../services/system/event-loop-work.js";
import { decodeSocketPayload } from "./decode-payload.js";
import type { PluginService } from "../services/plugins/plugin-service.js";

interface DaemonSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface DaemonSocketMessageArgs {
  hostId: string;
  raw: unknown;
  sessionId: string;
  socket: DaemonSocket;
}

export async function validateDaemonWebSocket(
  deps: Pick<AppDeps, "db" | "machineAuth">,
  args: {
    authorizationHeader: string | undefined;
    protocolHeader: string | undefined;
    sessionId: string | null;
  },
): Promise<{ hostId: string; sessionId: string }> {
  const sessionId = args.sessionId;
  if (!sessionId) {
    throw new ApiError(401, "unauthorized", "Unauthorized");
  }
  if (!hasHostDaemonWebSocketProtocol(args.protocolHeader)) {
    throw new ApiError(
      400,
      "invalid_request",
      "Unsupported host daemon websocket protocol",
    );
  }

  const verified = await verifyAuthenticatedDaemon(
    deps,
    args.authorizationHeader,
  );
  const session = requireAuthorizedOpenSession(deps.db, {
    hostId: verified.hostId,
    sessionId,
  });

  return {
    sessionId: session.id,
    hostId: session.hostId,
  };
}

export function onDaemonSocketOpen(
  deps: LoggedPendingInteractionWorkSessionDeps &
    Pick<AppDeps, "hub" | "logger" | "sharedPorts" | "terminalSessions">,
  args: { hostId: string; sessionId: string; socket: DaemonSocket },
): void {
  deps.logger.info(
    { sessionId: args.sessionId, hostId: args.hostId },
    "Daemon WebSocket opened",
  );
  deps.hub.registerDaemon(args.sessionId, args.hostId, args.socket);
  deps.sharedPorts.pushCurrentSharedPortsForHost(args.hostId);
  deps.terminalSessions.expireDisconnectedHostTerminals({
    daemonSessionId: args.sessionId,
    hostId: args.hostId,
  });
  // A dispatch that arrived while this machine was away parked its row on a
  // `host-offline` wait with no schedule, so no sweep can see it — the
  // machine coming back is that wait's release signal, and this socket
  // opening is where core hears it.
  requestQueuedMessageDispatch(deps, {
    hostId: args.hostId,
    kind: "host-connected",
  });
}

export function onDaemonSocketMessage(
  deps: Pick<
    AppDeps,
    "config" | "db" | "hub" | "logger" | "sharedPorts" | "terminalSessions"
  >,
  args: DaemonSocketMessageArgs,
  plugins?: Pick<PluginService, "handleHostSignal" | "handleHostWorkerExit">,
): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeSocketPayload(args.raw));
  } catch {
    args.socket.close(1008, "invalid-message");
    return;
  }

  const result = hostDaemonDaemonWsMessageSchema.safeParse(decoded);
  if (!result.success) {
    args.socket.close(1008, "invalid-message");
    return;
  }

  try {
    runEventLoopWorkSync(`ws:daemon ${result.data.type}`, () => {
      const session = requireAuthorizedOpenSession(deps.db, {
        hostId: args.hostId,
        sessionId: args.sessionId,
      });
      heartbeatSession(
        deps.db,
        session.id,
        Math.max(
          Date.now() + session.leaseTimeoutMs,
          session.leaseExpiresAt + 1,
        ),
      );
      if (result.data.type === "environment-change") {
        notifyDaemonEnvironmentChange(deps, {
          hostId: args.hostId,
          environmentId: result.data.environmentId,
          change: result.data.change,
        });
        return;
      }
      if (result.data.type === "environment-metadata-change") {
        recordDaemonEnvironmentMetadataChange(deps, {
          hostId: args.hostId,
          environmentId: result.data.environmentId,
          workspace: result.data.workspace,
        });
        return;
      }
      if (result.data.type === "host-rpc.response") {
        const disposition = deps.hub.recordHostOnlineRpcResponse({
          message: result.data,
          sessionId: args.sessionId,
        });
        if (!disposition.handled && disposition.reason === "session_mismatch") {
          deps.logger.warn(
            {
              commandType: result.data.commandType,
              expectedSessionId: disposition.expectedSessionId,
              requestId: result.data.requestId,
              sessionId: args.sessionId,
            },
            "Ignoring host RPC response from mismatched daemon session",
          );
        } else if (!disposition.handled) {
          deps.logger.debug(
            {
              commandType: result.data.commandType,
              requestId: result.data.requestId,
              sessionId: args.sessionId,
            },
            "Ignoring stale host RPC response",
          );
        }
        return;
      }
      if (result.data.type === "connect-tunnel.identity") {
        deps.sharedPorts.recordTunnelIdentity(
          args.hostId,
          result.data.identity,
        );
        return;
      }
      if (result.data.type === "desktop-browser.changed") {
        syncDesktopBrowserTabs(
          deps,
          {
            hostId: args.hostId,
            instanceId: result.data.instanceId,
            generation: result.data.generation,
            threadId: result.data.threadId,
          },
          result.data.tabs,
        );
        return;
      }
      if (result.data.type === "plugin-host.worker-exited") {
        plugins?.handleHostWorkerExit({
          authenticatedHostId: args.hostId,
          pluginId: result.data.pluginId,
          generation: result.data.generation,
        });
        return;
      }
      if (result.data.type === "plugin-host.signal") {
        plugins?.handleHostSignal({
          authenticatedHostId: args.hostId,
          pluginId: result.data.pluginId,
          generation: result.data.generation,
          signal: result.data.signal,
          payload: result.data.payload,
        });
        return;
      }
      if (result.data.type === "heartbeat") {
        args.socket.send(JSON.stringify({ type: "heartbeat-ack" }));
        return;
      }
      deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: args.hostId,
        message: result.data,
        sessionId: args.sessionId,
      });
    });
  } catch (error) {
    if (error instanceof ApiError && error.body.code === "inactive_session") {
      deps.logger.info(
        getInactiveSessionLogFields(deps.db, {
          authenticatedHostId: args.hostId,
          now: Date.now(),
          sessionId: args.sessionId,
        }),
        "Daemon heartbeat for inactive session, closing socket",
      );
      args.socket.close(1008, "inactive-session");
      return;
    }

    if (error instanceof ApiError && error.status === 403) {
      deps.logger.warn(
        {
          sessionId: args.sessionId,
          ...runtimeErrorLogFields(deps.config, error),
        },
        "Daemon heartbeat for unauthorized session, closing socket",
      );
      args.socket.close(1008, "unauthorized-session");
      return;
    }

    deps.logger.warn(
      {
        sessionId: args.sessionId,
        ...runtimeErrorLogFields(deps.config, error),
      },
      "Daemon heartbeat rejected, closing socket",
    );
    args.socket.close(1008, "inactive-session");
  }
}

export function onDaemonSocketClose(
  deps: Pick<
    AppDeps,
    | "db"
    | "hub"
    | "logger"
    | "pendingInteractions"
    | "providerRegistry"
    | "sharedPorts"
    | "terminalSessions"
  >,
  sessionId: string,
): void {
  handleDaemonSocketClosed(deps, {
    sessionId,
  });
}
