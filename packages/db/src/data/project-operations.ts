import { and, eq, inArray } from "drizzle-orm";
import type {
  LifecycleOperationState,
  ProjectOperationKind,
} from "@bb/domain";
import { createProjectOperationId } from "../ids.js";
import { projectOperations } from "../schema.js";
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

type ProjectOperationWriteConnection = LifecycleOperationWriteConnection;
type ProjectOperationReadConnection = LifecycleOperationReadConnection;

export type ProjectOperationRow = typeof projectOperations.$inferSelect;

export interface GetProjectOperationArgs {
  kind: ProjectOperationKind;
  projectId: string;
}

export interface UpsertProjectOperationInput {
  kind: ProjectOperationKind;
  payload: string;
  projectId: string;
  requestedAt?: number;
}

export interface UpdateProjectOperationStateArgs {
  allowedCurrentStates?: readonly LifecycleOperationState[];
  commandId?: string | null;
  completedAt?: number | null;
  failureReason?: string | null;
  kind: ProjectOperationKind;
  payload?: string;
  projectId: string;
  queuedAt?: number | null;
  state: LifecycleOperationState;
}

export interface ListProjectOperationsArgs {
  kind?: ProjectOperationKind;
  projectIds?: string[];
  states?: LifecycleOperationState[];
}

function getProjectOperationRecord(
  db: ProjectOperationReadConnection,
  args: GetProjectOperationArgs,
): ProjectOperationRow | null {
  return db
    .select()
    .from(projectOperations)
    .where(
      and(
        eq(projectOperations.projectId, args.projectId),
        eq(projectOperations.kind, args.kind),
      ),
    )
    .get() ?? null;
}

function updateProjectOperationStateRecord(
  db: ProjectOperationWriteConnection,
  args: UpdateProjectOperationStateArgs,
): ProjectOperationRow | null {
  const now = Date.now();

  return db
    .update(projectOperations)
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
        eq(projectOperations.projectId, args.projectId),
        eq(projectOperations.kind, args.kind),
        args.allowedCurrentStates
          ? inArray(projectOperations.state, [...args.allowedCurrentStates])
          : undefined,
      ),
    )
    .returning()
    .get() ?? null;
}

const projectOperationStore: LifecycleOperationStore<
  ProjectOperationRow,
  GetProjectOperationArgs,
  ProjectOperationKind,
  UpsertProjectOperationInput
> = {
  get: getProjectOperationRecord,
  getIdentity: (input) => ({
    projectId: input.projectId,
    kind: input.kind,
  }),
  insertRequested: (db, args) =>
    db
      .insert(projectOperations)
      .values({
        id: createProjectOperationId(),
        projectId: args.input.projectId,
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
    updateProjectOperationStateRecord(db, {
      projectId: args.identity.projectId,
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

export function getProjectOperation(
  db: ProjectOperationReadConnection,
  args: GetProjectOperationArgs,
): ProjectOperationRow | null {
  return getProjectOperationRecord(db, args);
}

export function listProjectOperations(
  db: ProjectOperationReadConnection,
  args: ListProjectOperationsArgs = {},
): ProjectOperationRow[] {
  const filters = [
    args.kind ? eq(projectOperations.kind, args.kind) : undefined,
    args.projectIds && args.projectIds.length > 0
      ? inArray(projectOperations.projectId, args.projectIds)
      : undefined,
    args.states && args.states.length > 0
      ? inArray(projectOperations.state, args.states)
      : undefined,
  ].filter((value) => value !== undefined);

  return db
    .select()
    .from(projectOperations)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .all();
}

export function getProjectOperationByCommandId(
  db: ProjectOperationReadConnection,
  commandId: string,
): ProjectOperationRow | null {
  return db
    .select()
    .from(projectOperations)
    .where(eq(projectOperations.commandId, commandId))
    .get() ?? null;
}

export function upsertProjectOperationRecord(
  db: ProjectOperationWriteConnection,
  input: UpsertProjectOperationInput,
): ProjectOperationRow {
  return upsertLifecycleOperationRecord(db, projectOperationStore, input);
}

export function markProjectOperationRecordQueued(
  db: ProjectOperationWriteConnection,
  args: {
    commandId: string;
    kind: ProjectOperationKind;
    projectId: string;
    queuedAt?: number;
  },
): ProjectOperationRow | null {
  return markLifecycleOperationQueued(db, projectOperationStore, {
    identity: {
      projectId: args.projectId,
      kind: args.kind,
    },
    commandId: args.commandId,
    queuedAt: args.queuedAt,
  });
}

export function markProjectOperationRecordFetched(
  db: ProjectOperationWriteConnection,
  args: GetProjectOperationArgs,
): ProjectOperationRow | null {
  return markLifecycleOperationFetched(db, projectOperationStore, args);
}

export function markProjectOperationRecordCompleted(
  db: ProjectOperationWriteConnection,
  args: GetProjectOperationArgs & { completedAt?: number },
): ProjectOperationRow | null {
  return markLifecycleOperationCompleted(db, projectOperationStore, {
    identity: {
      projectId: args.projectId,
      kind: args.kind,
    },
    completedAt: args.completedAt,
  });
}

export function markProjectOperationRecordFailed(
  db: ProjectOperationWriteConnection,
  args: GetProjectOperationArgs & {
    completedAt?: number;
    failureReason: string;
  },
): ProjectOperationRow | null {
  return markLifecycleOperationFailed(db, projectOperationStore, {
    identity: {
      projectId: args.projectId,
      kind: args.kind,
    },
    completedAt: args.completedAt,
    failureReason: args.failureReason,
  });
}

export function cancelProjectOperationRecord(
  db: ProjectOperationWriteConnection,
  args: GetProjectOperationArgs & { completedAt?: number },
): ProjectOperationRow | null {
  return cancelLifecycleOperationRecord(db, projectOperationStore, {
    identity: {
      projectId: args.projectId,
      kind: args.kind,
    },
    completedAt: args.completedAt,
  });
}
