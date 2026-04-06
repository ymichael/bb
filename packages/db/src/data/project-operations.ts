import { and, eq } from "drizzle-orm";
import type {
  LifecycleOperationState,
  ProjectOperationKind,
} from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import { createProjectOperationId } from "../ids.js";
import { projectOperations } from "../schema.js";

type ProjectOperationWriteConnection = DbConnection | DbTransaction;
type ProjectOperationReadConnection = DbConnection | DbTransaction;

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
  commandId?: string | null;
  completedAt?: number | null;
  failureReason?: string | null;
  kind: ProjectOperationKind;
  payload?: string;
  projectId: string;
  queuedAt?: number | null;
  state: LifecycleOperationState;
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
      ),
    )
    .returning()
    .get() ?? null;
}

export function getProjectOperation(
  db: ProjectOperationReadConnection,
  args: GetProjectOperationArgs,
): ProjectOperationRow | null {
  return getProjectOperationRecord(db, args);
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

export function upsertProjectOperation(
  db: ProjectOperationWriteConnection,
  input: UpsertProjectOperationInput,
): ProjectOperationRow {
  const now = Date.now();
  const requestedAt = input.requestedAt ?? now;
  const existing = getProjectOperationRecord(db, {
    projectId: input.projectId,
    kind: input.kind,
  });

  if (existing) {
    return updateProjectOperationStateRecord(db, {
      projectId: input.projectId,
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
    .insert(projectOperations)
    .values({
      id: createProjectOperationId(),
      projectId: input.projectId,
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

export function markProjectOperationQueued(
  db: ProjectOperationWriteConnection,
  args: {
    commandId: string;
    kind: ProjectOperationKind;
    projectId: string;
    queuedAt?: number;
  },
): ProjectOperationRow | null {
  return updateProjectOperationStateRecord(db, {
    projectId: args.projectId,
    kind: args.kind,
    state: "queued",
    commandId: args.commandId,
    queuedAt: args.queuedAt ?? Date.now(),
    completedAt: null,
    failureReason: null,
  });
}

export function markProjectOperationFetched(
  db: ProjectOperationWriteConnection,
  args: GetProjectOperationArgs,
): ProjectOperationRow | null {
  const existing = getProjectOperationRecord(db, args);
  if (!existing) {
    return null;
  }
  return updateProjectOperationStateRecord(db, {
    projectId: args.projectId,
    kind: args.kind,
    payload: existing.payload,
    state: "fetched",
    commandId: existing.commandId,
    queuedAt: existing.queuedAt,
    completedAt: null,
    failureReason: null,
  });
}

export function markProjectOperationCompleted(
  db: ProjectOperationWriteConnection,
  args: GetProjectOperationArgs & { completedAt?: number },
): ProjectOperationRow | null {
  const existing = getProjectOperationRecord(db, args);
  if (!existing) {
    return null;
  }
  return updateProjectOperationStateRecord(db, {
    projectId: args.projectId,
    kind: args.kind,
    payload: existing.payload,
    state: "completed",
    commandId: existing.commandId,
    queuedAt: existing.queuedAt,
    completedAt: args.completedAt ?? Date.now(),
    failureReason: null,
  });
}

export function markProjectOperationFailed(
  db: ProjectOperationWriteConnection,
  args: GetProjectOperationArgs & {
    completedAt?: number;
    failureReason: string;
  },
): ProjectOperationRow | null {
  const existing = getProjectOperationRecord(db, args);
  if (!existing) {
    return null;
  }
  return updateProjectOperationStateRecord(db, {
    projectId: args.projectId,
    kind: args.kind,
    payload: existing.payload,
    state: "failed",
    commandId: existing.commandId,
    queuedAt: existing.queuedAt,
    completedAt: args.completedAt ?? Date.now(),
    failureReason: args.failureReason,
  });
}

export function cancelProjectOperation(
  db: ProjectOperationWriteConnection,
  args: GetProjectOperationArgs & { completedAt?: number },
): ProjectOperationRow | null {
  const existing = getProjectOperationRecord(db, args);
  if (!existing) {
    return null;
  }
  return updateProjectOperationStateRecord(db, {
    projectId: args.projectId,
    kind: args.kind,
    payload: existing.payload,
    state: "cancelled",
    commandId: existing.commandId,
    queuedAt: existing.queuedAt,
    completedAt: args.completedAt ?? Date.now(),
    failureReason: null,
  });
}
