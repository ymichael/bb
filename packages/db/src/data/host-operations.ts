import { and, eq, inArray } from "drizzle-orm";
import type {
  HostOperationKind,
  LifecycleOperationState,
} from "@bb/domain";
import { createHostOperationId } from "../ids.js";
import { hostOperations } from "../schema.js";
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

type HostOperationWriteConnection = LifecycleOperationWriteConnection;
type HostOperationReadConnection = LifecycleOperationReadConnection;

export type HostOperationRow = typeof hostOperations.$inferSelect;

export interface GetHostOperationArgs {
  hostId: string;
  kind: HostOperationKind;
}

export interface UpsertHostOperationInput {
  hostId: string;
  kind: HostOperationKind;
  payload: string;
  requestedAt?: number;
}

export interface UpdateHostOperationStateArgs {
  allowedCurrentStates?: readonly LifecycleOperationState[];
  commandId?: string | null;
  completedAt?: number | null;
  failureReason?: string | null;
  hostId: string;
  kind: HostOperationKind;
  payload?: string;
  queuedAt?: number | null;
  state: LifecycleOperationState;
}

export interface ListHostOperationsArgs {
  hostIds?: string[];
  kinds?: HostOperationKind[];
  states?: LifecycleOperationState[];
}

function getHostOperationRecord(
  db: HostOperationReadConnection,
  args: GetHostOperationArgs,
): HostOperationRow | null {
  return db
    .select()
    .from(hostOperations)
    .where(
      and(
        eq(hostOperations.hostId, args.hostId),
        eq(hostOperations.kind, args.kind),
      ),
    )
    .get() ?? null;
}

function updateHostOperationStateRecord(
  db: HostOperationWriteConnection,
  args: UpdateHostOperationStateArgs,
): HostOperationRow | null {
  return db
    .update(hostOperations)
    .set({
      state: args.state,
      payload: args.payload,
      commandId: args.commandId,
      queuedAt: args.queuedAt,
      completedAt: args.completedAt,
      failureReason: args.failureReason,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(hostOperations.hostId, args.hostId),
        eq(hostOperations.kind, args.kind),
        args.allowedCurrentStates
          ? inArray(hostOperations.state, [...args.allowedCurrentStates])
          : undefined,
      ),
    )
    .returning()
    .get() ?? null;
}

export function updateHostOperationRecord(
  db: HostOperationWriteConnection,
  args: UpdateHostOperationStateArgs,
): HostOperationRow | null {
  return updateHostOperationStateRecord(db, args);
}

const hostOperationStore: LifecycleOperationStore<
  HostOperationRow,
  GetHostOperationArgs,
  HostOperationKind,
  UpsertHostOperationInput
> = {
  get: getHostOperationRecord,
  getIdentity: (input) => ({
    hostId: input.hostId,
    kind: input.kind,
  }),
  insertRequested: (db, args) =>
    db
      .insert(hostOperations)
      .values({
        id: createHostOperationId(),
        hostId: args.input.hostId,
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
    updateHostOperationStateRecord(db, {
      hostId: args.identity.hostId,
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

export function getHostOperation(
  db: HostOperationReadConnection,
  args: GetHostOperationArgs,
): HostOperationRow | null {
  return getHostOperationRecord(db, args);
}

export function listHostOperations(
  db: HostOperationReadConnection,
  args: ListHostOperationsArgs = {},
): HostOperationRow[] {
  const filters = [
    args.hostIds && args.hostIds.length > 0
      ? inArray(hostOperations.hostId, args.hostIds)
      : undefined,
    args.kinds && args.kinds.length > 0
      ? inArray(hostOperations.kind, args.kinds)
      : undefined,
    args.states && args.states.length > 0
      ? inArray(hostOperations.state, args.states)
      : undefined,
  ].filter((value) => value !== undefined);

  return db
    .select()
    .from(hostOperations)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .all();
}

export function getHostOperationByCommandId(
  db: HostOperationReadConnection,
  commandId: string,
): HostOperationRow | null {
  return db
    .select()
    .from(hostOperations)
    .where(eq(hostOperations.commandId, commandId))
    .get() ?? null;
}

export function upsertHostOperationRecord(
  db: HostOperationWriteConnection,
  input: UpsertHostOperationInput,
): HostOperationRow {
  return upsertLifecycleOperationRecord(db, hostOperationStore, input);
}

export function markHostOperationRecordQueued(
  db: HostOperationWriteConnection,
  args: {
    commandId: string;
    hostId: string;
    kind: HostOperationKind;
    queuedAt?: number;
  },
): HostOperationRow | null {
  return markLifecycleOperationQueued(db, hostOperationStore, {
    identity: {
      hostId: args.hostId,
      kind: args.kind,
    },
    commandId: args.commandId,
    queuedAt: args.queuedAt,
  });
}

export function markHostOperationRecordFetched(
  db: HostOperationWriteConnection,
  args: GetHostOperationArgs,
): HostOperationRow | null {
  return markLifecycleOperationFetched(db, hostOperationStore, args);
}

export function markHostOperationRecordCompleted(
  db: HostOperationWriteConnection,
  args: GetHostOperationArgs & { completedAt?: number },
): HostOperationRow | null {
  return markLifecycleOperationCompleted(db, hostOperationStore, {
    identity: {
      hostId: args.hostId,
      kind: args.kind,
    },
    completedAt: args.completedAt,
  });
}

export function markHostOperationRecordFailed(
  db: HostOperationWriteConnection,
  args: GetHostOperationArgs & {
    completedAt?: number;
    failureReason: string;
  },
): HostOperationRow | null {
  return markLifecycleOperationFailed(db, hostOperationStore, {
    identity: {
      hostId: args.hostId,
      kind: args.kind,
    },
    completedAt: args.completedAt,
    failureReason: args.failureReason,
  });
}

export function cancelHostOperationRecord(
  db: HostOperationWriteConnection,
  args: GetHostOperationArgs & { completedAt?: number },
): HostOperationRow | null {
  return cancelLifecycleOperationRecord(db, hostOperationStore, {
    identity: {
      hostId: args.hostId,
      kind: args.kind,
    },
    completedAt: args.completedAt,
  });
}
