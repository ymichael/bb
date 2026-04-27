import { and, eq, inArray, max } from "drizzle-orm";
import {
  createEventId,
  closeSession,
  events,
  environments,
  getActiveSession,
  heartbeatSession,
  hostDaemonSessions,
  listHostThreadIds,
  threads,
} from "@bb/db";
import {
  hasHostDaemonWebSocketProtocol,
  hostDaemonDaemonWsMessageSchema,
} from "@bb/host-daemon-contract";
import { DAEMON_DISCONNECT_GRACE_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import { verifyAuthenticatedDaemon } from "../internal/auth.js";
import { buildSystemErrorEventData } from "../services/threads/thread-events.js";
import type { AppDeps } from "../types.js";
import type { ThreadEventScopeKind } from "@bb/domain";
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
  // right away. Thread interruption is deferred behind a grace period so that
  // brief reconnects don't produce spurious error events on active threads.
  closeSession(deps.db, deps.hub, sessionId, "daemon-disconnect");

  const hostId = session.hostId;
  deps.hub.scheduleDaemonDisconnect(sessionId, DAEMON_DISCONNECT_GRACE_MS, () =>
    deferredThreadInterrupt(deps, hostId),
  );
}

/**
 * After the grace period, interrupt active threads on a host that is still
 * disconnected.  If the daemon reconnected in the meantime (a new active
 * session exists for the host), this is a no-op.
 */
function deferredThreadInterrupt(
  deps: Pick<AppDeps, "db" | "hub" | "pendingInteractions">,
  hostId: string,
): void {
  // Host reconnected — nothing to interrupt.
  if (getActiveSession(deps.db, hostId)) {
    return;
  }

  const interruptedThreadIds = interruptThreadsForDisconnectedHost(
    deps,
    hostId,
  );
  deps.pendingInteractions.interruptPendingInteractionsForThreadIds({
    threadIds: listHostThreadIds(deps.db, { hostId }),
    reason:
      "Host daemon disconnected while awaiting user interaction; retry the thread to continue",
  });
  for (const threadId of interruptedThreadIds.eventThreadIds) {
    deps.hub.notifyThread(threadId, ["events-appended"]);
  }
  for (const threadId of interruptedThreadIds.statusThreadIds) {
    deps.hub.notifyThread(threadId, ["status-changed"]);
  }
}

function interruptThreadsForDisconnectedHost(
  deps: Pick<AppDeps, "db">,
  hostId: string,
): { eventThreadIds: string[]; statusThreadIds: string[] } {
  const now = Date.now();
  const disconnectEventType = "system/error" as const;
  const disconnectErrorData = buildSystemErrorEventData({
    code: "host_daemon_disconnected",
    detail: "The host daemon disconnected while work was in progress.",
    message: "Host daemon disconnected during active work",
  });

  return deps.db.transaction(
    (tx) => {
      const interruptedThreads = tx
        .select({
          environmentId: threads.environmentId,
          id: threads.id,
        })
        .from(threads)
        .innerJoin(environments, eq(threads.environmentId, environments.id))
        .where(
          and(
            eq(environments.hostId, hostId),
            inArray(threads.status, ["active", "provisioning"]),
          ),
        )
        .all();

      if (interruptedThreads.length === 0) {
        return {
          eventThreadIds: [],
          statusThreadIds: [],
        };
      }

      const interruptedThreadIds = interruptedThreads.map(
        (thread) => thread.id,
      );
      const maxSequences = new Map(
        tx
          .select({
            maxSeq: max(events.sequence),
            threadId: events.threadId,
          })
          .from(events)
          .where(inArray(events.threadId, interruptedThreadIds))
          .groupBy(events.threadId)
          .all()
          .map((row) => [row.threadId, row.maxSeq ?? 0] as const),
      );
      const disconnectScopeKind: ThreadEventScopeKind = "thread";

      tx.insert(events)
        .values(
          interruptedThreads.map((thread) => {
            const nextSequence = (maxSequences.get(thread.id) ?? 0) + 1;
            maxSequences.set(thread.id, nextSequence);
            return {
              createdAt: now,
              data: JSON.stringify(disconnectErrorData),
              environmentId: thread.environmentId,
              id: createEventId(),
              itemId: null,
              itemKind: null,
              providerThreadId: null,
              scopeKind: disconnectScopeKind,
              sequence: nextSequence,
              threadId: thread.id,
              turnId: null,
              type: disconnectEventType,
            };
          }),
        )
        .run();

      const updatedThreads = tx
        .update(threads)
        .set({
          status: "error",
          latestAttentionAt: now,
          updatedAt: now,
        })
        .where(
          and(
            inArray(threads.id, interruptedThreadIds),
            inArray(threads.status, ["active", "provisioning"]),
          ),
        )
        .returning({ id: threads.id })
        .all();

      return {
        eventThreadIds: interruptedThreadIds,
        statusThreadIds: updatedThreads.map((thread) => thread.id),
      };
    },
    { behavior: "immediate" },
  );
}
