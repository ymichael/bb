import {
  findStoredEventRow as findStoredEventRowRecord,
  getLatestThreadOutputEventRow,
  listStoredEventRows as listStoredEventRowRecords,
} from "@bb/db";
import type { DbConnection, StoredEventRow } from "@bb/db";
import { buildThreadEventRow, parseStoredThreadEvent } from "@bb/domain";
import { threadScope, turnScope } from "@bb/domain";
import type {
  ThreadEvent,
  ThreadEventRow,
  ThreadEventScope,
  ThreadEventType,
} from "@bb/domain";
import { ApiError } from "../../errors.js";

type StoredEventPayloadRow = Pick<
  StoredEventRow,
  "data" | "sequence" | "threadId" | "type"
>;

export interface ListThreadEventRowsArgs {
  afterSeq?: number;
  limit?: number;
  threadId: string;
}

export interface FindThreadEventArgs {
  afterSeq?: number;
  threadId: string;
  type: ThreadEventType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function parseStoredEventPayload(
  row: StoredEventPayloadRow,
): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(row.data);
  } catch {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is not valid JSON`,
    );
  }

  const record = toRecord(data);
  if (!record) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
    );
  }

  return record;
}

function parseStoredEventScope(row: StoredEventRow): ThreadEventScope {
  switch (row.scopeKind) {
    case "thread":
      return threadScope();
    case "turn":
      if (row.turnId === null) {
        throw new ApiError(
          500,
          "internal_error",
          `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} has turn scope without turn_id`,
        );
      }
      return turnScope(row.turnId);
    default:
      throw new ApiError(
        500,
        "internal_error",
        `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} has invalid scope_kind`,
      );
  }
}

export function parseStoredEvent(row: StoredEventRow): ThreadEvent {
  return parseStoredThreadEvent({
    type: row.type,
    data: parseStoredEventPayload(row),
    threadId: row.threadId,
    providerThreadId: row.providerThreadId,
    scope: parseStoredEventScope(row),
  });
}

export function parseStoredEventRow(row: StoredEventRow): ThreadEventRow {
  return buildThreadEventRow({
    id: row.id,
    scope: parseStoredEventScope(row),
    threadId: row.threadId,
    seq: row.sequence,
    createdAt: row.createdAt,
    event: parseStoredEvent(row),
  });
}

export function listThreadEventRows(
  db: DbConnection,
  args: ListThreadEventRowsArgs,
): ThreadEventRow[] {
  const rows = listStoredEventRowRecords(db, {
    afterSequence: args.afterSeq,
    limit: args.limit,
    threadId: args.threadId,
  });
  return rows.map((row) => parseStoredEventRow(row));
}

export function findThreadEvent(
  db: DbConnection,
  args: FindThreadEventArgs,
): ThreadEventRow | null {
  const row = findStoredEventRowRecord(db, {
    afterSequence: args.afterSeq,
    threadId: args.threadId,
    type: args.type,
  });
  return row ? parseStoredEventRow(row) : null;
}

export function getLastThreadOutput(
  db: DbConnection,
  threadId: string,
): string | null {
  const row = getLatestThreadOutputEventRow(db, { threadId });

  if (!row) return null;

  const eventRow = parseStoredEventRow(row);

  if (eventRow.type === "system/manager/user_message") {
    return eventRow.data.text.length > 0 ? eventRow.data.text : null;
  }

  if (
    eventRow.type === "item/completed" &&
    eventRow.data.item.type === "agentMessage" &&
    eventRow.data.item.text.length > 0
  ) {
    return eventRow.data.item.text;
  }

  return null;
}
