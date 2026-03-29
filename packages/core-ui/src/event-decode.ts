import {
  providerEventTypeValues,
  systemEventTypeValues,
  threadEventSchema,
} from "@bb/domain";
import type { ThreadEvent, ThreadEventRow } from "@bb/domain";

const knownThreadEventTypeSet = new Set<string>([
  ...providerEventTypeValues,
  ...systemEventTypeValues,
]);

export interface UnknownDecodedThreadEvent {
  type: string;
  threadId: string;
  providerThreadId?: string;
  turnId?: string;
  parentToolCallId?: string;
  rawData: ThreadEventRow["data"];
}

export type DecodedThreadEvent = ThreadEvent | UnknownDecodedThreadEvent;

function getOptionalEventString(
  data: ThreadEventRow["data"],
  key: string,
): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

function buildUnknownDecodedThreadEvent(
  row: ThreadEventRow,
): UnknownDecodedThreadEvent {
  return {
    type: row.type,
    threadId: row.threadId,
    providerThreadId: getOptionalEventString(row.data, "providerThreadId"),
    turnId: getOptionalEventString(row.data, "turnId"),
    parentToolCallId: getOptionalEventString(row.data, "parentToolCallId"),
    rawData: row.data,
  };
}

export function isKnownThreadEvent(
  decoded: DecodedThreadEvent,
): decoded is ThreadEvent {
  return !("rawData" in decoded);
}

/** Extract the optional turnId from any decoded ThreadEvent. */
export function getEventTurnId(decoded: DecodedThreadEvent): string | undefined {
  return "turnId" in decoded ? decoded.turnId : undefined;
}

export function getEventProviderThreadId(
  decoded: DecodedThreadEvent,
): string | undefined {
  return "providerThreadId" in decoded ? decoded.providerThreadId : undefined;
}

export function getEventParentToolCallId(
  decoded: DecodedThreadEvent,
): string | undefined {
  if ("item" in decoded && decoded.item && "parentToolCallId" in decoded.item) {
    return decoded.item.parentToolCallId;
  }
  if ("parentToolCallId" in decoded) {
    return decoded.parentToolCallId;
  }
  return undefined;
}

/** Row metadata that travels alongside the decoded event. */
export interface EventMeta {
  id: string;
  seq: number;
  createdAt: number;
}

export function decodeRow(
  row: ThreadEventRow,
): { event: DecodedThreadEvent; meta: EventMeta } {
  const parsedEvent = threadEventSchema.safeParse({
    type: row.type,
    threadId: row.threadId,
    ...row.data,
  });
  if (parsedEvent.success) {
    return {
      event: parsedEvent.data,
      meta: { id: row.id, seq: row.seq, createdAt: row.createdAt },
    };
  }
  if (knownThreadEventTypeSet.has(row.type)) {
    throw parsedEvent.error;
  }

  return {
    event: buildUnknownDecodedThreadEvent(row),
    meta: { id: row.id, seq: row.seq, createdAt: row.createdAt },
  };
}
