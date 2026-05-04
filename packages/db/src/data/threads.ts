import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  ne,
} from "drizzle-orm";
import type {
  EnvironmentWorkspaceDisplayKind,
  ThreadChangeKind,
  ThreadStatus,
  ThreadType,
} from "@bb/domain";
import { resolveEnvironmentWorkspaceDisplayKind } from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import {
  environments,
  hosts,
  pendingInteractions,
  threads,
} from "../schema.js";
import { createThreadId } from "../ids.js";

type ThreadWriteConnection = DbConnection | DbTransaction;

/**
 * Allowed thread status transitions.
 * Key is the current status, values are the statuses it can transition to.
 */
export const ALLOWED_TRANSITIONS: Record<ThreadStatus, ThreadStatus[]> = {
  created: ["provisioning", "active", "idle", "error"],
  provisioning: ["active", "idle", "error"],
  idle: ["provisioning", "active", "error"],
  active: ["idle", "error"],
  error: ["active", "idle"],
};

export interface CreateThreadInput {
  automationId?: string | null;
  projectId: string;
  environmentId?: string | null;
  providerId: string;
  type?: ThreadType;
  title?: string | null;
  titleFallback?: string | null;
  status?: ThreadStatus;
  parentThreadId?: string | null;
}

export function createThread(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateThreadInput,
) {
  const now = Date.now();
  const id = createThreadId();
  const thread = db
    .insert(threads)
    .values({
      id,
      projectId: input.projectId,
      environmentId: input.environmentId ?? null,
      automationId: input.automationId ?? null,
      providerId: input.providerId,
      type: input.type ?? "standard",
      title: input.title ?? null,
      titleFallback: input.titleFallback ?? null,
      status: input.status ?? "created",
      parentThreadId: input.parentThreadId ?? null,
      lastReadAt: now,
      latestAttentionAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  notifier.notifyThread(id, ["thread-created"]);
  notifier.notifyProject(input.projectId, ["threads-changed"]);
  return thread;
}

export function getThread(db: DbConnection, id: string) {
  return db.select().from(threads).where(eq(threads.id, id)).get() ?? null;
}

export interface ListThreadsOptions {
  projectId: string;
  archived?: boolean;
  parentThreadId?: string;
  type?: ThreadType;
}

type ThreadRow = typeof threads.$inferSelect;

interface InvalidThreadStatusTransitionErrorArgs {
  currentStatus: ThreadStatus;
  newStatus: ThreadStatus;
}

export interface TransitionThreadStatusInTransactionArgs {
  id: string;
  newStatus: ThreadStatus;
}

export class InvalidThreadStatusTransitionError extends Error {
  readonly currentStatus: ThreadStatus;
  readonly newStatus: ThreadStatus;

  constructor(args: InvalidThreadStatusTransitionErrorArgs) {
    super(
      `Invalid thread status transition: ${args.currentStatus} → ${args.newStatus}`,
    );
    this.name = "InvalidThreadStatusTransitionError";
    this.currentStatus = args.currentStatus;
    this.newStatus = args.newStatus;
  }
}

export interface ThreadWithPendingInteractionState extends ThreadRow {
  environmentBranchName: string | null;
  environmentHostId: string | null;
  hasPendingInteraction: boolean;
  environmentWorkspaceDisplayKind: EnvironmentWorkspaceDisplayKind;
}

export interface CountLiveThreadsInEnvironmentArgs {
  environmentId: string;
  excludeThreadId?: string;
}

export interface CountNonDeletedAssignedChildThreadsArgs {
  parentThreadId: string;
}

export interface MarkThreadStopRequestedArgs {
  requestedAt?: number;
  threadId: string;
}

export interface MarkThreadDeletedArgs {
  deletedAt?: number;
  threadId: string;
}

export interface ListThreadEnvironmentAssignmentsOnHostArgs {
  hostId: string;
  threadIds: readonly string[];
}

export interface ListHostThreadIdsArgs {
  hostId: string;
}

export interface ThreadEnvironmentAssignmentRow {
  environmentId: string;
  threadId: string;
}

export interface StopRequestedThreadRow {
  environmentId: string | null;
  hostId: string;
  status: ThreadStatus;
  stopRequestedAt: number | null;
  threadId: string;
}

export interface HasPendingThreadShutdownInEnvironmentArgs {
  environmentId: string;
}

export interface TransitionThreadsToErrorArgs {
  now?: number;
  threadIds: readonly string[];
}

const THREAD_STATUSES_ALLOWING_ERROR: ThreadStatus[] = [
  "created",
  "provisioning",
  "idle",
  "active",
];

interface StatusTransition {
  currentStatus: ThreadStatus;
  newStatus: ThreadStatus;
}

function statusTransitionNeedsAttention(args: StatusTransition): boolean {
  if (args.currentStatus === "active" && args.newStatus === "idle") {
    return true;
  }

  if (args.newStatus !== "error") {
    return false;
  }

  return (
    args.currentStatus === "active" || args.currentStatus === "provisioning"
  );
}

function buildListThreadsFilters(options: ListThreadsOptions) {
  return [
    eq(threads.projectId, options.projectId),
    isNull(threads.deletedAt),
    options.type ? eq(threads.type, options.type) : undefined,
    options.parentThreadId
      ? eq(threads.parentThreadId, options.parentThreadId)
      : undefined,
    options.archived === true
      ? isNotNull(threads.archivedAt)
      : options.archived === false
        ? isNull(threads.archivedAt)
        : undefined,
  ].filter((value) => value !== undefined);
}

export function listThreads(db: DbConnection, options: ListThreadsOptions) {
  return db
    .select()
    .from(threads)
    .where(and(...buildListThreadsFilters(options)))
    .orderBy(desc(threads.createdAt))
    .all();
}

export function listThreadsWithPendingInteractionState(
  db: DbConnection,
  options: ListThreadsOptions,
): ThreadWithPendingInteractionState[] {
  const rows = db
    .select({
      ...getTableColumns(threads),
      environmentBranchName: environments.branchName,
      environmentHostId: environments.hostId,
      environmentIsWorktree: environments.isWorktree,
      environmentWorkspaceProvisionType: environments.workspaceProvisionType,
      hostType: hosts.type,
      pendingInteractionCount: count(pendingInteractions.id),
    })
    .from(threads)
    .leftJoin(environments, eq(threads.environmentId, environments.id))
    .leftJoin(hosts, eq(environments.hostId, hosts.id))
    .leftJoin(
      pendingInteractions,
      and(
        eq(pendingInteractions.threadId, threads.id),
        eq(pendingInteractions.status, "pending"),
      ),
    )
    .where(and(...buildListThreadsFilters(options)))
    .groupBy(threads.id)
    .orderBy(desc(threads.createdAt))
    .all();

  return rows.map(
    ({
      environmentIsWorktree,
      environmentWorkspaceProvisionType,
      environmentBranchName,
      environmentHostId,
      hostType,
      pendingInteractionCount,
      ...thread
    }) => ({
      ...thread,
      environmentBranchName,
      environmentHostId,
      environmentWorkspaceDisplayKind: resolveEnvironmentWorkspaceDisplayKind({
        environment: {
          isWorktree: environmentIsWorktree,
          workspaceProvisionType: environmentWorkspaceProvisionType,
        },
        hostType,
      }),
      hasPendingInteraction: pendingInteractionCount > 0,
    }),
  );
}

export function countLiveThreadsInEnvironment(
  db: DbConnection,
  args: CountLiveThreadsInEnvironmentArgs,
): number {
  const liveThreadCount = db
    .select({ count: count() })
    .from(threads)
    .where(
      and(
        eq(threads.environmentId, args.environmentId),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
        args.excludeThreadId ? ne(threads.id, args.excludeThreadId) : undefined,
      ),
    )
    .get();

  return liveThreadCount?.count ?? 0;
}

export function countNonDeletedAssignedChildThreads(
  db: DbConnection,
  args: CountNonDeletedAssignedChildThreadsArgs,
): number {
  const assignedChildThreadCount = db
    .select({ count: count() })
    .from(threads)
    .where(
      and(
        eq(threads.parentThreadId, args.parentThreadId),
        isNull(threads.deletedAt),
      ),
    )
    .get();

  return assignedChildThreadCount?.count ?? 0;
}

export function listThreadEnvironmentAssignmentsOnHost(
  db: DbConnection,
  args: ListThreadEnvironmentAssignmentsOnHostArgs,
): ThreadEnvironmentAssignmentRow[] {
  if (args.threadIds.length === 0) {
    return [];
  }

  return db
    .select({
      threadId: threads.id,
      environmentId: environments.id,
    })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      and(
        inArray(threads.id, [...args.threadIds]),
        eq(environments.hostId, args.hostId),
      ),
    )
    .all();
}

export function listHostThreadIds(
  db: DbConnection,
  args: ListHostThreadIdsArgs,
): string[] {
  return db
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(eq(environments.hostId, args.hostId))
    .all()
    .map((row) => row.id);
}

export function listStopRequestedThreads(
  db: DbConnection,
): StopRequestedThreadRow[] {
  return db
    .select({
      environmentId: threads.environmentId,
      hostId: environments.hostId,
      status: threads.status,
      stopRequestedAt: threads.stopRequestedAt,
      threadId: threads.id,
    })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(isNotNull(threads.stopRequestedAt))
    .all();
}

export function hasPendingThreadShutdownInEnvironment(
  db: DbConnection,
  args: HasPendingThreadShutdownInEnvironmentArgs,
): boolean {
  const row = db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.environmentId, args.environmentId),
        isNotNull(threads.stopRequestedAt),
      ),
    )
    .get();

  return row !== undefined;
}

