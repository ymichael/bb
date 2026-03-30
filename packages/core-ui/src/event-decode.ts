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
const providerEventTypesRequiringProviderThreadId = new Set<string>(
  providerEventTypeValues.filter((type) => type !== "thread/started"),
);

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
  return knownThreadEventTypeSet.has(decoded.type);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLegacyItemStatus(status: unknown): unknown {
  return status === "inProgress" ? "pending" : status;
}

function stripNullOptionalFields(
  data: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  let nextData = data;
  for (const key of keys) {
    if (nextData[key] !== null) {
      continue;
    }
    if (nextData === data) {
      nextData = { ...data };
    }
    delete nextData[key];
  }
  return nextData;
}

function normalizeLegacyItemRowData(
  row: ThreadEventRow,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (
    (row.type !== "item/started" && row.type !== "item/completed") ||
    !isRecord(data.item)
  ) {
    return data;
  }

  const item = data.item;
  if (item.type !== "commandExecution" && item.type !== "fileChange") {
    return data;
  }

  const nextItem = stripNullOptionalFields(
    {
      ...item,
      status: normalizeLegacyItemStatus(item.status),
    },
    ["aggregatedOutput", "exitCode", "durationMs"],
  );

  return {
    ...data,
    item: nextItem,
  };
}

function normalizePersistedRow(row: ThreadEventRow): ThreadEventRow {
  if (!isRecord(row.data)) {
    return row;
  }

  let data = row.data;

  if (
    (row.type === "turn/started" || row.type === "turn/completed") &&
    isRecord(data.turn) &&
    typeof data.turn.id === "string"
  ) {
    data = {
      ...data,
      turnId: data.turn.id,
      ...(row.type === "turn/completed" && typeof data.turn.status === "string"
        ? { status: data.turn.status === "inProgress" ? "interrupted" : data.turn.status }
        : {}),
      ...(row.type === "turn/completed" &&
          isRecord(data.turn.error) &&
          typeof data.turn.error.message === "string"
        ? { error: { message: data.turn.error.message } }
        : {}),
    };
  }

  if (
    row.type === "turn/completed" &&
    !("status" in data) &&
    typeof getOptionalEventString(data, "turnId") === "string"
  ) {
    data = {
      ...data,
      status: "completed",
    };
  }

  if (row.type === "system/thread/interrupted" && !("reason" in data)) {
    data = {
      ...data,
      reason: "user",
    };
  }

  if (row.type === "system/thread-title/updated" && !("source" in data)) {
    data = {
      ...data,
      source: "provider",
    };
  }

  if (
    (row.type === "item/started" || row.type === "item/completed") &&
    isRecord(data.item) &&
    data.item.type === "webSearch" &&
    isRecord(data.item.action) &&
    typeof data.item.action.type === "string"
  ) {
    data = {
      ...data,
      item: {
        ...data.item,
        action: data.item.action.type,
      },
    };
  }

  data = normalizeLegacyItemRowData(row, data);

  if (
    providerEventTypesRequiringProviderThreadId.has(row.type) &&
    getOptionalEventString(data, "providerThreadId") === undefined
  ) {
    data = {
      ...data,
      providerThreadId:
        getOptionalEventString(data, "threadId") ?? row.threadId,
    };
  }

  return data === row.data ? row : { ...row, data };
}

export function decodeRow(
  row: ThreadEventRow,
): { event: DecodedThreadEvent; meta: EventMeta } {
  const normalizedRow = normalizePersistedRow(row);
  const parsedEvent = threadEventSchema.safeParse({
    type: normalizedRow.type,
    ...normalizedRow.data,
    threadId: normalizedRow.threadId,
  });
  if (parsedEvent.success) {
    return {
      event: parsedEvent.data,
      meta: {
        id: normalizedRow.id,
        seq: normalizedRow.seq,
        createdAt: normalizedRow.createdAt,
      },
    };
  }
  if (knownThreadEventTypeSet.has(normalizedRow.type)) {
    throw parsedEvent.error;
  }

  return {
    event: buildUnknownDecodedThreadEvent(normalizedRow),
    meta: {
      id: normalizedRow.id,
      seq: normalizedRow.seq,
      createdAt: normalizedRow.createdAt,
    },
  };
}
