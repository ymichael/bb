import { and, eq } from "drizzle-orm";
import type { ThreadDynamicContextFileStatus } from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import { threadDynamicContextFileStates } from "../schema.js";

type ThreadDynamicContextFileStateConnection = DbConnection | DbTransaction;

export interface ThreadDynamicContextFileStateKey {
  fileKey: string;
  threadId: string;
}

export interface UpsertThreadDynamicContextFileStateInput
  extends ThreadDynamicContextFileStateKey {
  contentHash: string;
  contentStatus: ThreadDynamicContextFileStatus;
  shownAt: number;
}

export function getThreadDynamicContextFileState(
  db: ThreadDynamicContextFileStateConnection,
  key: ThreadDynamicContextFileStateKey,
) {
  return (
    db
      .select()
      .from(threadDynamicContextFileStates)
      .where(
        and(
          eq(threadDynamicContextFileStates.threadId, key.threadId),
          eq(threadDynamicContextFileStates.fileKey, key.fileKey),
        ),
      )
      .get() ?? null
  );
}

export function upsertThreadDynamicContextFileStateInTransaction(
  db: DbTransaction,
  input: UpsertThreadDynamicContextFileStateInput,
) {
  const now = Date.now();
  return db
    .insert(threadDynamicContextFileStates)
    .values({
      threadId: input.threadId,
      fileKey: input.fileKey,
      contentStatus: input.contentStatus,
      contentHash: input.contentHash,
      shownAt: input.shownAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        threadDynamicContextFileStates.threadId,
        threadDynamicContextFileStates.fileKey,
      ],
      set: {
        contentStatus: input.contentStatus,
        contentHash: input.contentHash,
        shownAt: input.shownAt,
        updatedAt: now,
      },
    })
    .returning()
    .get();
}

export function upsertThreadDynamicContextFileState(
  db: DbConnection,
  input: UpsertThreadDynamicContextFileStateInput,
) {
  return db.transaction((tx) =>
    upsertThreadDynamicContextFileStateInTransaction(tx, input),
  );
}
