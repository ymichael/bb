import { and, eq, inArray, max } from "drizzle-orm";
import {
  createEventId,
  closeSession,
  events,
  environments,
  heartbeatSession,
  hostDaemonSessions,
  threads,
} from "@bb/db";
import { hostDaemonDaemonWsMessageSchema } from "@bb/host-daemon-contract";
import { DAEMON_DISCONNECT_GRACE_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import { buildSystemErrorEventData } from "../services/thread-events.js";
import type { AppDeps } from "../types.js";
import { requireActiveSession } from "../internal/session-state.js";
import { decodeSocketPayload } from "./decode-payload.js";

interface DaemonSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface DaemonSocketMessageArgs {
  raw: unknown;
  sessionId: string;
  socket: DaemonSocket;
}

export function validateDaemonWebSocket(
  deps: Pick<AppDeps, "config" | "db">,
  args: { sessionId: string | null; token: string | null },
): { hostId: string; sessionId: string } {
  if (!args.sessionId || args.token !== deps.config.authToken) {
    throw new ApiError(401, "unauthorized", "Unauthorized");
  }
  const session = requireActiveSession(deps.db, args.sessionId);
  return {
    sessionId: session.id,
    hostId: session.hostId,
  };
}

export function onDaemonSocketOpen(
  deps: Pick<AppDeps, "hub">,
  args: { hostId: string; sessionId: string; socket: DaemonSocket },
): void {
  deps.hub.registerDaemon(args.sessionId, args.hostId, args.socket);
}

export function onDaemonSocketMessage(
  deps: Pick<AppDeps, "db">,
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

  const session = requireActiveSession(deps.db, args.sessionId);
  heartbeatSession(
    deps.db,
    session.id,
    Date.now() + session.leaseTimeoutMs,
  );
}

export function onDaemonSocketClose(
  deps: Pick<AppDeps, "db" | "hub">,
  sessionId: string,
): void {
  deps.hub.unregisterDaemon(sessionId);
  deps.hub.scheduleDaemonDisconnect(
    sessionId,
    DAEMON_DISCONNECT_GRACE_MS,
    () => finalizeDaemonDisconnect(deps, sessionId),
  );
}

function finalizeDaemonDisconnect(
  deps: Pick<AppDeps, "db" | "hub">,
  sessionId: string,
): void {
  const session = deps.db
    .select()
    .from(hostDaemonSessions)
    .where(eq(hostDaemonSessions.id, sessionId))
    .get();
  if (!session || session.status !== "active") {
    return;
  }
  closeSession(deps.db, deps.hub, sessionId, "daemon-disconnect");

  const interruptedThreadIds = interruptThreadsForDisconnectedHost(
    deps,
    session.hostId,
  );
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

      const interruptedThreadIds = interruptedThreads.map((thread) => thread.id);
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
              sequence: nextSequence,
              threadId: thread.id,
              turnId: null,
              type: "system/error" as const,
            };
          }),
        )
        .run();

      const updatedThreads = tx.update(threads)
        .set({
          status: "error",
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
