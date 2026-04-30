import { eq } from "drizzle-orm";
import {
  closeSession,
  getActiveSession,
  heartbeatSession,
  hostDaemonSessions,
  listHostThreadIds,
} from "@bb/db";
import {
  hasHostDaemonWebSocketProtocol,
  hostDaemonDaemonWsMessageSchema,
} from "@bb/host-daemon-contract";
import { DAEMON_DISCONNECT_GRACE_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import { verifyAuthenticatedDaemon } from "../internal/auth.js";
import type { AppDeps } from "../types.js";
import { requireAuthorizedActiveSession } from "../internal/session-state.js";
import { decodeSocketPayload } from "./decode-payload.js";

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
  const session = requireAuthorizedActiveSession(deps.db, {
    hostId: verified.hostId,
    sessionId,
  });

  return {
    sessionId: session.id,
    hostId: session.hostId,
  };
}

export function onDaemonSocketOpen(
  deps: Pick<AppDeps, "hub" | "logger">,
  args: { hostId: string; sessionId: string; socket: DaemonSocket },
): void {
  deps.logger.info(
    { sessionId: args.sessionId, hostId: args.hostId },
    "Daemon WebSocket opened",
  );
  deps.hub.registerDaemon(args.sessionId, args.hostId, args.socket);
}

export function onDaemonSocketMessage(
  deps: Pick<AppDeps, "db" | "logger">,
  args: DaemonSocketMessageArgs,
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
    const session = requireAuthorizedActiveSession(deps.db, {
      hostId: args.hostId,
      sessionId: args.sessionId,
    });
    heartbeatSession(deps.db, session.id, Date.now() + session.leaseTimeoutMs);
  } catch (error) {
    deps.logger.warn(
      { sessionId: args.sessionId, err: error },
      "Daemon heartbeat for inactive session, closing socket",
    );
    args.socket.close(1008, "inactive-session");
  }
}

export function onDaemonSocketClose(
  deps: Pick<AppDeps, "db" | "hub" | "logger" | "pendingInteractions">,
  sessionId: string,
): void {
  deps.logger.info({ sessionId }, "Daemon WebSocket closed");
  deps.hub.unregisterDaemon(sessionId);

  const session = deps.db
    .select()
    .from(hostDaemonSessions)
    .where(eq(hostDaemonSessions.id, sessionId))
    .get();
  if (!session || session.status !== "active") {
    return;
  }

  // Close the session immediately so the host status reflects the disconnect
  // right away. Thread runtime status is notified immediately and again after
  // grace, but connection loss alone does not prove active turns are gone.
  closeSession(deps.db, deps.hub, sessionId, "daemon-disconnect");

  const hostId = session.hostId;
  notifyHostThreadRuntimeStatusChanged(deps, hostId);
  deps.hub.scheduleDaemonDisconnect(sessionId, DAEMON_DISCONNECT_GRACE_MS, () =>
    notifyDisconnectedHostAfterGrace(deps, {
      hostId,
      sessionId,
    }),
  );
}

function notifyHostThreadRuntimeStatusChanged(
  deps: Pick<AppDeps, "db" | "hub">,
  hostId: string,
): void {
  for (const threadId of listHostThreadIds(deps.db, { hostId })) {
    deps.hub.notifyThread(threadId, ["status-changed"]);
  }
}

/**
 * After the grace period, notify active thread views that the disconnected host
 * is no longer in the reconnecting window. If the daemon reconnected in the
 * meantime, runtime display status is already back to connected and this is a
 * no-op.
 */
interface NotifyDisconnectedHostAfterGraceArgs {
  hostId: string;
  sessionId: string;
}

function notifyDisconnectedHostAfterGrace(
  deps: Pick<AppDeps, "db" | "hub" | "pendingInteractions">,
  args: NotifyDisconnectedHostAfterGraceArgs,
): void {
  if (getActiveSession(deps.db, args.hostId)) {
    return;
  }

  deps.pendingInteractions.interruptPendingInteractionsForSessionIds({
    sessionIds: [args.sessionId],
    reason:
      "Host daemon disconnected while awaiting user interaction; retry the thread to continue",
  });
  notifyHostThreadRuntimeStatusChanged(deps, args.hostId);
}
