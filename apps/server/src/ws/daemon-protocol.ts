import { and, eq, inArray } from "drizzle-orm";
import {
  closeSession,
  environments,
  heartbeatSession,
  hostDaemonSessions,
  threads,
} from "@bb/db";
import { hostDaemonDaemonWsMessageSchema } from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import { requireActiveSession } from "../internal/session-state.js";
import { appendSystemErrorEvent } from "../services/thread-events.js";
import { tryTransition } from "../services/thread-transitions.js";
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
    throw new Error("Unauthorized websocket");
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
  const session = deps.db
    .select()
    .from(hostDaemonSessions)
    .where(eq(hostDaemonSessions.id, sessionId))
    .get();
  if (!session || session.status !== "active") {
    return;
  }
  closeSession(deps.db, deps.hub, sessionId, "daemon-disconnect");
  const interruptedThreads = deps.db
    .select({
      environmentId: threads.environmentId,
      id: threads.id,
    })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      and(
        eq(environments.hostId, session.hostId),
        inArray(threads.status, ["active", "provisioning"]),
      ),
    )
    .all();
  for (const thread of interruptedThreads) {
    appendSystemErrorEvent(deps, {
      code: "host_daemon_disconnected",
      detail: "The host daemon disconnected while work was in progress.",
      environmentId: thread.environmentId,
      message: "Host daemon disconnected during active work",
      threadId: thread.id,
    });
    tryTransition(deps.db, deps.hub, thread.id, "error");
  }
}
