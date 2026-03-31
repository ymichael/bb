import { and, eq, ne } from "drizzle-orm";
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

export interface CreateGitHubRepoProjectSourceInput {
  projectId: string;
  type: "github_repo";
  repoUrl: string;
  isDefault?: boolean;
}
export type CreateProjectSourceInput =
  | CreateLocalPathProjectSourceInput
  | CreateGitHubRepoProjectSourceInput;

export function toProjectSource(row: ProjectSourceRow): ProjectSource {
  switch (row.type) {
    case "local_path":
      if (!row.hostId || !row.path || row.repoUrl) {
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
    case "github_repo":
      if (row.hostId || row.path || !row.repoUrl) {
        throw new Error(`Invalid github_repo project source row: ${row.id}`);
      }
      return {
        id: row.id,
        projectId: row.projectId,
        type: "github_repo",
        repoUrl: row.repoUrl,
        isDefault: row.isDefault,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    default: {
      const _exhaustive: never = row.type;
      return _exhaustive;
    }
  }
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

  const row = db.insert(projectSources)
    .values({
      id,
      projectId: input.projectId,
      type: input.type,
      hostId: input.type === "local_path" ? input.hostId : null,
      path: input.type === "local_path" ? input.path : null,
      repoUrl: input.type === "github_repo" ? input.repoUrl : null,
      isDefault: shouldBeDefault,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
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

export interface UpdateLocalPathProjectSourceInput {
  path?: string;
  repoUrl?: never;
  isDefault?: true;
}

export interface UpdateGitHubRepoProjectSourceInput {
  path?: never;
  repoUrl?: string;
  isDefault?: true;
}
export type UpdateProjectSourceInput =
  | UpdateLocalPathProjectSourceInput
  | UpdateGitHubRepoProjectSourceInput;

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
  const updated = db.update(projectSources)
    .set({
      ...rest,
      ...(input.isDefault ? { isDefault: true } : {}),
      updatedAt: now,
    })
    .where(eq(projectSources.id, id))
    .returning()
    .get();

  notifier.notifyProject(existing.projectId, ["project-sources-changed"]);
  return updated ? toProjectSource(updated) : null;
}

export function getProjectSourceByHost(
  db: DbConnection,
  projectId: string,
  hostId: string,
) {
  const source = (
    db
      .select()
      .from(projectSources)
      .where(
        and(
          eq(projectSources.projectId, projectId),
          eq(projectSources.hostId, hostId),
        ),
      )
      .get() ?? null
  );
  return source ? toProjectSource(source) : null;
}

export function getDefaultProjectSource(db: DbConnection, projectId: string) {
  const source = (
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
  return source ? toProjectSource(source) : null;
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
