import { eq } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { projectSources } from "../schema.js";
import { createProjectSourceId } from "../ids.js";

export interface CreateProjectSourceInput {
  projectId: string;
  type: string;
  hostId: string;
  path?: string | null;
  repoUrl?: string | null;
}

export function createProjectSource(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateProjectSourceInput,
) {
  const now = Date.now();
  const id = createProjectSourceId();
  db.insert(projectSources)
    .values({
      id,
      projectId: input.projectId,
      type: input.type,
      hostId: input.hostId,
      path: input.path ?? null,
      repoUrl: input.repoUrl ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  notifier.notifyProject(input.projectId, ["sources-changed"]);
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
  db.delete(projectSources).where(eq(projectSources.id, id)).run();
  notifier.notifyProject(existing.projectId, ["sources-changed"]);
  return true;
}
