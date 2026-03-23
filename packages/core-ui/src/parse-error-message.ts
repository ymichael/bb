import type { ThreadEvent } from "@bb/domain";
import type { EventMeta } from "./event-decode.js";
import { getEventTurnId } from "./event-decode.js";
import { messageId } from "./format-helpers.js";
import type { UIDebugRawEventMessage, UIErrorMessage, UIMessage } from "@bb/domain";

function formatErrorDetail(message: string, detail: string | undefined): string {
  if (detail && detail !== message) return `${message} - ${detail}`;
  return message || "Error event";
}

export function parseErrorMessage(decoded: ThreadEvent, meta: EventMeta): UIErrorMessage | null {
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
    eventType === "thread/identity" ||
    eventType === "item/reasoning/summaryPartAdded"
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

export function appendDebugEvent(
  out: UIMessage[],
  decoded: ThreadEvent,
  meta: EventMeta,
  reason: UIDebugRawEventMessage["reason"],
): void {
  const { type, threadId, ...data } = decoded;
  out.push({
    kind: "debug/raw-event",
    id: messageId(decoded.threadId, "debug", `${meta.seq}:${decoded.type}`),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    turnId: getEventTurnId(decoded),
    rawType: decoded.type,
    rawEvent: {
      id: meta.id,
      threadId,
      seq: meta.seq,
      type,
      data,
      createdAt: meta.createdAt,
    },
    reason,
  });
}
