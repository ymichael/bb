import { and, eq, inArray } from "drizzle-orm";
import type {
  EnvironmentOperationKind,
  LifecycleOperationState,
} from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import { createEnvironmentOperationId } from "../ids.js";
import { environmentOperations } from "../schema.js";

type EnvironmentOperationWriteConnection = DbConnection | DbTransaction;
type EnvironmentOperationReadConnection = DbConnection | DbTransaction;

export type EnvironmentOperationRow = typeof environmentOperations.$inferSelect;

export interface GetEnvironmentOperationArgs {
  environmentId: string;
  kind: EnvironmentOperationKind;
}

export interface UpsertEnvironmentOperationInput {
  environmentId: string;
  kind: EnvironmentOperationKind;
  payload: string;
  requestedAt?: number;
}

export interface UpdateEnvironmentOperationStateArgs {
  completedAt?: number | null;
  commandId?: string | null;
  environmentId: string;
  failureReason?: string | null;
  kind: EnvironmentOperationKind;
  payload?: string;
  queuedAt?: number | null;
  state: LifecycleOperationState;
}

export interface ListEnvironmentOperationsArgs {
  environmentIds?: string[];
  kinds?: EnvironmentOperationKind[];
  states?: LifecycleOperationState[];
}

function getEnvironmentOperationRecord(
  db: EnvironmentOperationReadConnection,
  args: GetEnvironmentOperationArgs,
): EnvironmentOperationRow | null {
  return db
    .select()
    .from(environmentOperations)
    .where(
      and(
        eq(environmentOperations.environmentId, args.environmentId),
        eq(environmentOperations.kind, args.kind),
      ),
    )
    .get() ?? null;
}

function updateEnvironmentOperationStateRecord(
  db: EnvironmentOperationWriteConnection,
  args: UpdateEnvironmentOperationStateArgs,
): EnvironmentOperationRow | null {
  const now = Date.now();
  const set = {
    state: args.state,
    payload: args.payload,
    commandId: args.commandId,
    queuedAt: args.queuedAt,
    completedAt: args.completedAt,
    failureReason: args.failureReason,
    updatedAt: now,
  };

  return db
    .update(environmentOperations)
    .set(set)
    .where(
      and(
        eq(environmentOperations.environmentId, args.environmentId),
        eq(environmentOperations.kind, args.kind),
      ),
    )
    .returning()
    .get() ?? null;
}

export function getEnvironmentOperation(
  db: EnvironmentOperationReadConnection,
  args: GetEnvironmentOperationArgs,
): EnvironmentOperationRow | null {
  return getEnvironmentOperationRecord(db, args);
}

export function listEnvironmentOperations(
  db: EnvironmentOperationReadConnection,
  args: ListEnvironmentOperationsArgs = {},
): EnvironmentOperationRow[] {
  const filters = [
    args.environmentIds && args.environmentIds.length > 0
      ? inArray(environmentOperations.environmentId, args.environmentIds)
      : undefined,
    args.kinds && args.kinds.length > 0
      ? inArray(environmentOperations.kind, args.kinds)
      : undefined,
    args.states && args.states.length > 0
      ? inArray(environmentOperations.state, args.states)
      : undefined,
  ].filter((value) => value !== undefined);

  return db
    .select()
    .from(environmentOperations)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .all();
}

export function getEnvironmentOperationByCommandId(
  db: EnvironmentOperationReadConnection,
  commandId: string,
): EnvironmentOperationRow | null {
  return db
    .select()
    .from(environmentOperations)
    .where(eq(environmentOperations.commandId, commandId))
    .get() ?? null;
}

export function upsertEnvironmentOperation(
  db: EnvironmentOperationWriteConnection,
  input: UpsertEnvironmentOperationInput,
): EnvironmentOperationRow {
  const now = Date.now();
  const requestedAt = input.requestedAt ?? now;
  const existing = getEnvironmentOperationRecord(db, {
    environmentId: input.environmentId,
    kind: input.kind,
  });

  if (existing) {
    return updateEnvironmentOperationStateRecord(db, {
      environmentId: input.environmentId,
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
    .insert(environmentOperations)
    .values({
      id: createEnvironmentOperationId(),
      environmentId: input.environmentId,
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

export function markEnvironmentOperationQueued(
  db: EnvironmentOperationWriteConnection,
  args: {
    commandId: string;
    environmentId: string;
    kind: EnvironmentOperationKind;
    queuedAt?: number;
  },
): EnvironmentOperationRow | null {
  return updateEnvironmentOperationStateRecord(db, {
    environmentId: args.environmentId,
    kind: args.kind,
    state: "queued",
    commandId: args.commandId,
    queuedAt: args.queuedAt ?? Date.now(),
    completedAt: null,
    failureReason: null,
  });
}

export function markEnvironmentOperationFetched(
  db: EnvironmentOperationWriteConnection,
  args: GetEnvironmentOperationArgs,
): EnvironmentOperationRow | null {
  const existing = getEnvironmentOperationRecord(db, args);
  if (!existing) {
    return null;
  }
  return updateEnvironmentOperationStateRecord(db, {
    environmentId: args.environmentId,
    kind: args.kind,
    payload: existing.payload,
    state: "fetched",
    commandId: existing.commandId,
    queuedAt: existing.queuedAt,
    completedAt: null,
    failureReason: null,
  });
}

export function markEnvironmentOperationCompleted(
  db: EnvironmentOperationWriteConnection,
  args: GetEnvironmentOperationArgs & { completedAt?: number },
): EnvironmentOperationRow | null {
  const existing = getEnvironmentOperationRecord(db, args);
  if (!existing) {
    return null;
  }
  return updateEnvironmentOperationStateRecord(db, {
    environmentId: args.environmentId,
    kind: args.kind,
    payload: existing.payload,
    state: "completed",
    commandId: existing.commandId,
    queuedAt: existing.queuedAt,
    completedAt: args.completedAt ?? Date.now(),
    failureReason: null,
  });
}

export function markEnvironmentOperationFailed(
  db: EnvironmentOperationWriteConnection,
  args: GetEnvironmentOperationArgs & {
    completedAt?: number;
    failureReason: string;
  },
): EnvironmentOperationRow | null {
  const existing = getEnvironmentOperationRecord(db, args);
  if (!existing) {
    return null;
  }
  return updateEnvironmentOperationStateRecord(db, {
    environmentId: args.environmentId,
    kind: args.kind,
    payload: existing.payload,
    state: "failed",
    commandId: existing.commandId,
    queuedAt: existing.queuedAt,
    completedAt: args.completedAt ?? Date.now(),
    failureReason: args.failureReason,
  });
}

export function cancelEnvironmentOperation(
  db: EnvironmentOperationWriteConnection,
  args: GetEnvironmentOperationArgs & { completedAt?: number },
): EnvironmentOperationRow | null {
  const existing = getEnvironmentOperationRecord(db, args);
  if (!existing) {
    return null;
  }
  return updateEnvironmentOperationStateRecord(db, {
    environmentId: args.environmentId,
    kind: args.kind,
    payload: existing.payload,
    state: "cancelled",
    commandId: existing.commandId,
    queuedAt: existing.queuedAt,
    completedAt: args.completedAt ?? Date.now(),
    failureReason: null,
  });
}
