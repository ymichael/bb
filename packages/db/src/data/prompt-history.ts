import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import {
  PROMPT_HISTORY_ENTRY_LIMIT,
  type ThreadEventType,
} from "@bb/domain";
import type { DbConnection } from "../connection.js";
import { events, threads } from "../schema.js";

export interface StoredPromptHistoryEventRow {
  createdAt: number;
  data: string;
  id: string;
  sequence: number;
  threadId: string;
  type: ThreadEventType;
}

export interface ListStoredPromptHistoryArgs {
  limit: number;
}

export interface ListStoredProjectPromptHistoryArgs
  extends ListStoredPromptHistoryArgs {
  projectId: string;
}

export interface ListStoredThreadPromptHistoryArgs
  extends ListStoredPromptHistoryArgs {
  threadId: string;
}

function userInitiatedPromptHistoryEventPredicate() {
  return sql`json_extract(${events.data}, '$.initiator') = 'user'`;
}

function promptHistoryInputPredicate() {
  return sql`json_type(${events.data}, '$.input') IS NOT NULL`;
}

function projectCreatePromptHistoryEventPredicate() {
  return or(
    and(
      eq(events.type, "client/turn/requested"),
      userInitiatedPromptHistoryEventPredicate(),
      sql`json_extract(${events.data}, '$.target.kind') = 'thread-start'`,
    ),
    and(
      eq(events.type, "client/thread/start"),
      userInitiatedPromptHistoryEventPredicate(),
      promptHistoryInputPredicate(),
    ),
  );
}

function threadFollowUpPromptHistoryEventPredicate() {
  return or(
    and(
      eq(events.type, "client/turn/requested"),
      userInitiatedPromptHistoryEventPredicate(),
      sql`json_extract(${events.data}, '$.target.kind') <> 'thread-start'`,
    ),
    and(
      eq(events.type, "client/turn/start"),
      userInitiatedPromptHistoryEventPredicate(),
      promptHistoryInputPredicate(),
    ),
  );
}

function rawPromptHistoryRowLimit(limit: number): number {
  // Fetch one extra visible window to absorb consecutive duplicate collapse
  // without falling back to OFFSET paging.
  return Math.min(
    PROMPT_HISTORY_ENTRY_LIMIT * 2,
    limit + PROMPT_HISTORY_ENTRY_LIMIT,
  );
}

export function listStoredProjectPromptHistoryEventRows(
  db: DbConnection,
  args: ListStoredProjectPromptHistoryArgs,
): StoredPromptHistoryEventRow[] {
  return db
    .select({
      createdAt: events.createdAt,
      data: events.data,
      id: events.id,
      sequence: events.sequence,
      threadId: events.threadId,
      type: events.type,
    })
    .from(events)
    .innerJoin(threads, eq(threads.id, events.threadId))
    .where(
      and(
        eq(threads.projectId, args.projectId),
        isNull(threads.deletedAt),
        projectCreatePromptHistoryEventPredicate(),
      ),
    )
    .orderBy(desc(events.createdAt), desc(events.sequence), desc(events.id))
    .limit(rawPromptHistoryRowLimit(args.limit))
    .all();
}

export function listStoredThreadPromptHistoryEventRows(
  db: DbConnection,
  args: ListStoredThreadPromptHistoryArgs,
): StoredPromptHistoryEventRow[] {
  return db
    .select({
      createdAt: events.createdAt,
      data: events.data,
      id: events.id,
      sequence: events.sequence,
      threadId: events.threadId,
      type: events.type,
    })
    .from(events)
    .where(
      and(
        eq(events.threadId, args.threadId),
        threadFollowUpPromptHistoryEventPredicate(),
      ),
    )
    .orderBy(desc(events.createdAt), desc(events.sequence), desc(events.id))
    .limit(rawPromptHistoryRowLimit(args.limit))
    .all();
}
