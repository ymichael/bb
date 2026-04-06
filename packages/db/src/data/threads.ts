import { and, count, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { ThreadChangeKind, ThreadStatus, ThreadType } from "@bb/domain";
import type { DbConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { environments, threads } from "../schema.js";
import { createThreadId } from "../ids.js";

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
  const thread = db.insert(threads)
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

export interface CountLiveThreadsInEnvironmentArgs {
  environmentId: string;
  excludeThreadId?: string;
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

export function listThreads(
  db: DbConnection,
  options: ListThreadsOptions,
) {
  const filters = [
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

  return db
    .select()
    .from(threads)
    .where(and(...filters))
    .orderBy(desc(threads.createdAt))
    .all();
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
        args.excludeThreadId
          ? ne(threads.id, args.excludeThreadId)
          : undefined,
      ),
    )
    .get();

  return liveThreadCount?.count ?? 0;
}

export function listThreadEnvironmentAssignmentsOnHost(
  db: DbConnection,
  args: ListThreadEnvironmentAssignmentsOnHostArgs,
): ThreadEnvironmentAssignmentRow[] {
  if (args.threadIds.length === 0) {
    return [];
  }

  return db.select({
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
  return db.select({
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
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  input: UpdateThreadInput,
) {
  const now = Date.now();
  const changes: ThreadChangeKind[] = [];
  if ("title" in input) changes.push("title-changed");
  if ("lastReadAt" in input) changes.push("read-state-changed");

  const set: Record<string, unknown> = { updatedAt: now };
  if ("title" in input) set.title = input.title;
  if ("titleFallback" in input) set.titleFallback = input.titleFallback;
  if ("environmentId" in input) set.environmentId = input.environmentId;
  if ("lastReadAt" in input) set.lastReadAt = input.lastReadAt;
  if ("parentThreadId" in input) set.parentThreadId = input.parentThreadId;

  const updated = db.update(threads)
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
  const updated = db.update(threads)
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
  const updated = db.update(threads)
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
  const updated = db.update(threads)
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
  const updated = db.update(threads)
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
  const updated = db.update(threads)
    .set({ archivedAt: null, updatedAt: now })
    .where(eq(threads.id, id))
    .returning()
    .get();
  if (updated) {
    notifier.notifyThread(id, ["archived-changed"]);
  }
  return updated ?? null;
}

export function transitionThreadStatus(
  db: DbConnection,
  notifier: DbNotifier,
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
    throw new Error(
      `Invalid thread status transition: ${currentStatus} → ${newStatus}`,
    );
  }

  const now = Date.now();
  const updated = db.update(threads)
    .set({ status: newStatus, updatedAt: now })
    .where(eq(threads.id, id))
    .returning()
    .get();

  notifier.notifyThread(id, ["status-changed"]);
  return updated!;
}
