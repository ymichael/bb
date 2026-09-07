import { and, count, eq, inArray, ne } from "drizzle-orm";
import type { ProjectSource } from "@bb/domain";
import type { DbConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { projectSources } from "../schema.js";
import { createProjectSourceId } from "../ids.js";

type ProjectSourceRow = typeof projectSources.$inferSelect;

export interface CreateLocalPathProjectSourceInput {
  projectId: string;
  type: "local_path";
  hostId: string;
  path: string;
  isDefault?: boolean;
}

export type CreateProjectSourceInput = CreateLocalPathProjectSourceInput;

export function toProjectSource(row: ProjectSourceRow): ProjectSource {
  if (!row.hostId || !row.path) {
    throw new Error(`Invalid local_path project source row: ${row.id}`);
  }
  return {
    id: row.id,
    projectId: row.projectId,
    type: "local_path",
    hostId: row.hostId,
    path: row.path,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createProjectSource(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateProjectSourceInput,
) {
  const row = db.transaction((tx) => {
    const now = Date.now();
    const id = createProjectSourceId();
    const existingSources = tx
      .select({ id: projectSources.id })
      .from(projectSources)
      .where(eq(projectSources.projectId, input.projectId))
      .all();
    const shouldBeDefault =
      input.isDefault === true || existingSources.length === 0;

    if (shouldBeDefault) {
      tx.update(projectSources)
        .set({ isDefault: false, updatedAt: now })
        .where(eq(projectSources.projectId, input.projectId))
        .run();
    }

    return tx
      .insert(projectSources)
      .values({
        id,
        projectId: input.projectId,
        type: input.type,
        hostId: input.hostId,
        path: input.path,
        isDefault: shouldBeDefault,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  });
  notifier.notifyProject(input.projectId, ["project-sources-changed"]);
  return toProjectSource(row);
}

export function listProjectSources(db: DbConnection, projectId: string) {
  return db
    .select()
    .from(projectSources)
    .where(eq(projectSources.projectId, projectId))
    .all()
    .map(toProjectSource);
}

export function listProjectSourcesByProjectIds(
  db: DbConnection,
  projectIds: readonly string[],
) {
  if (projectIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(projectSources)
    .where(inArray(projectSources.projectId, [...projectIds]))
    .all()
    .map(toProjectSource);
}

export function listProjectSourcesByHost(
  db: DbConnection,
  hostId: string,
) {
  return db
    .select()
    .from(projectSources)
    .where(eq(projectSources.hostId, hostId))
    .all()
    .map(toProjectSource);
}

export interface GetProjectSourceForProjectArgs {
  projectId: string;
  sourceId: string;
}

export function getProjectSourceForProject(
  db: DbConnection,
  args: GetProjectSourceForProjectArgs,
) {
  const source = db
    .select()
    .from(projectSources)
    .where(
      and(
        eq(projectSources.id, args.sourceId),
        eq(projectSources.projectId, args.projectId),
      ),
    )
    .get();

  return source ? toProjectSource(source) : null;
}

export interface CountProjectSourcesArgs {
  projectId: string;
}

export function countProjectSources(
  db: DbConnection,
  args: CountProjectSourcesArgs,
): number {
  const row = db
    .select({ count: count() })
    .from(projectSources)
    .where(eq(projectSources.projectId, args.projectId))
    .get();

  return row?.count ?? 0;
}

export interface UpdateLocalPathProjectSourceInput {
  path?: string;
  isDefault?: true;
}

export type UpdateProjectSourceInput = UpdateLocalPathProjectSourceInput;

export function updateProjectSource(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  input: UpdateProjectSourceInput,
) {
  const updated = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(projectSources)
      .where(eq(projectSources.id, id))
      .get();
    if (!existing) {
      return null;
    }

    const now = Date.now();
    if (input.isDefault) {
      tx.update(projectSources)
        .set({ isDefault: false, updatedAt: now })
        .where(eq(projectSources.projectId, existing.projectId))
        .run();
    }
    const { isDefault: _isDefault, ...rest } = input;
    const updatedRow =
      tx
        .update(projectSources)
        .set({
          ...rest,
          ...(input.isDefault ? { isDefault: true } : {}),
          updatedAt: now,
        })
        .where(eq(projectSources.id, id))
        .returning()
        .get() ?? null;

    return updatedRow
      ? { projectId: existing.projectId, row: updatedRow }
      : null;
  });
  if (!updated) {
    return null;
  }

  notifier.notifyProject(updated.projectId, ["project-sources-changed"]);
  return toProjectSource(updated.row);
}

export function getProjectSourceByHost(
  db: DbConnection,
  projectId: string,
  hostId: string,
) {
  const source =
    db
      .select()
      .from(projectSources)
      .where(
        and(
          eq(projectSources.projectId, projectId),
          eq(projectSources.hostId, hostId),
        ),
      )
      .get() ?? null;
  return source ? toProjectSource(source) : null;
}

export function getDefaultProjectSource(db: DbConnection, projectId: string) {
  const source =
    db
      .select()
      .from(projectSources)
      .where(
        and(
          eq(projectSources.projectId, projectId),
          eq(projectSources.isDefault, true),
        ),
      )
      .get() ?? null;
  return source ? toProjectSource(source) : null;
}

export function deleteProjectSource(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
) {
  const deleted = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(projectSources)
      .where(eq(projectSources.id, id))
      .get();
    if (!existing) {
      return null;
    }

    const now = Date.now();
    tx.delete(projectSources).where(eq(projectSources.id, id)).run();
    if (existing.isDefault) {
      const replacement =
        tx
          .select()
          .from(projectSources)
          .where(eq(projectSources.projectId, existing.projectId))
          .get() ?? null;
      if (replacement) {
        tx.update(projectSources)
          .set({ isDefault: true, updatedAt: now })
          .where(
            and(
              eq(projectSources.id, replacement.id),
              ne(projectSources.id, id),
            ),
          )
          .run();
      }
    }
    return existing.projectId;
  });
  if (!deleted) {
    return false;
  }

  notifier.notifyProject(deleted, ["project-sources-changed"]);
  return true;
}
