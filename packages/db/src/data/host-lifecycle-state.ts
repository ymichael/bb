import { and, eq, isNull } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { hosts } from "../schema.js";

export interface MarkHostSuspendedInput {
  hostId: string;
  suspendedAt: number;
}

export interface MarkHostResumedInput {
  hostId: string;
}

export interface MarkEphemeralHostActivityInput {
  hostId: string;
  lastActivityAt: number;
}

export function markHostSuspended(
  db: DbConnection,
  input: MarkHostSuspendedInput,
) {
  return db
    .update(hosts)
    .set({
      suspendedAt: input.suspendedAt,
      updatedAt: Date.now(),
    })
    .where(eq(hosts.id, input.hostId))
    .returning()
    .get() ?? null;
}

export function markHostResumed(
  db: DbConnection,
  input: MarkHostResumedInput,
) {
  return db
    .update(hosts)
    .set({
      suspendedAt: null,
      updatedAt: Date.now(),
    })
    .where(eq(hosts.id, input.hostId))
    .returning()
    .get() ?? null;
}

export function markEphemeralHostActivity(
  db: DbConnection,
  input: MarkEphemeralHostActivityInput,
) {
  return db
    .update(hosts)
    .set({
      lastActivityAt: input.lastActivityAt,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(hosts.id, input.hostId),
        eq(hosts.type, "ephemeral"),
        isNull(hosts.destroyedAt),
      ),
    )
    .returning()
    .get() ?? null;
}
