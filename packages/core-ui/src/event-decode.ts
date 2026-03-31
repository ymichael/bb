import { threadEventSchema } from "@bb/domain";
import type { ThreadEvent, ThreadEventRow } from "@bb/domain";

/** Extract the optional turnId from any decoded ThreadEvent. */
export function getEventTurnId(decoded: ThreadEvent): string | undefined {
  return "turnId" in decoded ? decoded.turnId : undefined;
}

export function getEventProviderThreadId(
  decoded: ThreadEvent,
): string | undefined {
  return "providerThreadId" in decoded ? decoded.providerThreadId : undefined;
}

export function getEventParentToolCallId(
  decoded: ThreadEvent,
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

function buildEventMeta(row: ThreadEventRow): EventMeta {
  return {
    id: row.id,
    seq: row.seq,
    createdAt: row.createdAt,
  };
}

export function decodeRow(
  row: ThreadEventRow,
): { event: ThreadEvent; meta: EventMeta } {
  const parsedEvent = threadEventSchema.safeParse({
    type: row.type,
    ...row.data,
    threadId: row.threadId,
  });
  return {
    event: parsedEvent.success ? parsedEvent.data : (() => {
      throw parsedEvent.error;
    })(),
    meta: buildEventMeta(row),
  };
}