export interface UpdateThreadInput {
  environmentId?: string | null;
  lastReadAt?: number | null;
  parentThreadId?: string | null;
  title?: string | null;
  titleFallback?: string | null;
}

export function updateThread(
  db: ThreadWriteConnection,
  notifier: DbNotifier,
  id: string,
  input: UpdateThreadInput,
) {
  const now = Date.now();
  const existing = db.select().from(threads).where(eq(threads.id, id)).get();
  if (!existing) {
    return null;
  }

  const changes: ThreadChangeKind[] = [];
  if ("title" in input) changes.push("title-changed");
  if ("lastReadAt" in input) changes.push("read-state-changed");

  const set: Partial<typeof threads.$inferInsert> = { updatedAt: now };
  if ("title" in input) set.title = input.title;
  if ("titleFallback" in input) set.titleFallback = input.titleFallback;
  if ("environmentId" in input) set.environmentId = input.environmentId;
  if ("lastReadAt" in input) {
    set.lastReadAt = input.lastReadAt;
  }
  if ("parentThreadId" in input) set.parentThreadId = input.parentThreadId;

  const updated = db
    .update(threads)
    .set(set)
    .where(eq(threads.id, id))
    .returning()
    .get();
  if (updated && changes.length > 0) {
    notifier.notifyThread(id, changes);
  }
  return updated ?? null;
}

