import type { ThreadEvent } from "@bb/domain";
import type { EventMeta } from "./event-decode.js";
import { messageId } from "./format-helpers.js";
import type { EventProjectionErrorMessage } from "./event-projection-types.js";

interface ReconnectState {
  attempt: number;
  total: number;
}

function parseLegacyReconnectState(message: string): ReconnectState | null {
  const match = message.trim().match(/^Reconnecting\.\.\.\s+(\d+)\/(\d+)$/);
  if (!match) {
    return null;
  }

  const attempt = Number.parseInt(match[1] ?? "", 10);
  const total = Number.parseInt(match[2] ?? "", 10);
  if (
    !Number.isFinite(attempt) ||
    !Number.isFinite(total) ||
    attempt <= 0 ||
    total <= 0 ||
    attempt > total
  ) {
    return null;
  }

  return { attempt, total };
}

function getReconnectState(decoded: ThreadEvent): ReconnectState | null {
  if (decoded.type !== "system/error") {
    return null;
  }

  if (
    decoded.reconnectAttempt !== undefined &&
    decoded.reconnectTotal !== undefined
  ) {
    return {
      attempt: decoded.reconnectAttempt,
      total: decoded.reconnectTotal,
    };
  }

  if (decoded.code !== "provider_reconnect") {
    return null;
  }

  return parseLegacyReconnectState(decoded.message);
}

export function parseErrorMessage(
  decoded: ThreadEvent,
  meta: EventMeta,
): EventProjectionErrorMessage | null {
  if (decoded.type !== "provider/error" && decoded.type !== "system/error")
    return null;

  const { message, detail } = decoded;
  const reconnectState = getReconnectState(decoded);
  return {
    kind: "error",
    id: messageId(decoded.threadId, "error", `${meta.seq}`),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    scope: decoded.scope,
    rawType: decoded.type,
    message: message || "Error event",
    detail: detail && detail !== message ? detail : null,
    ...(decoded.type === "provider/error" && decoded.errorInfo
      ? { providerErrorInfo: decoded.errorInfo }
      : {}),
    ...(decoded.type === "provider/error" && decoded.willRetry !== undefined
      ? { willRetry: decoded.willRetry }
      : {}),
    ...(reconnectState
      ? {
          reconnectAttempt: reconnectState.attempt,
          reconnectTotal: reconnectState.total,
        }
      : {}),
  };
}
