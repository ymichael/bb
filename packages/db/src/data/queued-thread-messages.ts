import { and, asc, eq, isNotNull, isNull, lt, min } from "drizzle-orm";
import type { PermissionMode, PromptInput } from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { queuedThreadMessages, threads } from "../schema.js";
import { createQueuedThreadMessageClaimToken, createQueuedThreadMessageId } from "../ids.js";

export interface CreateQueuedThreadMessageInput {
  threadId: string;
  content: PromptInput[];
  model: string;
  reasoningLevel: string;
  permissionMode: PermissionMode;
  serviceTier: string;
}

export type QueuedThreadMessageRow = typeof queuedThreadMessages.$inferSelect;

export interface ClaimedQueuedThreadMessageRow extends QueuedThreadMessageRow {
  claimedAt: number;
  claimToken: string;
}

export interface QueuedMessageThreadRow {
  oldestQueuedMessageCreatedAt: number | null;
  threadId: string;
}

export interface DeleteQueuedThreadMessageInTransactionArgs {
  id: string;
}

export interface ClaimedQueuedThreadMessageMutationArgs {
  claimToken: string;
  id: string;
}

export type DeleteClaimedQueuedThreadMessageInTransactionArgs = ClaimedQueuedThreadMessageMutationArgs;

export type DeleteClaimedQueuedThreadMessageArgs = ClaimedQueuedThreadMessageMutationArgs;

export interface ReleaseStaleQueuedMessageClaimsArgs {
  claimedBefore: number;
}

export type ReleaseQueuedMessageClaimArgs = ClaimedQueuedThreadMessageMutationArgs;

function requireClaimedQueuedThreadMessage(row: QueuedThreadMessageRow | null): ClaimedQueuedThreadMessageRow | null {
  if (!row || row.claimedAt === null || row.claimToken === null) {
    return null;
  }
  return {
    ...row,
    claimedAt: row.claimedAt,
    claimToken: row.claimToken,
  };
}

export function createQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateQueuedThreadMessageInput,
) {
  const now = Date.now();
  const id = createQueuedThreadMessageId();
  const row = db
    .insert(queuedThreadMessages)
    .values({
      id,
      threadId: input.threadId,
      content: JSON.stringify(input.content),
      model: input.model,
      reasoningLevel: input.reasoningLevel,
      permissionMode: input.permissionMode,
      serviceTier: input.serviceTier,
      claimedAt: null,
      claimToken: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  notifier.notifyThread(input.threadId, ["queue-changed"]);
  return row;
}

export function getQueuedThreadMessage(db: DbConnection, id: string) {
  return (
    db
      .select()
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.id, id))
      .get() ?? null
  );
}

export function listQueuedThreadMessages(db: DbConnection, threadId: string) {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        eq(queuedThreadMessages.threadId, threadId),
        isNull(queuedThreadMessages.claimedAt),
        isNull(queuedThreadMessages.claimToken),
      ),
    )
    .orderBy(asc(queuedThreadMessages.createdAt), asc(queuedThreadMessages.id))
    .all();
}

export function listIdleThreadsWithQueuedMessages(
  db: DbConnection,
): QueuedMessageThreadRow[] {
  return db
    .select({
      threadId: threads.id,
      oldestQueuedMessageCreatedAt: min(queuedThreadMessages.createdAt),
    })
    .from(queuedThreadMessages)
    .innerJoin(threads, eq(threads.id, queuedThreadMessages.threadId))
    .where(
      and(
        eq(threads.status, "idle"),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
        isNull(threads.stopRequestedAt),
        isNotNull(threads.environmentId),
        isNull(queuedThreadMessages.claimedAt),
        isNull(queuedThreadMessages.claimToken),
      ),
    )
    .groupBy(threads.id)
    .orderBy(asc(min(queuedThreadMessages.createdAt)), asc(threads.id))
    .all();
}

export function claimQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
): ClaimedQueuedThreadMessageRow | null {
  const claimedQueuedMessage = db.transaction(
    (tx) => {
      const existing = tx
        .select()
        .from(queuedThreadMessages)
        .where(eq(queuedThreadMessages.id, id))
        .get();
      if (!existing || existing.claimedAt !== null || existing.claimToken !== null) {
        return null;
      }

      const now = Date.now();
      const claimToken = createQueuedThreadMessageClaimToken();
      const updated = tx
        .update(queuedThreadMessages)
        .set({ claimedAt: now, claimToken, updatedAt: now })
        .where(
          and(
            eq(queuedThreadMessages.id, id),
            isNull(queuedThreadMessages.claimedAt),
            isNull(queuedThreadMessages.claimToken),
          ),
        )
        .returning()
        .get();

      return requireClaimedQueuedThreadMessage(updated ?? null);
    },
    { behavior: "immediate" },
  );

  if (claimedQueuedMessage) {
    notifier.notifyThread(claimedQueuedMessage.threadId, ["queue-changed"]);
  }
  return claimedQueuedMessage;
}

