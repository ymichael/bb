import { eq } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { projects } from "../schema.js";
import { createProjectId } from "../ids.js";

export interface CreateProjectInput {
  name: string;
}

export function createProject(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateProjectInput,
) {
  const now = Date.now();
  const id = createProjectId();
  db.insert(projects)
    .values({
      id,
      name: input.name,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  notifier.notifyProject(id, ["project-created"]);
  return db.select().from(projects).where(eq(projects.id, id)).get()!;
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
  db.update(projects)
    .set({ ...input, updatedAt: now })
    .where(eq(projects.id, id))
    .run();
  const updated = db.select().from(projects).where(eq(projects.id, id)).get();
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
