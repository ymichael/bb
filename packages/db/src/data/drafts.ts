import { and, asc, eq, isNotNull, isNull, lt, min } from "drizzle-orm";
import type { PermissionMode, PromptInput } from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { queuedThreadMessages, threads } from "../schema.js";
import { createDraftClaimToken, createDraftId } from "../ids.js";

export interface CreateDraftInput {
  threadId: string;
  content: PromptInput[];
  model: string;
  reasoningLevel: string;
  permissionMode: PermissionMode;
  serviceTier: string;
}

export type DraftRow = typeof queuedThreadMessages.$inferSelect;

export interface ClaimedDraftRow extends DraftRow {
  claimedAt: number;
  claimToken: string;
}

export interface QueuedDraftThreadRow {
  oldestDraftCreatedAt: number | null;
  threadId: string;
}

export interface DeleteDraftInTransactionArgs {
  id: string;
}

export interface ClaimedDraftMutationArgs {
  claimToken: string;
  id: string;
}

export type DeleteClaimedDraftInTransactionArgs = ClaimedDraftMutationArgs;

export type DeleteClaimedDraftArgs = ClaimedDraftMutationArgs;

export interface ReleaseStaleDraftClaimsArgs {
  claimedBefore: number;
}

export type ReleaseDraftClaimArgs = ClaimedDraftMutationArgs;

function requireClaimedDraft(row: DraftRow | null): ClaimedDraftRow | null {
  if (!row || row.claimedAt === null || row.claimToken === null) {
    return null;
  }
  return {
    ...row,
    claimedAt: row.claimedAt,
    claimToken: row.claimToken,
  };
}

export function createDraft(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateDraftInput,
) {
  const now = Date.now();
  const id = createDraftId();
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

export function getDraft(db: DbConnection, id: string) {
  return (
    db
      .select()
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.id, id))
      .get() ?? null
  );
}

export function listDrafts(db: DbConnection, threadId: string) {
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

export function listIdleThreadsWithQueuedDrafts(
  db: DbConnection,
): QueuedDraftThreadRow[] {
  return db
    .select({
      threadId: threads.id,
      oldestDraftCreatedAt: min(queuedThreadMessages.createdAt),
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

export function claimDraft(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
): ClaimedDraftRow | null {
  const claimedDraft = db.transaction(
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
      const claimToken = createDraftClaimToken();
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

      return requireClaimedDraft(updated ?? null);
    },
    { behavior: "immediate" },
  );

  if (claimedDraft) {
    notifier.notifyThread(claimedDraft.threadId, ["queue-changed"]);
  }
  return claimedDraft;
}

export function claimNextDraft(
  db: DbConnection,
  notifier: DbNotifier,
  threadId: string,
): ClaimedDraftRow | null {
  const claimedDraft = db.transaction(
    (tx) => {
      const nextDraft = tx
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
      if (!nextDraft) {
        return null;
      }

      const now = Date.now();
      const claimToken = createDraftClaimToken();
      const updated = tx
        .update(queuedThreadMessages)
        .set({ claimedAt: now, claimToken, updatedAt: now })
        .where(
          and(
            eq(queuedThreadMessages.id, nextDraft.id),
            isNull(queuedThreadMessages.claimedAt),
            isNull(queuedThreadMessages.claimToken),
          ),
        )
        .returning()
        .get();

      return requireClaimedDraft(updated ?? null);
    },
    { behavior: "immediate" },
  );

  if (claimedDraft) {
    notifier.notifyThread(claimedDraft.threadId, ["queue-changed"]);
  }
  return claimedDraft;
}

export function releaseDraftClaim(
  db: DbConnection,
  notifier: DbNotifier,
  args: ReleaseDraftClaimArgs,
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

export function releaseStaleDraftClaims(
  db: DbConnection,
  notifier: DbNotifier,
  args: ReleaseStaleDraftClaimsArgs,
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

export function deleteClaimedDraftInTransaction(
  db: DbTransaction,
  args: DeleteClaimedDraftInTransactionArgs,
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

export function deleteClaimedDraft(
  db: DbConnection,
  notifier: DbNotifier,
  args: DeleteClaimedDraftArgs,
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

export function deleteDraftInTransaction(
  db: DbTransaction,
  args: DeleteDraftInTransactionArgs,
): boolean {
  const deleted =
    db
      .delete(queuedThreadMessages)
      .where(eq(queuedThreadMessages.id, args.id))
      .returning({ id: queuedThreadMessages.id })
      .get() ?? null;
  return deleted !== null;
}

export function deleteDraft(
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
