import { and, desc, eq, inArray } from "drizzle-orm";
import type {
  PendingInteractionKind,
  PendingInteractionStatus,
} from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import { createPendingInteractionId } from "../ids.js";
import { pendingInteractions } from "../schema.js";

type PendingInteractionWriteConnection = DbConnection | DbTransaction;
type PendingInteractionReadConnection = DbConnection | DbTransaction;

export type PendingInteractionRow = typeof pendingInteractions.$inferSelect;

export interface CreatePendingInteractionInput {
  kind: PendingInteractionKind;
  payload: string;
  providerId: string;
  providerRequestId: string;
  providerRequestMethod: string;
  providerThreadId: string;
  threadId: string;
  turnId: string;
}

export interface PendingInteractionProviderRequestIdentity {
  providerId: string;
  providerRequestId: string;
  providerThreadId: string;
}

export interface ListPendingInteractionsArgs {
  limit?: number;
  statuses?: readonly PendingInteractionStatus[];
  threadId: string;
}

export interface ListPendingInteractionsByStatusArgs {
  limit?: number;
  offset?: number;
  statuses: readonly PendingInteractionStatus[];
}

export interface SetPendingInteractionTerminalStateArgs {
  allowedCurrentStatuses?: readonly PendingInteractionStatus[];
  id: string;
  resolution: string | null;
  resolvedAt?: number;
  status: "expired" | "interrupted" | "rejected" | "resolved";
  statusReason: string | null;
}

export interface InterruptPendingInteractionsForThreadsArgs {
  providerId: string;
  resolvedAt?: number;
  statusReason: string;
  threadIds: readonly string[];
}

export interface InterruptPendingInteractionsForThreadIdsArgs {
  resolvedAt?: number;
  statusReason: string;
  threadIds: readonly string[];
}

export interface ListPendingInteractionThreadIdsArgs {
  threadIds: readonly string[];
}

const SQLITE_IN_CLAUSE_BATCH_SIZE = 900;

function getPendingInteractionRecord(
  db: PendingInteractionReadConnection,
  id: string,
): PendingInteractionRow | null {
  return db
    .select()
    .from(pendingInteractions)
    .where(eq(pendingInteractions.id, id))
    .get() ?? null;
}

function updatePendingInteractionTerminalState(
  db: PendingInteractionWriteConnection,
  args: SetPendingInteractionTerminalStateArgs,
): PendingInteractionRow | null {
  const now = Date.now();

  return db
    .update(pendingInteractions)
    .set({
      status: args.status,
      resolution: args.resolution,
      statusReason: args.statusReason,
      resolvedAt: args.resolvedAt ?? now,
      updatedAt: now,
    })
    .where(
      and(
        eq(pendingInteractions.id, args.id),
        args.allowedCurrentStatuses
          ? inArray(pendingInteractions.status, [...args.allowedCurrentStatuses])
          : undefined,
      ),
    )
    .returning()
    .get() ?? null;
}

