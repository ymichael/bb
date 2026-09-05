import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { DbConnection, DbTransaction } from "../connection.js";
import { environmentLaunches, environments, threads } from "../schema.js";

type Connection = DbConnection | DbTransaction;
export type EnvironmentLaunchRow = typeof environmentLaunches.$inferSelect;

export function getEnvironmentLaunch(db: Connection, threadId: string) {
  return db.select().from(environmentLaunches).where(eq(environmentLaunches.threadId, threadId)).get() ?? null;
}

export function saveEnvironmentLaunch(db: Connection, row: EnvironmentLaunchRow): void {
  db.insert(environmentLaunches).values(row).onConflictDoUpdate({ target: environmentLaunches.threadId, set: row }).run();
}

export function updateEnvironmentLaunch(db: Connection, row: EnvironmentLaunchRow): boolean {
  return db.update(environmentLaunches).set(row).where(and(eq(environmentLaunches.threadId, row.threadId), eq(environmentLaunches.attempt, row.attempt))).run().changes > 0;
}

export function listCancelledEnvironmentLaunches(db: Connection) {
  return db.select().from(environmentLaunches).where(and(eq(environmentLaunches.phase, "cancelled"), isNull(environmentLaunches.environmentId), eq(environmentLaunches.cancelPending, true))).all();
}

export function listProviderLifecycleEnvironments(db: Connection, providerId: string) {
  return db.select().from(environments).where(and(eq(environments.environmentProviderId, providerId), sql`(${environments.retireAt} is not null or ${environments.teardownStatus} is not null or not exists (select 1 from ${threads} where ${threads.environmentId} = ${environments.id} and ${threads.archivedAt} is null and ${threads.deletedAt} is null))`, or(ne(environments.status, "destroyed"), isNull(environments.teardownStatus), ne(environments.teardownStatus, "removed")))).all();
}

export function environmentHasLiveThreads(db: Connection, environmentId: string): boolean {
  return db.select({ id: threads.id }).from(threads).where(and(eq(threads.environmentId, environmentId), or(and(isNull(threads.archivedAt), isNull(threads.deletedAt)), eq(threads.status, "stopping"), eq(threads.status, "active")))).limit(1).get() !== undefined;
}

export function deleteFinishedEnvironmentLaunches(db: Connection): void {
  db.delete(environmentLaunches).where(and(eq(environmentLaunches.cancelPending, false), ne(environmentLaunches.phase, "creating"), sql`(${environmentLaunches.environmentId} is not null or ${environmentLaunches.phase} = 'failed' or ${environmentLaunches.phase} = 'cancelled')`, sql`not exists (select 1 from ${threads} where ${threads.id} = ${environmentLaunches.threadId} and ${threads.deletedAt} is null)`)).run();
}
