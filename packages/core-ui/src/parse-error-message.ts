import { buildThreadEventRow } from "@bb/domain";
import type { ThreadEvent } from "@bb/domain";
import type { EventMeta } from "./event-decode.js";
import { getEventTurnId } from "./event-decode.js";
import { messageId } from "./format-helpers.js";
import type { ViewDebugRawEventMessage, ViewErrorMessage, ViewMessage } from "@bb/domain";

function formatErrorDetail(message: string, detail: string | undefined): string {
  if (detail && detail !== message) return `${message} - ${detail}`;
  return message || "Error event";
}

export function parseErrorMessage(decoded: ThreadEvent, meta: EventMeta): ViewErrorMessage | null {
  if (decoded.type !== "error" && decoded.type !== "system/error") return null;

  const { message, detail } = decoded;
  return {
    kind: "error",
    id: messageId(decoded.threadId, "error", `${meta.seq}`),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    turnId: getEventTurnId(decoded),
    rawType: decoded.type,
    message: formatErrorDetail(message, detail),
  };
}

export function isIgnoredNoiseType(eventType: string): boolean {
  return (
    eventType === "thread/started" ||
    eventType === "thread/tokenUsage/updated" ||
    eventType === "thread/identity"
  );
}

export function isDuplicateEventType(eventType: string): boolean {
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
  return decoded.item.type === "reasoning" || decoded.item.type === "agentMessage";
}

export function isIgnoredItemCompletedEvent(decoded: ThreadEvent): boolean {
  if (decoded.type !== "item/completed") return false;

  if (decoded.item.type === "reasoning") {
    return decoded.item.summary.length === 0 && decoded.item.content.length === 0;
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
    turnId: getEventTurnId(decoded),
    rawType: decoded.type,
    rawEvent: buildThreadEventRow({
      id: meta.id,
      threadId: decoded.threadId,
      seq: meta.seq,
      createdAt: meta.createdAt,
      event: decoded,
    }),
    reason,
  });
}
