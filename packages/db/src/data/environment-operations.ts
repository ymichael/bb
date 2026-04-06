import { and, eq, inArray } from "drizzle-orm";
import type {
  EnvironmentOperationKind,
  LifecycleOperationState,
} from "@bb/domain";
import { createEnvironmentOperationId } from "../ids.js";
import { environmentOperations } from "../schema.js";
import {
  cancelLifecycleOperationRecord,
  type LifecycleOperationReadConnection,
  type LifecycleOperationStore,
  type LifecycleOperationWriteConnection,
  markLifecycleOperationCompleted,
  markLifecycleOperationFailed,
  markLifecycleOperationFetched,
  markLifecycleOperationQueued,
  upsertLifecycleOperationRecord,
} from "./lifecycle-operation-helpers.js";

type EnvironmentOperationWriteConnection = LifecycleOperationWriteConnection;
type EnvironmentOperationReadConnection = LifecycleOperationReadConnection;

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
  allowedCurrentStates?: readonly LifecycleOperationState[];
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
        args.allowedCurrentStates
          ? inArray(environmentOperations.state, [...args.allowedCurrentStates])
          : undefined,
      ),
    )
    .returning()
    .get() ?? null;
}

const environmentOperationStore: LifecycleOperationStore<
  EnvironmentOperationRow,
  GetEnvironmentOperationArgs,
  EnvironmentOperationKind,
  UpsertEnvironmentOperationInput
> = {
  get: getEnvironmentOperationRecord,
  getIdentity: (input) => ({
    environmentId: input.environmentId,
    kind: input.kind,
  }),
  insertRequested: (db, args) =>
    db
      .insert(environmentOperations)
      .values({
        id: createEnvironmentOperationId(),
        environmentId: args.input.environmentId,
        kind: args.input.kind,
        state: "requested",
        payload: args.input.payload,
        commandId: null,
        requestedAt: args.requestedAt,
        queuedAt: null,
        completedAt: null,
        failureReason: null,
        createdAt: args.now,
        updatedAt: args.now,
      })
      .returning()
      .get(),
  updateState: (db, args) =>
    updateEnvironmentOperationStateRecord(db, {
      environmentId: args.identity.environmentId,
      kind: args.identity.kind,
      allowedCurrentStates: args.allowedCurrentStates,
      payload: args.payload,
      state: args.state,
      commandId: args.commandId,
      queuedAt: args.queuedAt,
      completedAt: args.completedAt,
      failureReason: args.failureReason,
    }),
};

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

export function upsertEnvironmentOperationRecord(
  db: EnvironmentOperationWriteConnection,
  input: UpsertEnvironmentOperationInput,
): EnvironmentOperationRow {
  return upsertLifecycleOperationRecord(db, environmentOperationStore, input);
}

export function markEnvironmentOperationRecordQueued(
  db: EnvironmentOperationWriteConnection,
  args: {
    commandId: string;
    environmentId: string;
    kind: EnvironmentOperationKind;
    queuedAt?: number;
  },
): EnvironmentOperationRow | null {
  return markLifecycleOperationQueued(db, environmentOperationStore, {
    identity: {
      environmentId: args.environmentId,
      kind: args.kind,
    },
    commandId: args.commandId,
    queuedAt: args.queuedAt,
  });
}

export function markEnvironmentOperationRecordFetched(
  db: EnvironmentOperationWriteConnection,
  args: GetEnvironmentOperationArgs,
): EnvironmentOperationRow | null {
  return markLifecycleOperationFetched(db, environmentOperationStore, args);
}

export function markEnvironmentOperationRecordCompleted(
  db: EnvironmentOperationWriteConnection,
  args: GetEnvironmentOperationArgs & { completedAt?: number },
): EnvironmentOperationRow | null {
  return markLifecycleOperationCompleted(db, environmentOperationStore, {
    identity: {
      environmentId: args.environmentId,
      kind: args.kind,
    },
    completedAt: args.completedAt,
  });
}

export function markEnvironmentOperationRecordFailed(
  db: EnvironmentOperationWriteConnection,
  args: GetEnvironmentOperationArgs & {
    completedAt?: number;
    failureReason: string;
  },
): EnvironmentOperationRow | null {
  return markLifecycleOperationFailed(db, environmentOperationStore, {
    identity: {
      environmentId: args.environmentId,
      kind: args.kind,
    },
    completedAt: args.completedAt,
    failureReason: args.failureReason,
  });
}

export function cancelEnvironmentOperationRecord(
  db: EnvironmentOperationWriteConnection,
  args: GetEnvironmentOperationArgs & { completedAt?: number },
): EnvironmentOperationRow | null {
  return cancelLifecycleOperationRecord(db, environmentOperationStore, {
    identity: {
      environmentId: args.environmentId,
      kind: args.kind,
    },
    completedAt: args.completedAt,
  });
}
