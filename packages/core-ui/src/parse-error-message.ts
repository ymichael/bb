import { buildThreadEventRow } from "@bb/domain";
import type { ThreadEvent, ThreadEventType } from "@bb/domain";
import type { EventMeta } from "./event-decode.js";
import { messageId } from "./format-helpers.js";
import type {
  ViewDebugRawEventMessage,
  ViewErrorMessage,
  ViewMessage,
} from "@bb/domain";

interface ReconnectState {
  attempt: number;
  total: number;
}

function formatErrorDetail(
  message: string,
  detail: string | undefined,
): string {
  if (detail && detail !== message) return `${message} - ${detail}`;
  return message || "Error event";
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

  // Legacy events only carried reconnect progress in the display message.
  return parseLegacyReconnectState(decoded.message);
}

export function parseErrorMessage(
  decoded: ThreadEvent,
  meta: EventMeta,
): ViewErrorMessage | null {
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
    message: formatErrorDetail(message, detail),
    ...(reconnectState
      ? {
          reconnectAttempt: reconnectState.attempt,
          reconnectTotal: reconnectState.total,
        }
      : {}),
  };
}

export function isDuplicateEventType(eventType: ThreadEventType): boolean {
  return (
    eventType === "turn/started" ||
    eventType === "turn/completed" ||
    eventType === "item/commandExecution/outputDelta" ||
    eventType === "item/fileChange/outputDelta" ||
    eventType === "turn/diff/updated"
  );
}

export function isIgnoredItemStartEvent(decoded: ThreadEvent): boolean {
  if (decoded.type !== "item/started") return false;
  return (
    decoded.item.type === "reasoning" || decoded.item.type === "agentMessage"
  );
}

export function isIgnoredItemCompletedEvent(decoded: ThreadEvent): boolean {
  if (decoded.type !== "item/completed") return false;

  if (decoded.item.type === "reasoning") {
    return (
      decoded.item.summary.length === 0 && decoded.item.content.length === 0
    );
  }

  if (decoded.item.type === "agentMessage") {
    return decoded.item.text.length === 0;
  }

  return false;
}

export function appendDebugEvent(
  out: ViewMessage[],
  decoded: ThreadEvent,
  meta: EventMeta,
  reason: ViewDebugRawEventMessage["reason"],
): void {
  out.push({
    kind: "debug/raw-event",
    id: messageId(decoded.threadId, "debug", `${meta.seq}:${decoded.type}`),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    scope: decoded.scope,
    rawType: decoded.type,
    rawEvent: buildThreadEventRow({
      id: meta.id,
      scope: decoded.scope,
      threadId: decoded.threadId,
      seq: meta.seq,
      createdAt: meta.createdAt,
      event: decoded,
    }),
    reason,
  });
}
