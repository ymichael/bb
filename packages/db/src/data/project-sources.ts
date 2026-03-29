import { and, eq, ne } from "drizzle-orm";
import type { ProjectSourceType } from "@bb/domain";
import type { DbConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { projectSources } from "../schema.js";
import { createProjectSourceId } from "../ids.js";

export interface CreateProjectSourceInput {
  projectId: string;
  type: ProjectSourceType;
  hostId: string;
  path?: string | null;
  repoUrl?: string | null;
  isDefault?: boolean;
}

export function createProjectSource(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateProjectSourceInput,
) {
  const now = Date.now();
  const id = createProjectSourceId();
  const existingSources = db
    .select({ id: projectSources.id })
    .from(projectSources)
    .where(eq(projectSources.projectId, input.projectId))
    .all();
  const shouldBeDefault =
    input.isDefault === true || existingSources.length === 0;

  if (shouldBeDefault) {
    db.update(projectSources)
      .set({ isDefault: false, updatedAt: now })
      .where(eq(projectSources.projectId, input.projectId))
      .run();
  }

  db.insert(projectSources)
    .values({
      id,
      projectId: input.projectId,
      type: input.type,
      hostId: input.hostId,
      path: input.path ?? null,
      repoUrl: input.repoUrl ?? null,
      isDefault: shouldBeDefault,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  notifier.notifyProject(input.projectId, ["project-sources-changed"]);
  return db
    .select()
    .from(projectSources)
    .where(eq(projectSources.id, id))
    .get()!;
}

export function listProjectSources(db: DbConnection, projectId: string) {
  return db
    .select()
    .from(projectSources)
    .where(eq(projectSources.projectId, projectId))
    .all();
}

export interface UpdateProjectSourceInput {
  path?: string | null;
  repoUrl?: string | null;
  isDefault?: true;
}

export function updateProjectSource(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  input: UpdateProjectSourceInput,
) {
  const existing = db
    .select()
    .from(projectSources)
    .where(eq(projectSources.id, id))
    .get();
  if (!existing) return null;

  const now = Date.now();
  if (input.isDefault) {
    db.update(projectSources)
      .set({ isDefault: false, updatedAt: now })
      .where(eq(projectSources.projectId, existing.projectId))
      .run();
  }
  const { isDefault: _isDefault, ...rest } = input;
  db.update(projectSources)
    .set({
      ...rest,
      ...(input.isDefault ? { isDefault: true } : {}),
      updatedAt: now,
    })
    .where(eq(projectSources.id, id))
    .run();

  notifier.notifyProject(existing.projectId, ["project-sources-changed"]);
  return (
    db
      .select()
      .from(projectSources)
      .where(eq(projectSources.id, id))
      .get() ?? null
  );
}

export function getDefaultProjectSource(db: DbConnection, projectId: string) {
  return (
    db
      .select()
      .from(projectSources)
      .where(
        and(
          eq(projectSources.projectId, projectId),
          eq(projectSources.isDefault, true),
        ),
      )
      .get() ?? null
  );
}

export function deleteProjectSource(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
) {
  const existing = db
    .select()
    .from(projectSources)
    .where(eq(projectSources.id, id))
    .get();
  if (!existing) return false;
  const now = Date.now();
  db.delete(projectSources).where(eq(projectSources.id, id)).run();
  if (existing.isDefault) {
    const replacement = db
      .select()
      .from(projectSources)
      .where(eq(projectSources.projectId, existing.projectId))
      .get();
    if (replacement) {
      db.update(projectSources)
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
  notifier.notifyProject(existing.projectId, ["project-sources-changed"]);
  return true;
}
