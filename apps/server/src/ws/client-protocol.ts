import type { ClientMessage } from "@bb/domain";
import { REALTIME_ENTITIES } from "@bb/domain";
import { decodeSocketPayload } from "./decode-payload.js";
import type { NotificationHub } from "./hub.js";

interface ClientSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

const realtimeEntitySet: ReadonlySet<string> = new Set(REALTIME_ENTITIES);

function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return false;
  }
  if (value.type !== "subscribe" && value.type !== "unsubscribe") {
    return false;
  }
  if (!("entity" in value) || typeof value.entity !== "string") {
    return false;
  }
  return realtimeEntitySet.has(value.entity);
}

export function onClientSocketOpen(
  hub: NotificationHub,
  socket: ClientSocket,
): void {
  hub.registerClient(socket);
}

export function onClientSocketMessage(
  hub: NotificationHub,
  socket: ClientSocket,
  raw: unknown,
): void {
  const parsed = JSON.parse(decodeSocketPayload(raw)) as unknown;
  if (!isClientMessage(parsed)) {
    socket.close(1008, "invalid-message");
    return;
  }

  switch (parsed.type) {
    case "subscribe":
      hub.subscribe(socket, parsed.entity, parsed.id);
      break;
    case "unsubscribe":
      hub.unsubscribe(socket, parsed.entity, parsed.id);
      break;
    default: {
      const _exhaustive: never = parsed;
      throw new Error(`Unhandled client message: ${_exhaustive}`);
    }
  }
}

export function onClientSocketClose(
  hub: NotificationHub,
  socket: ClientSocket,
): void {
  hub.unregisterClient(socket);
}