export function createPendingInteraction(
  db: PendingInteractionWriteConnection,
  input: CreatePendingInteractionInput,
): PendingInteractionRow {
  const now = Date.now();

  return db
    .insert(pendingInteractions)
    .values({
      id: createPendingInteractionId(),
      threadId: input.threadId,
      turnId: input.turnId,
      providerId: input.providerId,
      providerThreadId: input.providerThreadId,
      providerRequestId: input.providerRequestId,
      providerRequestMethod: input.providerRequestMethod,
      kind: input.kind,
      status: "pending",
      payload: input.payload,
      resolution: null,
      statusReason: null,
      createdAt: now,
      resolvedAt: null,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function getPendingInteraction(
  db: PendingInteractionReadConnection,
  id: string,
): PendingInteractionRow | null {
  return getPendingInteractionRecord(db, id);
}

export function getPendingInteractionByProviderRequest(
  db: PendingInteractionReadConnection,
  args: PendingInteractionProviderRequestIdentity,
): PendingInteractionRow | null {
  return db
    .select()
    .from(pendingInteractions)
    .where(
      and(
        eq(pendingInteractions.providerId, args.providerId),
        eq(pendingInteractions.providerThreadId, args.providerThreadId),
        eq(pendingInteractions.providerRequestId, args.providerRequestId),
      ),
    )
    .get() ?? null;
}

export function getActivePendingInteractionForThread(
  db: PendingInteractionReadConnection,
  threadId: string,
): PendingInteractionRow | null {
  return db
    .select()
    .from(pendingInteractions)
    .where(
      and(
        eq(pendingInteractions.threadId, threadId),
        eq(pendingInteractions.status, "pending"),
      ),
    )
    .orderBy(desc(pendingInteractions.createdAt))
    .get() ?? null;
}

export function listPendingInteractionsByThread(
  db: PendingInteractionReadConnection,
  args: ListPendingInteractionsArgs,
): PendingInteractionRow[] {
  const query = db
    .select()
    .from(pendingInteractions)
    .where(
      and(
        eq(pendingInteractions.threadId, args.threadId),
        args.statuses && args.statuses.length > 0
          ? inArray(pendingInteractions.status, [...args.statuses])
          : undefined,
      ),
    )
    .orderBy(desc(pendingInteractions.createdAt));

  return args.limit ? query.limit(args.limit).all() : query.all();
}

export function listPendingInteractionThreadIds(
  db: PendingInteractionReadConnection,
  args: ListPendingInteractionThreadIdsArgs,
): string[] {
  if (args.threadIds.length === 0) {
    return [];
  }

  const pendingThreadIds = new Set<string>();
  for (
    let offset = 0;
    offset < args.threadIds.length;
    offset += SQLITE_IN_CLAUSE_BATCH_SIZE
  ) {
    const threadIdsBatch = args.threadIds.slice(
      offset,
      offset + SQLITE_IN_CLAUSE_BATCH_SIZE,
    );
    const rows = db
      .select({ threadId: pendingInteractions.threadId })
      .from(pendingInteractions)
      .where(
        and(
          inArray(pendingInteractions.threadId, threadIdsBatch),
          eq(pendingInteractions.status, "pending"),
        ),
      )
      .all();
    for (const row of rows) {
      pendingThreadIds.add(row.threadId);
    }
  }

  return [...pendingThreadIds];
}

export function listPendingInteractionsByStatus(
  db: PendingInteractionReadConnection,
  args: ListPendingInteractionsByStatusArgs,
): PendingInteractionRow[] {
  const query = db
    .select()
    .from(pendingInteractions)
    .where(inArray(pendingInteractions.status, [...args.statuses]))
    .orderBy(desc(pendingInteractions.createdAt));

  if (args.limit === undefined) {
    return query.all();
  }

  const limitedQuery =
    args.offset !== undefined
      ? query.limit(args.limit).offset(args.offset)
      : query.limit(args.limit);

  return limitedQuery.all();
}

export function setPendingInteractionResolved(
  db: PendingInteractionWriteConnection,
  args: {
    id: string;
    resolution: string;
  },
): PendingInteractionRow | null {
  return updatePendingInteractionTerminalState(db, {
    id: args.id,
    allowedCurrentStatuses: ["pending"],
    resolution: args.resolution,
    status: "resolved",
    statusReason: null,
  });
}

export function setPendingInteractionInterrupted(
  db: PendingInteractionWriteConnection,
  args: {
    id: string;
    statusReason: string;
  },
): PendingInteractionRow | null {
  return updatePendingInteractionTerminalState(db, {
    id: args.id,
    allowedCurrentStatuses: ["pending"],
    resolution: null,
    status: "interrupted",
    statusReason: args.statusReason,
  });
}

export function setPendingInteractionExpired(
  db: PendingInteractionWriteConnection,
  args: {
    id: string;
    statusReason: string;
  },
): PendingInteractionRow | null {
  return updatePendingInteractionTerminalState(db, {
    id: args.id,
    allowedCurrentStatuses: ["pending"],
    resolution: null,
    status: "expired",
    statusReason: args.statusReason,
  });
}

export function setPendingInteractionRejected(
  db: PendingInteractionWriteConnection,
  args: {
    id: string;
    statusReason: string;
  },
): PendingInteractionRow | null {
  return updatePendingInteractionTerminalState(db, {
    id: args.id,
    allowedCurrentStatuses: ["pending"],
    resolution: null,
    status: "rejected",
    statusReason: args.statusReason,
  });
}

export function interruptPendingInteractionsForThreads(
  db: PendingInteractionWriteConnection,
  args: InterruptPendingInteractionsForThreadsArgs,
): PendingInteractionRow[] {
  if (args.threadIds.length === 0) {
    return [];
  }

  const now = Date.now();

  return db
    .update(pendingInteractions)
    .set({
      status: "interrupted",
      statusReason: args.statusReason,
      resolvedAt: args.resolvedAt ?? now,
      updatedAt: now,
    })
    .where(
      and(
        eq(pendingInteractions.providerId, args.providerId),
        inArray(pendingInteractions.threadId, [...args.threadIds]),
        eq(pendingInteractions.status, "pending"),
      ),
    )
    .returning()
    .all();
}

export function interruptPendingInteractionsForThreadIds(
  db: PendingInteractionWriteConnection,
  args: InterruptPendingInteractionsForThreadIdsArgs,
): PendingInteractionRow[] {
  if (args.threadIds.length === 0) {
    return [];
  }

  const now = Date.now();

  return db
    .update(pendingInteractions)
    .set({
      status: "interrupted",
      statusReason: args.statusReason,
      resolvedAt: args.resolvedAt ?? now,
      updatedAt: now,
    })
    .where(
      and(
        inArray(pendingInteractions.threadId, [...args.threadIds]),
        eq(pendingInteractions.status, "pending"),
      ),
    )
    .returning()
    .all();
}
