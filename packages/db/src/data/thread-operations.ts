import { and, eq, inArray } from "drizzle-orm";
import type {
  LifecycleOperationState,
  ThreadOperationKind,
} from "@bb/domain";
import { createThreadOperationId } from "../ids.js";
import { threadOperations } from "../schema.js";
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

type ThreadOperationWriteConnection = LifecycleOperationWriteConnection;
type ThreadOperationReadConnection = LifecycleOperationReadConnection;

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
  allowedCurrentStates?: readonly LifecycleOperationState[];
  commandId?: string | null;
  completedAt?: number | null;
  failureReason?: string | null;
  kind: ThreadOperationKind;
  payload?: string;
  queuedAt?: number | null;
  state: LifecycleOperationState;
  threadId: string;
}

export interface ListThreadOperationsArgs {
  kinds?: ThreadOperationKind[];
  states?: LifecycleOperationState[];
  threadIds?: string[];
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
        args.allowedCurrentStates
          ? inArray(threadOperations.state, [...args.allowedCurrentStates])
          : undefined,
      ),
    )
    .returning()
    .get() ?? null;
}

const threadOperationStore: LifecycleOperationStore<
  ThreadOperationRow,
  GetThreadOperationArgs,
  ThreadOperationKind,
  UpsertThreadOperationInput
> = {
  get: getThreadOperationRecord,
  getIdentity: (input) => ({
    threadId: input.threadId,
    kind: input.kind,
  }),
  insertRequested: (db, args) =>
    db
      .insert(threadOperations)
      .values({
        id: createThreadOperationId(),
        threadId: args.input.threadId,
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
    updateThreadOperationStateRecord(db, {
      threadId: args.identity.threadId,
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

export function getThreadOperation(
  db: ThreadOperationReadConnection,
  args: GetThreadOperationArgs,
): ThreadOperationRow | null {
  return getThreadOperationRecord(db, args);
}

export function listThreadOperations(
  db: ThreadOperationReadConnection,
  args: ListThreadOperationsArgs = {},
): ThreadOperationRow[] {
  const filters = [
    args.kinds && args.kinds.length > 0
      ? inArray(threadOperations.kind, args.kinds)
      : undefined,
    args.states && args.states.length > 0
      ? inArray(threadOperations.state, args.states)
      : undefined,
    args.threadIds && args.threadIds.length > 0
      ? inArray(threadOperations.threadId, args.threadIds)
      : undefined,
  ].filter((value) => value !== undefined);

  return db
    .select()
    .from(threadOperations)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .all();
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

export function upsertThreadOperationRecord(
  db: ThreadOperationWriteConnection,
  input: UpsertThreadOperationInput,
): ThreadOperationRow {
  return upsertLifecycleOperationRecord(db, threadOperationStore, input);
}

export function markThreadOperationRecordQueued(
  db: ThreadOperationWriteConnection,
  args: {
    commandId: string;
    kind: ThreadOperationKind;
    queuedAt?: number;
    threadId: string;
  },
): ThreadOperationRow | null {
  return markLifecycleOperationQueued(db, threadOperationStore, {
    identity: {
      threadId: args.threadId,
      kind: args.kind,
    },
    commandId: args.commandId,
    queuedAt: args.queuedAt,
  });
}

export function markThreadOperationRecordFetched(
  db: ThreadOperationWriteConnection,
  args: GetThreadOperationArgs,
): ThreadOperationRow | null {
  return markLifecycleOperationFetched(db, threadOperationStore, args);
}

export function markThreadOperationRecordCompleted(
  db: ThreadOperationWriteConnection,
  args: GetThreadOperationArgs & { completedAt?: number },
): ThreadOperationRow | null {
  return markLifecycleOperationCompleted(db, threadOperationStore, {
    identity: {
      threadId: args.threadId,
      kind: args.kind,
    },
    completedAt: args.completedAt,
  });
}

export function markThreadOperationRecordFailed(
  db: ThreadOperationWriteConnection,
  args: GetThreadOperationArgs & {
    completedAt?: number;
    failureReason: string;
  },
): ThreadOperationRow | null {
  return markLifecycleOperationFailed(db, threadOperationStore, {
    identity: {
      threadId: args.threadId,
      kind: args.kind,
    },
    completedAt: args.completedAt,
    failureReason: args.failureReason,
  });
}

export function cancelThreadOperationRecord(
  db: ThreadOperationWriteConnection,
  args: GetThreadOperationArgs & { completedAt?: number },
): ThreadOperationRow | null {
  return cancelLifecycleOperationRecord(db, threadOperationStore, {
    identity: {
      threadId: args.threadId,
      kind: args.kind,
    },
    completedAt: args.completedAt,
  });
}
