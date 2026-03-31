import { eq } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { projects, projectSources } from "../schema.js";
import { createProjectId, createProjectSourceId } from "../ids.js";
import {
  toProjectSource,
} from "./project-sources.js";

export interface CreateProjectLocalPathSourceInput {
  type: "local_path";
  hostId: string;
  path: string;
}

export interface CreateProjectGitHubRepoSourceInput {
  type: "github_repo";
  repoUrl: string;
}
export type CreateProjectSourceInput =
  | CreateProjectLocalPathSourceInput
  | CreateProjectGitHubRepoSourceInput;

export interface CreateProjectInput {
  name: string;
  source: CreateProjectSourceInput;
}

export function createProject(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateProjectInput,
) {
  const now = Date.now();
  const projectId = createProjectId();
  const sourceId = createProjectSourceId();

  const { project, source } = db.transaction((tx) => {
    const p = tx
      .insert(projects)
      .values({
        id: projectId,
        name: input.name,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    const s = tx
      .insert(projectSources)
      .values({
        id: sourceId,
        projectId,
        type: input.source.type,
        hostId: input.source.type === "local_path" ? input.source.hostId : null,
        path: input.source.type === "local_path" ? input.source.path : null,
        repoUrl: input.source.type === "github_repo" ? input.source.repoUrl : null,
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return { project: p, source: s };
  });

  notifier.notifyProject(projectId, ["project-created"]);
  notifier.notifyProject(projectId, ["project-sources-changed"]);
  return { project, source: toProjectSource(source) };
}

export function getProject(db: DbConnection, id: string) {
  return db.select().from(projects).where(eq(projects.id, id)).get() ?? null;
}

export function listProjects(db: DbConnection) {
  return db.select().from(projects).all();
}

export interface UpdateProjectInput {
  name?: string;
}

export function updateProject(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  input: UpdateProjectInput,
) {
  const now = Date.now();
  const updated = db.update(projects)
    .set({ ...input, updatedAt: now })
    .where(eq(projects.id, id))
    .returning()
    .get();
  if (updated) {
    notifier.notifyProject(id, ["project-updated"]);
  }
  return updated ?? null;
}

export function deleteProject(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
) {
  const existing = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!existing) return false;
  db.delete(projects).where(eq(projects.id, id)).run();
  notifier.notifyProject(id, ["project-deleted"]);
  return true;
}
