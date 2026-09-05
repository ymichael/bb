import { and, eq } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { machineLaunches } from "../schema.js";

export type MachineLaunchRow = typeof machineLaunches.$inferSelect;

export function getMachineLaunch(db: DbConnection, key: string) {
  return (
    db.select().from(machineLaunches).where(eq(machineLaunches.key, key)).get() ??
    null
  );
}

export function upsertMachineLaunch(
  db: DbConnection,
  row: typeof machineLaunches.$inferInsert,
): void {
  db.insert(machineLaunches)
    .values(row)
    .onConflictDoUpdate({ target: machineLaunches.key, set: row })
    .run();
}

export function updateMachineLaunchAttempt(
  db: DbConnection,
  row: Partial<typeof machineLaunches.$inferInsert> & {
    key: string;
    attempt: number;
  },
): boolean {
  return (
    db
      .update(machineLaunches)
      .set(row)
      .where(
        and(
          eq(machineLaunches.key, row.key),
          eq(machineLaunches.attempt, row.attempt),
        ),
      )
      .run().changes > 0
  );
}

export function listMachineLaunchesByPhase(
  db: DbConnection,
  phase: MachineLaunchRow["phase"],
): MachineLaunchRow[] {
  return db
    .select()
    .from(machineLaunches)
    .where(eq(machineLaunches.phase, phase))
    .all();
}
