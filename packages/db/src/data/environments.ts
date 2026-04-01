import { and, eq } from "drizzle-orm";
import type {
  DiscoveredWorkspaceProperties,
  EnvironmentChangeKind,
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
  mergeBaseBranch?: string | null;
  status?: EnvironmentStatus;
}

export function createEnvironment(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateEnvironmentInput,
) {
  const now = Date.now();
  const id = createEnvironmentId();
  const row = db.insert(environments)
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
      mergeBaseBranch: input.mergeBaseBranch ?? null,
      workspaceProvisionType: input.workspaceProvisionType,
      status: input.status ?? "provisioning",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  notifier.notifyEnvironment(id, ["environment-created"]);
  return row;
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

interface EnvironmentUpdateColumns {
  branchName?: string | null;
  defaultBranch?: string | null;
  isGitRepo?: boolean;
  isWorktree?: boolean;
  mergeBaseBranch?: string | null;
  path?: string | null;
  status?: EnvironmentStatus;
}

export interface ApplyProvisionedEnvironmentInput extends DiscoveredWorkspaceProperties {
  status: EnvironmentStatus;
}

export interface UpdateEnvironmentMetadataInput {
  mergeBaseBranch: string | null;
}

export interface UpdateEnvironmentStatusInput {
  status: EnvironmentStatus;
}

function buildEnvironmentUpdateSet(input: EnvironmentUpdateColumns): EnvironmentUpdateColumns {
  const set: EnvironmentUpdateColumns = {};
  if ("path" in input) set.path = input.path;
  if ("status" in input) set.status = input.status;
  if ("isGitRepo" in input) set.isGitRepo = input.isGitRepo;
  if ("isWorktree" in input) set.isWorktree = input.isWorktree;
  if ("branchName" in input) set.branchName = input.branchName;
  if ("defaultBranch" in input) set.defaultBranch = input.defaultBranch;
  if ("mergeBaseBranch" in input) set.mergeBaseBranch = input.mergeBaseBranch;
  return set;
}

function getEnvironmentChangeKinds(args: {
  existing: typeof environments.$inferSelect;
  input: EnvironmentUpdateColumns;
  updated: typeof environments.$inferSelect;
}): EnvironmentChangeKind[] {
  const changes: EnvironmentChangeKind[] = [];

  if ("status" in args.input && args.updated.status !== args.existing.status) {
    changes.push("status-changed");
  }

  const metadataChanged =
    ("path" in args.input && args.updated.path !== args.existing.path) ||
    ("isGitRepo" in args.input && args.updated.isGitRepo !== args.existing.isGitRepo) ||
    ("isWorktree" in args.input && args.updated.isWorktree !== args.existing.isWorktree) ||
    ("branchName" in args.input && args.updated.branchName !== args.existing.branchName) ||
    ("defaultBranch" in args.input && args.updated.defaultBranch !== args.existing.defaultBranch) ||
    ("mergeBaseBranch" in args.input &&
      args.updated.mergeBaseBranch !== args.existing.mergeBaseBranch);

  if (metadataChanged) {
    changes.push("metadata-changed");
  }

  return changes;
}

function updateEnvironmentRecord(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  input: EnvironmentUpdateColumns,
) {
  const existing = db
    .select()
    .from(environments)
    .where(eq(environments.id, id))
    .get();
  if (!existing) return null;

  const now = Date.now();
  const set = buildEnvironmentUpdateSet(input);
  const updated = db.update(environments)
    .set({ ...set, updatedAt: now })
    .where(eq(environments.id, id))
    .returning()
    .get();

  if (!updated) {
    return null;
  }

  const changes = getEnvironmentChangeKinds({
    existing,
    input: set,
    updated,
  });
  if (changes.length > 0) {
    notifier.notifyEnvironment(id, changes);
  }

  return updated;
}

export function applyProvisionedEnvironment(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  input: ApplyProvisionedEnvironmentInput,
) {
  return updateEnvironmentRecord(db, notifier, id, {
    path: input.path,
    status: input.status,
    isGitRepo: input.isGitRepo,
    isWorktree: input.isWorktree,
    branchName: input.branchName,
    defaultBranch: input.defaultBranch,
  });
}

export function updateEnvironmentMetadata(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  input: UpdateEnvironmentMetadataInput,
) {
  return updateEnvironmentRecord(db, notifier, id, {
    mergeBaseBranch: input.mergeBaseBranch,
  });
}

export function updateEnvironmentStatus(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  input: UpdateEnvironmentStatusInput,
) {
  return updateEnvironmentRecord(db, notifier, id, {
    status: input.status,
  });
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
  notifier.notifyEnvironment(id, ["environment-deleted"]);
  return true;
}
