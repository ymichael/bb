import { and, eq } from "drizzle-orm";
import type {
  LifecycleOperationState,
  ThreadOperationKind,
} from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import { createThreadOperationId } from "../ids.js";
import { threadOperations } from "../schema.js";

type ThreadOperationWriteConnection = DbConnection | DbTransaction;
type ThreadOperationReadConnection = DbConnection | DbTransaction;

export type ThreadOperationRow = typeof threadOperations.$inferSelect;

export interface GetThreadOperationArgs {
  kind: ThreadOperationKind;
  threadId: string;
}

export interface UpsertThreadOperationInput {
  kind: ThreadOperationKind;
  payload: string;
  requestedAt?: number;
  threadId: string;
}

export interface UpdateThreadOperationStateArgs {
  commandId?: string | null;
  completedAt?: number | null;
  failureReason?: string | null;
  kind: ThreadOperationKind;
  payload?: string;
  queuedAt?: number | null;
  state: LifecycleOperationState;
  threadId: string;
}

function getThreadOperationRecord(
  db: ThreadOperationReadConnection,
  args: GetThreadOperationArgs,
): ThreadOperationRow | null {
  return db
    .select()
    .from(threadOperations)
    .where(
      and(
        eq(threadOperations.threadId, args.threadId),
        eq(threadOperations.kind, args.kind),
      ),
    )
    .get() ?? null;
}

function updateThreadOperationStateRecord(
  db: ThreadOperationWriteConnection,
  args: UpdateThreadOperationStateArgs,
): ThreadOperationRow | null {
  const now = Date.now();

  return db
    .update(threadOperations)
    .set({
      state: args.state,
      payload: args.payload,
      commandId: args.commandId,
      queuedAt: args.queuedAt,
      completedAt: args.completedAt,
      failureReason: args.failureReason,
      updatedAt: now,
    })
    .where(
      and(
        eq(threadOperations.threadId, args.threadId),
        eq(threadOperations.kind, args.kind),
      ),
    )
    .returning()
    .get() ?? null;
}

export function getThreadOperation(
  db: ThreadOperationReadConnection,
  args: GetThreadOperationArgs,
): ThreadOperationRow | null {
  return getThreadOperationRecord(db, args);
}

export function getThreadOperationByCommandId(
  db: ThreadOperationReadConnection,
  commandId: string,
): ThreadOperationRow | null {
  return db
    .select()
    .from(threadOperations)
    .where(eq(threadOperations.commandId, commandId))
    .get() ?? null;
}

export function upsertThreadOperation(
  db: ThreadOperationWriteConnection,
  input: UpsertThreadOperationInput,
): ThreadOperationRow {
  const now = Date.now();
  const requestedAt = input.requestedAt ?? now;
  const existing = getThreadOperationRecord(db, {
    threadId: input.threadId,
    kind: input.kind,
  });

  if (existing) {
    return updateThreadOperationStateRecord(db, {
      threadId: input.threadId,
      kind: input.kind,
      payload: input.payload,
      state: "requested",
      commandId: null,
      queuedAt: null,
      completedAt: null,
      failureReason: null,
    }) ?? existing;
  }

  return db
    .insert(threadOperations)
    .values({
      id: createThreadOperationId(),
      threadId: input.threadId,
      kind: input.kind,
      state: "requested",
      payload: input.payload,
      commandId: null,
      requestedAt,
      queuedAt: null,
      completedAt: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function markThreadOperationQueued(
  db: ThreadOperationWriteConnection,
  args: {
    commandId: string;
    kind: ThreadOperationKind;
    queuedAt?: number;
    threadId: string;
  },
): ThreadOperationRow | null {
  return updateThreadOperationStateRecord(db, {
    threadId: args.threadId,
    kind: args.kind,
    state: "queued",
    commandId: args.commandId,
    queuedAt: args.queuedAt ?? Date.now(),
    completedAt: null,
    failureReason: null,
  });
}

export function markThreadOperationFetched(
  db: ThreadOperationWriteConnection,
  args: GetThreadOperationArgs,
): ThreadOperationRow | null {
  const existing = getThreadOperationRecord(db, args);
  if (!existing) {
    return null;
  }
  return updateThreadOperationStateRecord(db, {
    threadId: args.threadId,
    kind: args.kind,
    payload: existing.payload,
    state: "fetched",
    commandId: existing.commandId,
    queuedAt: existing.queuedAt,
    completedAt: null,
    failureReason: null,
  });
}

export function markThreadOperationCompleted(
  db: ThreadOperationWriteConnection,
  args: GetThreadOperationArgs & { completedAt?: number },
): ThreadOperationRow | null {
  const existing = getThreadOperationRecord(db, args);
  if (!existing) {
    return null;
  }
  return updateThreadOperationStateRecord(db, {
    threadId: args.threadId,
    kind: args.kind,
    payload: existing.payload,
    state: "completed",
    commandId: existing.commandId,
    queuedAt: existing.queuedAt,
    completedAt: args.completedAt ?? Date.now(),
    failureReason: null,
  });
}

export function markThreadOperationFailed(
  db: ThreadOperationWriteConnection,
  args: GetThreadOperationArgs & {
    completedAt?: number;
    failureReason: string;
  },
): ThreadOperationRow | null {
  const existing = getThreadOperationRecord(db, args);
  if (!existing) {
    return null;
  }
  return updateThreadOperationStateRecord(db, {
    threadId: args.threadId,
    kind: args.kind,
    payload: existing.payload,
    state: "failed",
    commandId: existing.commandId,
    queuedAt: existing.queuedAt,
    completedAt: args.completedAt ?? Date.now(),
    failureReason: args.failureReason,
  });
}

export function cancelThreadOperation(
  db: ThreadOperationWriteConnection,
  args: GetThreadOperationArgs & { completedAt?: number },
): ThreadOperationRow | null {
  const existing = getThreadOperationRecord(db, args);
  if (!existing) {
    return null;
  }
  return updateThreadOperationStateRecord(db, {
    threadId: args.threadId,
    kind: args.kind,
    payload: existing.payload,
    state: "cancelled",
    commandId: existing.commandId,
    queuedAt: existing.queuedAt,
    completedAt: args.completedAt ?? Date.now(),
    failureReason: null,
  });
}
