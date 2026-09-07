import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { DbConnection, DbTransaction } from "../connection.js";
import { environments, hosts, terminalSessions, threads } from "../schema.js";

type Connection = DbConnection | DbTransaction;

const liveThreadCondition = or(
  and(isNull(threads.archivedAt), isNull(threads.deletedAt)),
  eq(threads.status, "stopping"),
  eq(threads.status, "active"),
);

export function listProviderMachines(db: Connection, providerId: string) {
  return db
    .select()
    .from(hosts)
    .where(eq(hosts.machineProviderId, providerId))
    .all();
}

export function machineHasLiveThreads(
  db: Connection,
  hostId: string,
): boolean {
  return (
    db
      .select({ id: threads.id })
      .from(threads)
      .innerJoin(environments, eq(threads.environmentId, environments.id))
      .where(and(eq(environments.hostId, hostId), liveThreadCondition))
      .limit(1)
      .get() !== undefined
  );
}

export function machineIdleSince(
  db: Connection,
  hostId: string,
): number | null {
  const rows = db
    .select({ status: threads.status, updatedAt: threads.updatedAt })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      and(
        eq(environments.hostId, hostId),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
      ),
    )
    .all();
  if (rows.length === 0 || rows.some((row) => row.status !== "idle")) {
    return null;
  }
  return Math.max(...rows.map((row) => row.updatedAt));
}

export function machineHasOpenTerminal(
  db: Connection,
  hostId: string,
): boolean {
  return (
    db
      .select({ id: terminalSessions.id })
      .from(terminalSessions)
      .where(
        and(
          eq(terminalSessions.hostId, hostId),
          inArray(terminalSessions.status, [
            "starting",
            "running",
            "disconnected",
          ]),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}