export function deleteThread(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
) {
  const existing = db.select().from(threads).where(eq(threads.id, id)).get();
  if (!existing) return false;
  db.delete(threads).where(eq(threads.id, id)).run();
  notifier.notifyThread(id, ["thread-deleted"]);
  notifier.notifyProject(existing.projectId, ["threads-changed"]);
  return true;
}

export function markThreadStopRequested(
  db: DbConnection,
  notifier: DbNotifier,
  args: MarkThreadStopRequestedArgs,
) {
  const updated = db
    .update(threads)
    .set({
      stopRequestedAt: args.requestedAt ?? Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(threads.id, args.threadId))
    .returning()
    .get();

  if (updated) {
    notifier.notifyThread(args.threadId, ["status-changed"]);
  }

  return updated ?? null;
}

export function clearThreadStopRequested(
  db: DbConnection,
  notifier: DbNotifier,
  threadId: string,
) {
  const updated = db
    .update(threads)
    .set({
      stopRequestedAt: null,
      updatedAt: Date.now(),
    })
    .where(eq(threads.id, threadId))
    .returning()
    .get();

  if (updated) {
    notifier.notifyThread(threadId, ["status-changed"]);
  }

  return updated ?? null;
}

export function markThreadDeleted(
  db: DbConnection,
  notifier: DbNotifier,
  args: MarkThreadDeletedArgs,
) {
  const updated = db
    .update(threads)
    .set({
      deletedAt: args.deletedAt ?? Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(threads.id, args.threadId))
    .returning()
    .get();

  if (updated) {
    notifier.notifyThread(args.threadId, ["thread-deleted"]);
    notifier.notifyProject(updated.projectId, ["threads-changed"]);
  }

  return updated ?? null;
}

export function archiveThread(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
) {
  const now = Date.now();
  const updated = db
    .update(threads)
    .set({ archivedAt: now, updatedAt: now })
    .where(eq(threads.id, id))
    .returning()
    .get();
  if (updated) {
    notifier.notifyThread(id, ["archived-changed"]);
  }
  return updated ?? null;
}

export function unarchiveThread(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
) {
  const now = Date.now();
  const updated = db
    .update(threads)
    .set({ archivedAt: null, updatedAt: now })
    .where(eq(threads.id, id))
    .returning()
    .get();
  if (updated) {
    notifier.notifyThread(id, ["archived-changed"]);
  }
  return updated ?? null;
}

function transitionThreadStatusRecord(
  db: ThreadWriteConnection,
  id: string,
  newStatus: ThreadStatus,
) {
  const thread = db.select().from(threads).where(eq(threads.id, id)).get();
  if (!thread) {
    throw new Error(`Thread not found: ${id}`);
  }

  const currentStatus = thread.status;
  const allowed = ALLOWED_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(newStatus)) {
    throw new InvalidThreadStatusTransitionError({
      currentStatus,
      newStatus,
    });
  }

  const now = Date.now();
  const set: Partial<typeof threads.$inferInsert> = {
    status: newStatus,
    updatedAt: now,
  };
  if (statusTransitionNeedsAttention({ currentStatus, newStatus })) {
    set.latestAttentionAt = now;
  }

  const updated = db
    .update(threads)
    .set(set)
    .where(eq(threads.id, id))
    .returning()
    .get();

  return updated!;
}

export function transitionThreadStatusInTransaction(
  db: DbTransaction,
  args: TransitionThreadStatusInTransactionArgs,
) {
  return transitionThreadStatusRecord(db, args.id, args.newStatus);
}

export function transitionThreadStatus(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  newStatus: ThreadStatus,
) {
  const updated = transitionThreadStatusRecord(db, id, newStatus);
  notifier.notifyThread(id, ["status-changed"]);
  return updated;
}

export function transitionThreadsToError(
  db: DbConnection,
  notifier: DbNotifier,
  args: TransitionThreadsToErrorArgs,
): string[] {
  if (args.threadIds.length === 0) {
    return [];
  }

  const now = args.now ?? Date.now();
  const eligibleThreads = db
    .select({
      id: threads.id,
      status: threads.status,
    })
    .from(threads)
    .where(
      and(
        inArray(threads.id, [...args.threadIds]),
        inArray(threads.status, THREAD_STATUSES_ALLOWING_ERROR),
        isNull(threads.deletedAt),
        isNull(threads.stopRequestedAt),
      ),
    )
    .all();
  const threadOrderById = new Map(
    args.threadIds.map((threadId, index) => [threadId, index]),
  );
  eligibleThreads.sort((left, right) => {
    const leftIndex = threadOrderById.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = threadOrderById.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });

  for (const thread of eligibleThreads) {
    const set: Partial<typeof threads.$inferInsert> = {
      status: "error",
      updatedAt: now,
    };
    if (
      statusTransitionNeedsAttention({
        currentStatus: thread.status,
        newStatus: "error",
      })
    ) {
      set.latestAttentionAt = now;
    }

    db.update(threads).set(set).where(eq(threads.id, thread.id)).run();
    notifier.notifyThread(thread.id, ["status-changed"]);
  }

  return eligibleThreads.map((thread) => thread.id);
}
