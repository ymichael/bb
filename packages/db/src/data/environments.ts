import { and, eq } from "drizzle-orm";
import type {
  EnvironmentStatus,
  WorkspaceProvisionType,
} from "@bb/domain";
import type { DbConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { environments } from "../schema.js";
import { createEnvironmentId } from "../ids.js";

export interface CreateEnvironmentInput {
  projectId: string;
  hostId: string;
  workspaceProvisionType: WorkspaceProvisionType;
  path?: string | null;
  managed?: boolean;
  isGitRepo?: boolean;
  isWorktree?: boolean;
  branchName?: string | null;
  defaultBranch?: string | null;
  status?: EnvironmentStatus;
}

export function createEnvironment(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateEnvironmentInput,
) {
  const now = Date.now();
  const id = createEnvironmentId();
  db.insert(environments)
    .values({
      id,
      projectId: input.projectId,
      hostId: input.hostId,
      path: input.path ?? null,
      managed: input.managed ?? false,
      isGitRepo: input.isGitRepo ?? false,
      isWorktree: input.isWorktree ?? false,
      branchName: input.branchName ?? null,
      defaultBranch: input.defaultBranch ?? null,
      workspaceProvisionType: input.workspaceProvisionType,
      status: input.status ?? "provisioning",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  notifier.notifySystem(["environment-created"]);
  return db
    .select()
    .from(environments)
    .where(eq(environments.id, id))
    .get()!;
}

export function getEnvironment(db: DbConnection, id: string) {
  return (
    db.select().from(environments).where(eq(environments.id, id)).get() ?? null
  );
}

export function findEnvironmentByHostPath(
  db: DbConnection,
  hostId: string,
  path: string,
) {
  return (
    db
      .select()
      .from(environments)
      .where(and(eq(environments.hostId, hostId), eq(environments.path, path)))
      .get() ?? null
  );
}

export function listEnvironments(db: DbConnection, projectId?: string) {
  if (projectId) {
    return db
      .select()
      .from(environments)
      .where(eq(environments.projectId, projectId))
      .all();
  }
  return db.select().from(environments).all();
}

export interface UpdateEnvironmentInput {
  path?: string | null;
  status?: EnvironmentStatus;
  isGitRepo?: boolean;
  isWorktree?: boolean;
  branchName?: string | null;
  defaultBranch?: string | null;
}

export function updateEnvironment(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  input: UpdateEnvironmentInput,
) {
  const existing = db
    .select()
    .from(environments)
    .where(eq(environments.id, id))
    .get();
  if (!existing) return null;

  const now = Date.now();
  db.update(environments)
    .set({ ...input, updatedAt: now })
    .where(eq(environments.id, id))
    .run();
  const updated = db
    .select()
    .from(environments)
    .where(eq(environments.id, id))
    .get();

  if (updated && input.status && input.status !== existing.status) {
    notifier.notifyEnvironment(id, ["status-changed"]);
  }

  return updated ?? null;
}

export function deleteEnvironment(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
) {
  const existing = db
    .select()
    .from(environments)
    .where(eq(environments.id, id))
    .get();
  if (!existing) return false;
  db.delete(environments).where(eq(environments.id, id)).run();
  notifier.notifySystem(["environment-deleted"]);
  return true;
}
