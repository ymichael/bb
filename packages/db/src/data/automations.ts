import { and, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { DbConnection, DbTransaction } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { createAutomationId } from "../ids.js";
import { automations, threads } from "../schema.js";
import { sql } from "drizzle-orm";

export interface CreateAutomationInput {
  action: string;
  autoArchive: boolean;
  enabled: boolean;
  name: string;
  nextRunAt: number | null;
  projectId: string;
  triggerConfig: string;
  triggerType: string;
}

export interface UpdateAutomationInput {
  action?: string;
  autoArchive?: boolean;
  enabled?: boolean;
  lastRunAt?: number | null;
  name?: string;
  nextRunAt?: number | null;
  runCount?: number;
  triggerConfig?: string;
  triggerType?: string;
}

export interface AdvanceAutomationAfterRunArgs {
  automationId: string;
  expectedNextRunAt: number | null;
  nextRunAt: number | null;
  now?: number;
}

export interface RestoreAutomationAfterFailedRunArgs {
  automationId: string;
  expectedAdvancedNextRunAt: number | null;
  expectedRunCount: number;
  restoredLastRunAt: number | null;
  restoredNextRunAt: number | null;
  restoredRunCount: number;
  now?: number;
}

export interface DueAutomationCursor {
  createdAt: number;
  id: string;
  nextRunAt: number;
}

export interface ListDueAutomationsArgs {
  after?: DueAutomationCursor;
  limit?: number;
  now: number;
}

type AutomationReadConnection = DbConnection | DbTransaction;

export function createAutomation(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateAutomationInput,
) {
  const now = Date.now();
  const automation = db.insert(automations)
    .values({
      id: createAutomationId(),
      projectId: input.projectId,
      name: input.name,
      enabled: input.enabled,
      triggerType: input.triggerType,
      triggerConfig: input.triggerConfig,
      action: input.action,
      autoArchive: input.autoArchive,
      nextRunAt: input.nextRunAt,
      lastRunAt: null,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();

  notifier.notifyProject(input.projectId, ["automations-changed"]);
  return automation;
}

export function getAutomation(db: DbConnection, automationId: string) {
  return (
    db.select()
      .from(automations)
      .where(eq(automations.id, automationId))
      .get() ?? null
  );
}

export function listAutomations(
  db: DbConnection,
  projectId: string,
) {
  return db.select()
    .from(automations)
    .where(eq(automations.projectId, projectId))
    .orderBy(desc(automations.createdAt))
    .all();
}

export function listDueAutomations(
  db: DbConnection,
  args: ListDueAutomationsArgs,
) {
  const afterFilter = args.after
    ? or(
        gt(automations.nextRunAt, args.after.nextRunAt),
        and(
          eq(automations.nextRunAt, args.after.nextRunAt),
          gt(automations.createdAt, args.after.createdAt),
        ),
        and(
          eq(automations.nextRunAt, args.after.nextRunAt),
          eq(automations.createdAt, args.after.createdAt),
          gt(automations.id, args.after.id),
        ),
      )
    : undefined;
  const query = db.select()
    .from(automations)
    .where(
      and(
        eq(automations.enabled, true),
        eq(automations.triggerType, "schedule"),
        lte(automations.nextRunAt, args.now),
        afterFilter,
      ),
    )
    .orderBy(automations.nextRunAt, automations.createdAt, automations.id);
  return args.limit === undefined ? query.all() : query.limit(args.limit).all();
}

export function updateAutomation(
  db: DbConnection,
  notifier: DbNotifier,
  automationId: string,
  input: UpdateAutomationInput,
) {
  const existing = getAutomation(db, automationId);
  if (!existing) {
    return null;
  }

  const updated = db.update(automations)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.triggerType !== undefined ? { triggerType: input.triggerType } : {}),
      ...(input.triggerConfig !== undefined ? { triggerConfig: input.triggerConfig } : {}),
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(input.autoArchive !== undefined ? { autoArchive: input.autoArchive } : {}),
      ...(input.nextRunAt !== undefined ? { nextRunAt: input.nextRunAt } : {}),
      ...(input.lastRunAt !== undefined ? { lastRunAt: input.lastRunAt } : {}),
      ...(input.runCount !== undefined ? { runCount: input.runCount } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(automations.id, automationId))
    .returning()
    .get();

  if (!updated) {
    return null;
  }

  notifier.notifyProject(updated.projectId, ["automations-changed"]);
  return updated;
}

export function deleteAutomation(
  db: DbConnection,
  notifier: DbNotifier,
  automationId: string,
) {
  const existing = getAutomation(db, automationId);
  if (!existing) {
    return false;
  }

  db.delete(automations).where(eq(automations.id, automationId)).run();
  notifier.notifyProject(existing.projectId, ["automations-changed"]);
  return true;
}

export function hasOpenAutomationThread(
  db: AutomationReadConnection,
  automationId: string,
) {
  const row = db.select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.automationId, automationId),
        inArray(threads.status, ["active", "idle", "provisioning"]),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
      ),
    )
    .get();

  return row !== undefined;
}

export function advanceAutomationAfterRunInTransaction(
  db: DbTransaction,
  args: AdvanceAutomationAfterRunArgs,
) {
  const now = args.now ?? Date.now();
  const result = db.update(automations)
    .set({
      nextRunAt: args.nextRunAt,
      lastRunAt: now,
      runCount: sql`${automations.runCount} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(automations.id, args.automationId),
        args.expectedNextRunAt === null
          ? isNull(automations.nextRunAt)
          : eq(automations.nextRunAt, args.expectedNextRunAt),
      ),
    )
    .run();

  return result.changes > 0;
}

export function advanceAutomationAfterRun(
  db: DbConnection,
  notifier: DbNotifier,
  args: AdvanceAutomationAfterRunArgs & { projectId: string },
) {
  const advanced = db.transaction(
    (tx) => advanceAutomationAfterRunInTransaction(tx, args),
    { behavior: "immediate" },
  );
  if (advanced) {
    notifier.notifyProject(args.projectId, ["automations-changed"]);
  }
  return advanced;
}

export function restoreAutomationAfterFailedRun(
  db: DbConnection,
  notifier: DbNotifier,
  args: RestoreAutomationAfterFailedRunArgs & { projectId: string },
) {
  const now = args.now ?? Date.now();
  const result = db.update(automations)
    .set({
      nextRunAt: args.restoredNextRunAt,
      lastRunAt: args.restoredLastRunAt,
      runCount: args.restoredRunCount,
      updatedAt: now,
    })
    .where(
      and(
        eq(automations.id, args.automationId),
        args.expectedAdvancedNextRunAt === null
          ? isNull(automations.nextRunAt)
          : eq(automations.nextRunAt, args.expectedAdvancedNextRunAt),
        eq(automations.runCount, args.expectedRunCount),
      ),
    )
    .run();

  const restored = result.changes > 0;
  if (restored) {
    notifier.notifyProject(args.projectId, ["automations-changed"]);
  }
  return restored;
}
