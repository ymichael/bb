import { and, asc, eq, lte, notInArray } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { pluginSchedules } from "../schema.js";

export interface PluginScheduleRow {
  pluginId: string;
  name: string;
  cron: string;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: "running" | "ok" | "error" | null;
  lastError: string | null;
  updatedAt: number;
}

export function upsertPluginSchedule(
  db: DbConnection,
  args: { pluginId: string; name: string; cron: string; nextRunAt: number },
): void {
  const updatedAt = Date.now();
  db.insert(pluginSchedules)
    .values({ ...args, updatedAt })
    .onConflictDoUpdate({
      target: [pluginSchedules.pluginId, pluginSchedules.name],
      set: { cron: args.cron, nextRunAt: args.nextRunAt, updatedAt },
    })
    .run();
}

export function prunePluginSchedules(
  db: DbConnection,
  pluginId: string,
  keepNames: string[],
): void {
  const conditions = [eq(pluginSchedules.pluginId, pluginId)];
  if (keepNames.length > 0) {
    conditions.push(notInArray(pluginSchedules.name, keepNames));
  }
  db.delete(pluginSchedules)
    .where(and(...conditions))
    .run();
}

export function deletePluginSchedules(db: DbConnection, pluginId: string): void {
  db.delete(pluginSchedules)
    .where(eq(pluginSchedules.pluginId, pluginId))
    .run();
}

export function listPluginSchedules(
  db: DbConnection,
  pluginId?: string,
): PluginScheduleRow[] {
  const query = db.select().from(pluginSchedules);
  return (
    pluginId === undefined
      ? query
      : query.where(eq(pluginSchedules.pluginId, pluginId))
  )
    .orderBy(asc(pluginSchedules.pluginId), asc(pluginSchedules.name))
    .all();
}

export function listDuePluginSchedules(
  db: DbConnection,
  args: { now: number; limit: number },
): PluginScheduleRow[] {
  return db
    .select()
    .from(pluginSchedules)
    .where(lte(pluginSchedules.nextRunAt, args.now))
    .orderBy(asc(pluginSchedules.nextRunAt), asc(pluginSchedules.pluginId))
    .limit(args.limit)
    .all();
}

export function claimPluginScheduledRun(
  db: DbConnection,
  args: {
    pluginId: string;
    name: string;
    expectedNextRunAt: number;
    newNextRunAt: number;
    now: number;
  },
): boolean {
  const result = db
    .update(pluginSchedules)
    .set({
      nextRunAt: args.newNextRunAt,
      lastRunAt: args.now,
      lastStatus: "running",
      lastError: null,
      updatedAt: args.now,
    })
    .where(
      and(
        eq(pluginSchedules.pluginId, args.pluginId),
        eq(pluginSchedules.name, args.name),
        eq(pluginSchedules.nextRunAt, args.expectedNextRunAt),
      ),
    )
    .run();
  return result.changes > 0;
}

export function recordPluginScheduleResult(
  db: DbConnection,
  args: {
    pluginId: string;
    name: string;
    status: "ok" | "error";
    error: string | null;
    now: number;
  },
): void {
  db.update(pluginSchedules)
    .set({ lastStatus: args.status, lastError: args.error, updatedAt: args.now })
    .where(
      and(
        eq(pluginSchedules.pluginId, args.pluginId),
        eq(pluginSchedules.name, args.name),
      ),
    )
    .run();
}
