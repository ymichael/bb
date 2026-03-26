import { eq } from "drizzle-orm";
import { closeSession, heartbeatSession, hostDaemonSessions } from "@bb/db";
import { hostDaemonDaemonWsMessageSchema } from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import { requireActiveSession } from "../internal/session-state.js";

interface DaemonSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

function decodeSocketPayload(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString(
      "utf8",
    );
  }
  return String(raw);
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
  sessionId: string,
  raw: unknown,
): void {
  hostDaemonDaemonWsMessageSchema.parse(JSON.parse(decodeSocketPayload(raw)));
  const session = requireActiveSession(deps.db, sessionId);
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
}
