import {
  findStoredEventRow as findStoredEventRowRecord,
  getLatestThreadOutputEventRow,
  getLatestThreadSystemErrorEventRow,
  listStoredEventRows as listStoredEventRowRecords,
} from "@bb/db";
import type { DbConnection, StoredEventRow } from "@bb/db";
import { toRecord } from "@bb/core-ui";
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

interface ListThreadEventRowsArgs {
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  order?: "asc" | "desc";
  threadId: string;
  types?: readonly ThreadEventType[];
}

interface FindThreadEventArgs {
  afterSeq?: number;
  threadId: string;
  type: ThreadEventType;
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

function parseStoredEventRow(row: StoredEventRow): ThreadEventRow {
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
    beforeSequence: args.beforeSeq,
    limit: args.limit,
    order: args.order,
    threadId: args.threadId,
    types: args.types,
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

export function getLastThreadErrorMessage(
  db: DbConnection,
  threadId: string,
): string | null {
  const row = getLatestThreadSystemErrorEventRow(db, { threadId });
  if (!row) return null;
  const eventRow = parseStoredEventRow(row);
  return eventRow.type === "system/error" ? eventRow.data.message : null;
}
