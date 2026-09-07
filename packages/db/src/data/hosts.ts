import { and, eq, inArray, isNull } from "drizzle-orm";
import type { HostChangeKind, HostType, PermissionMode } from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { hosts } from "../schema.js";
import { createHostId } from "../ids.js";

type HostWriteConnection = DbConnection | DbTransaction;

export interface UpsertHostInput {
  connectMachineId?: string | null;
  id?: string;
  name: string;
  type: HostType;
  destroyedAt?: number | null;
}

export interface UpdateHostInput {
  destroyedAt?: number | null;
  lastRejectedProtocolVersion?: number | null;
  maxPermissionMode?: PermissionMode;
  name?: string;
}

function notifyHostMutation(
  notifier: DbNotifier,
  previous: ReturnType<typeof getHost>,
  next: ReturnType<typeof getHost>,
): void {
  if (!previous || !next) {
    return;
  }

  const hostChange = getHostConnectionChange(previous, next);
  if (!hostChange) {
    return;
  }

  notifier.notifyHost(next.id, [hostChange]);
}

function getHostConnectionChange(
  previous: NonNullable<ReturnType<typeof getHost>>,
  next: NonNullable<ReturnType<typeof getHost>>,
): HostChangeKind | null {
  if (previous.destroyedAt === null && next.destroyedAt !== null) {
    return "host-disconnected";
  }

  if (previous.destroyedAt !== null && next.destroyedAt === null) {
    return "host-connected";
  }

  return null;
}

export function upsertHost(
  db: HostWriteConnection,
  notifier: DbNotifier,
  input: UpsertHostInput,
) {
  const now = Date.now();
  const id = input.id ?? createHostId();
  const existing = db.select().from(hosts).where(eq(hosts.id, id)).get();

  if (existing) {
    const updated = db
      .update(hosts)
      .set({
        type: input.type,
        connectMachineId:
          input.connectMachineId !== undefined
            ? input.connectMachineId
            : existing.connectMachineId,
        destroyedAt:
          input.destroyedAt !== undefined
            ? input.destroyedAt
            : existing.destroyedAt,
        lastSeenAt: existing.lastSeenAt,
        lastRejectedProtocolVersion: existing.lastRejectedProtocolVersion,
        updatedAt: now,
      })
      .where(eq(hosts.id, id))
      .returning()
      .get()!;
    notifyHostMutation(notifier, existing, updated);
    return updated;
  } else {
    const row = db
      .insert(hosts)
      .values({
        id,
        name: input.name,
        type: input.type,
        connectMachineId: input.connectMachineId ?? null,
        destroyedAt: input.destroyedAt ?? null,
        lastSeenAt: null,
        lastRejectedProtocolVersion: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    notifier.notifyHost(id, ["host-connected"]);
    return row;
  }
}

export function markHostSeen(
  db: HostWriteConnection,
  hostId: string,
  at: number = Date.now(),
): void {
  db.update(hosts)
    .set({ lastSeenAt: at, updatedAt: at })
    .where(eq(hosts.id, hostId))
    .run();
}

export function getHost(db: HostWriteConnection, id: string) {
  return db.select().from(hosts).where(eq(hosts.id, id)).get() ?? null;
}

export function getNonDestroyedHost(db: DbConnection, id: string) {
  return (
    db
      .select()
      .from(hosts)
      .where(and(eq(hosts.id, id), isNull(hosts.destroyedAt)))
      .get() ?? null
  );
}

export function listHosts(db: DbConnection) {
  return db.select().from(hosts).all();
}

export function listPublicHosts(db: DbConnection) {
  return db
    .select()
    .from(hosts)
    .where(and(eq(hosts.type, "persistent"), isNull(hosts.destroyedAt)))
    .all();
}

export function listNonDestroyedHostsByIds(
  db: DbConnection,
  hostIds: readonly string[],
) {
  if (hostIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(hosts)
    .where(and(inArray(hosts.id, [...hostIds]), isNull(hosts.destroyedAt)))
    .all();
}

export function updateHost(
  db: DbConnection,
  notifier: DbNotifier,
  hostId: string,
  input: UpdateHostInput,
) {
  const existing = getHost(db, hostId);
  if (!existing) {
    return null;
  }

  const now = Date.now();
  db.update(hosts)
    .set({
      ...(input.destroyedAt !== undefined
        ? { destroyedAt: input.destroyedAt }
        : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.maxPermissionMode !== undefined
        ? { maxPermissionMode: input.maxPermissionMode }
        : {}),
      ...(input.lastRejectedProtocolVersion !== undefined
        ? { lastRejectedProtocolVersion: input.lastRejectedProtocolVersion }
        : {}),
      updatedAt: now,
    })
    .where(eq(hosts.id, hostId))
    .run();

  const updated = getHost(db, hostId);
  notifyHostMutation(notifier, existing, updated);
  return updated;
}

export function deleteHost(
  db: DbConnection,
  notifier: DbNotifier,
  hostId: string,
) {
  const existing = getHost(db, hostId);
  if (!existing) {
    return false;
  }

  db.delete(hosts).where(eq(hosts.id, hostId)).run();
  notifier.notifyHost(existing.id, ["host-disconnected"]);
  return true;
}
