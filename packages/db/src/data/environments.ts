import { and, eq, inArray } from "drizzle-orm";
import type {
  DiscoveredWorkspaceProperties,
  EnvironmentChangeKind,
  EnvironmentCleanupMode,
  EnvironmentStatus,
  WorkspaceProvisionType,
} from "@bb/domain";
import type { DbConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { environments } from "../schema.js";
import { createEnvironmentId } from "../ids.js";

export interface CreateEnvironmentInput {
  cleanupMode?: EnvironmentCleanupMode | null;
  cleanupRequestedAt?: number | null;
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
      cleanupRequestedAt: input.cleanupRequestedAt ?? null,
      cleanupMode: input.cleanupMode ?? null,
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

export function listEnvironmentsByIds(
  db: DbConnection,
  environmentIds: readonly string[],
) {
  if (environmentIds.length === 0) {
    return [];
  }

  return db.select()
    .from(environments)
    .where(inArray(environments.id, [...environmentIds]))
    .all();
}

interface EnvironmentMetadataUpdateColumns {
  branchName?: string | null;
  defaultBranch?: string | null;
  isGitRepo?: boolean;
  isWorktree?: boolean;
  mergeBaseBranch?: string | null;
  path?: string | null;
}

interface EnvironmentLifecycleUpdateColumns {
  cleanupMode?: EnvironmentCleanupMode | null;
  cleanupRequestedAt?: number | null;
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

export interface RequestEnvironmentCleanupInput {
  cleanupMode: EnvironmentCleanupMode;
  requestedAt?: number;
}

export interface ClaimManagedEnvironmentReprovisionArgs {
  environmentId: string;
  now?: number;
}

function buildEnvironmentMetadataUpdateSet(
  input: EnvironmentMetadataUpdateColumns,
): EnvironmentMetadataUpdateColumns {
  const set: EnvironmentMetadataUpdateColumns = {};
  if ("path" in input) set.path = input.path;
  if ("isGitRepo" in input) set.isGitRepo = input.isGitRepo;
  if ("isWorktree" in input) set.isWorktree = input.isWorktree;
  if ("branchName" in input) set.branchName = input.branchName;
  if ("defaultBranch" in input) set.defaultBranch = input.defaultBranch;
  if ("mergeBaseBranch" in input) set.mergeBaseBranch = input.mergeBaseBranch;
  return set;
}

function buildEnvironmentLifecycleUpdateSet(
  input: EnvironmentLifecycleUpdateColumns,
): EnvironmentLifecycleUpdateColumns {
  const set: EnvironmentLifecycleUpdateColumns = {};
  if ("status" in input) set.status = input.status;
  if ("cleanupRequestedAt" in input) {
    set.cleanupRequestedAt = input.cleanupRequestedAt;
  }
  if ("cleanupMode" in input) set.cleanupMode = input.cleanupMode;
  return set;
}

function buildEnvironmentChangeKinds(args: {
  existing: typeof environments.$inferSelect;
  lifecycle: EnvironmentLifecycleUpdateColumns;
  metadata: EnvironmentMetadataUpdateColumns;
  updated: typeof environments.$inferSelect;
}): EnvironmentChangeKind[] {
  const changes: EnvironmentChangeKind[] = [];

  if (
    "status" in args.lifecycle &&
    args.updated.status !== args.existing.status
  ) {
    changes.push("status-changed");
  }

  const metadataChanged =
    ("path" in args.metadata && args.updated.path !== args.existing.path) ||
    ("isGitRepo" in args.metadata &&
      args.updated.isGitRepo !== args.existing.isGitRepo) ||
    ("isWorktree" in args.metadata &&
      args.updated.isWorktree !== args.existing.isWorktree) ||
    ("branchName" in args.metadata &&
      args.updated.branchName !== args.existing.branchName) ||
    ("defaultBranch" in args.metadata &&
      args.updated.defaultBranch !== args.existing.defaultBranch) ||
    ("mergeBaseBranch" in args.metadata &&
      args.updated.mergeBaseBranch !== args.existing.mergeBaseBranch) ||
    ("cleanupRequestedAt" in args.lifecycle &&
      args.updated.cleanupRequestedAt !== args.existing.cleanupRequestedAt) ||
    ("cleanupMode" in args.lifecycle &&
      args.updated.cleanupMode !== args.existing.cleanupMode);

  if (metadataChanged) {
    changes.push("metadata-changed");
  }

  return changes;
}

function updateEnvironmentRecord(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  args: {
    lifecycle?: EnvironmentLifecycleUpdateColumns;
    metadata?: EnvironmentMetadataUpdateColumns;
  },
) {
  const existing = db
    .select()
    .from(environments)
    .where(eq(environments.id, id))
    .get();
  if (!existing) return null;

  const now = Date.now();
  const metadata = buildEnvironmentMetadataUpdateSet(args.metadata ?? {});
  const lifecycle = buildEnvironmentLifecycleUpdateSet(args.lifecycle ?? {});
  const updated = db.update(environments)
    .set({ ...metadata, ...lifecycle, updatedAt: now })
    .where(eq(environments.id, id))
    .returning()
    .get();

  if (!updated) {
    return null;
  }

  const changes = buildEnvironmentChangeKinds({
    existing,
    lifecycle,
    metadata,
    updated,
  });
  if (changes.length > 0) {
    notifier.notifyEnvironment(id, changes);
  }

  return updated;
}

function updateEnvironmentMetadataRecord(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  metadata: EnvironmentMetadataUpdateColumns,
) {
  return updateEnvironmentRecord(db, notifier, id, { metadata });
}

function updateEnvironmentLifecycleRecord(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  lifecycle: EnvironmentLifecycleUpdateColumns,
) {
  return updateEnvironmentRecord(db, notifier, id, { lifecycle });
}

export function applyProvisionedEnvironmentRecord(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  input: ApplyProvisionedEnvironmentInput,
) {
  return updateEnvironmentRecord(db, notifier, id, {
    lifecycle: {
      status: input.status,
    },
    metadata: {
      path: input.path,
      isGitRepo: input.isGitRepo,
      isWorktree: input.isWorktree,
      branchName: input.branchName,
      defaultBranch: input.defaultBranch,
    },
  });
}

export function updateEnvironmentMetadata(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  input: UpdateEnvironmentMetadataInput,
) {
  return updateEnvironmentMetadataRecord(db, notifier, id, {
    mergeBaseBranch: input.mergeBaseBranch,
  });
}

export function setEnvironmentStatus(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  input: UpdateEnvironmentStatusInput,
) {
  return updateEnvironmentLifecycleRecord(db, notifier, id, {
    status: input.status,
  });
}

function resolveRequestedCleanupMode(
  current: EnvironmentCleanupMode | null,
  requested: EnvironmentCleanupMode,
): EnvironmentCleanupMode {
  if (current === "force" || requested === "force") {
    return "force";
  }
  return "safe";
}

export function recordEnvironmentCleanupRequest(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  input: RequestEnvironmentCleanupInput,
) {
  const existing = getEnvironment(db, id);
  if (!existing) {
    return null;
  }

  return updateEnvironmentLifecycleRecord(db, notifier, id, {
    cleanupRequestedAt:
      existing.cleanupRequestedAt ?? input.requestedAt ?? Date.now(),
    cleanupMode: resolveRequestedCleanupMode(
      existing.cleanupMode,
      input.cleanupMode,
    ),
  });
}

export function clearEnvironmentCleanupRequestRecord(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
) {
  return updateEnvironmentLifecycleRecord(db, notifier, id, {
    cleanupRequestedAt: null,
    cleanupMode: null,
  });
}

export function setEnvironmentRecordDestroyed(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
) {
  return updateEnvironmentRecord(db, notifier, id, {
    lifecycle: {
      cleanupRequestedAt: null,
      cleanupMode: null,
      status: "destroyed",
    },
  });
}

export function claimManagedEnvironmentReprovisionRecord(
  db: DbConnection,
  notifier: DbNotifier,
  args: ClaimManagedEnvironmentReprovisionArgs,
): boolean {
  const now = args.now ?? Date.now();
  const claimed = db.transaction((tx) => {
    const current = tx
      .select({
        status: environments.status,
      })
      .from(environments)
      .where(eq(environments.id, args.environmentId))
      .get();

    if (!current || current.status === "provisioning") {
      return false;
    }

    tx.update(environments)
      .set({
        status: "provisioning",
        updatedAt: now,
      })
      .where(eq(environments.id, args.environmentId))
      .run();

    return true;
  }, { behavior: "immediate" });

  if (claimed) {
    notifier.notifyEnvironment(args.environmentId, ["status-changed"]);
  }

  return claimed;
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