export function claimNextQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  threadId: string,
): ClaimedQueuedThreadMessageRow | null {
  const claimedQueuedMessage = db.transaction(
    (tx) => {
      const nextQueuedMessage = tx
        .select()
        .from(queuedThreadMessages)
        .where(
          and(
            eq(queuedThreadMessages.threadId, threadId),
            isNull(queuedThreadMessages.claimedAt),
            isNull(queuedThreadMessages.claimToken),
          ),
        )
        .orderBy(
          asc(queuedThreadMessages.createdAt),
          asc(queuedThreadMessages.id),
        )
        .limit(1)
        .get();
      if (!nextQueuedMessage) {
        return null;
      }

      const now = Date.now();
      const claimToken = createQueuedThreadMessageClaimToken();
      const updated = tx
        .update(queuedThreadMessages)
        .set({ claimedAt: now, claimToken, updatedAt: now })
        .where(
          and(
            eq(queuedThreadMessages.id, nextQueuedMessage.id),
            isNull(queuedThreadMessages.claimedAt),
            isNull(queuedThreadMessages.claimToken),
          ),
        )
        .returning()
        .get();

      return requireClaimedQueuedThreadMessage(updated ?? null);
    },
    { behavior: "immediate" },
  );

  if (claimedQueuedMessage) {
    notifier.notifyThread(claimedQueuedMessage.threadId, ["queue-changed"]);
  }
  return claimedQueuedMessage;
}

export function releaseQueuedMessageClaim(
  db: DbConnection,
  notifier: DbNotifier,
  args: ReleaseQueuedMessageClaimArgs,
): boolean {
  const existing = db
    .select()
    .from(queuedThreadMessages)
    .where(eq(queuedThreadMessages.id, args.id))
    .get();
  if (
    !existing ||
    existing.claimedAt === null ||
    existing.claimToken !== args.claimToken
  ) {
    return false;
  }

  const now = Date.now();
  const result = db
    .update(queuedThreadMessages)
    .set({ claimedAt: null, claimToken: null, updatedAt: now })
    .where(
      and(
        eq(queuedThreadMessages.id, args.id),
        isNotNull(queuedThreadMessages.claimedAt),
        eq(queuedThreadMessages.claimToken, args.claimToken),
      ),
    )
    .run();
  if (result.changes === 0) {
    return false;
  }

  notifier.notifyThread(existing.threadId, ["queue-changed"]);
  return true;
}

export function releaseStaleQueuedMessageClaims(
  db: DbConnection,
  notifier: DbNotifier,
  args: ReleaseStaleQueuedMessageClaimsArgs,
): number {
  const staleRows = db
    .select({
      id: queuedThreadMessages.id,
      threadId: queuedThreadMessages.threadId,
    })
    .from(queuedThreadMessages)
    .where(
      and(
        isNotNull(queuedThreadMessages.claimedAt),
        lt(queuedThreadMessages.claimedAt, args.claimedBefore),
      ),
    )
    .all();
  if (staleRows.length === 0) {
    return 0;
  }

  const now = Date.now();
  const result = db
    .update(queuedThreadMessages)
    .set({ claimedAt: null, claimToken: null, updatedAt: now })
    .where(
      and(
        isNotNull(queuedThreadMessages.claimedAt),
        lt(queuedThreadMessages.claimedAt, args.claimedBefore),
      ),
    )
    .run();

  for (const threadId of new Set(staleRows.map((row) => row.threadId))) {
    notifier.notifyThread(threadId, ["queue-changed"]);
  }

  return result.changes;
}

export function deleteClaimedQueuedThreadMessageInTransaction(
  db: DbTransaction,
  args: DeleteClaimedQueuedThreadMessageInTransactionArgs,
): boolean {
  const deleted =
    db
      .delete(queuedThreadMessages)
      .where(
        and(
          eq(queuedThreadMessages.id, args.id),
          eq(queuedThreadMessages.claimToken, args.claimToken),
        ),
      )
      .returning({ id: queuedThreadMessages.id })
      .get() ?? null;
  return deleted !== null;
}

export function deleteClaimedQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  args: DeleteClaimedQueuedThreadMessageArgs,
): boolean {
  const existing = db
    .select()
    .from(queuedThreadMessages)
    .where(eq(queuedThreadMessages.id, args.id))
    .get();
  if (!existing || existing.claimToken !== args.claimToken) {
    return false;
  }

  const deleted =
    db
      .delete(queuedThreadMessages)
      .where(
        and(
          eq(queuedThreadMessages.id, args.id),
          eq(queuedThreadMessages.claimToken, args.claimToken),
        ),
      )
      .returning({ id: queuedThreadMessages.id })
      .get() ?? null;
  if (!deleted) {
    return false;
  }

  notifier.notifyThread(existing.threadId, ["queue-changed"]);
  return true;
}

export function deleteQueuedThreadMessageInTransaction(
  db: DbTransaction,
  args: DeleteQueuedThreadMessageInTransactionArgs,
): boolean {
  const deleted =
    db
      .delete(queuedThreadMessages)
      .where(eq(queuedThreadMessages.id, args.id))
      .returning({ id: queuedThreadMessages.id })
      .get() ?? null;
  return deleted !== null;
}

export function deleteQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
) {
  const existing = db
    .select()
    .from(queuedThreadMessages)
    .where(eq(queuedThreadMessages.id, id))
    .get();
  if (!existing) return false;
  db.delete(queuedThreadMessages).where(eq(queuedThreadMessages.id, id)).run();
  notifier.notifyThread(existing.threadId, ["queue-changed"]);
  return true;
}
