import { eq } from "drizzle-orm";
import type { HostType } from "@bb/domain";
import type { DbConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { hosts } from "../schema.js";
import { createHostId } from "../ids.js";

export interface UpsertHostInput {
  id?: string;
  name: string;
  type: HostType;
  provider?: string | null;
  externalId?: string | null;
}

export function upsertHost(
  db: DbConnection,
  notifier: DbNotifier,
  input: UpsertHostInput,
) {
  const now = Date.now();
  const id = input.id ?? createHostId();
  const existing = db.select().from(hosts).where(eq(hosts.id, id)).get();

  if (existing) {
    db.update(hosts)
      .set({
        name: input.name,
        type: input.type,
        provider: input.provider ?? null,
        externalId: input.externalId ?? null,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(hosts.id, id))
      .run();
  } else {
    db.insert(hosts)
      .values({
        id,
        name: input.name,
        type: input.type,
        provider: input.provider ?? null,
        externalId: input.externalId ?? null,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    notifier.notifyHost(["host-connected"]);
  }

  return db.select().from(hosts).where(eq(hosts.id, id)).get()!;
}

export function getHost(db: DbConnection, id: string) {
  return db.select().from(hosts).where(eq(hosts.id, id)).get() ?? null;
}

export function listHosts(db: DbConnection) {
  return db.select().from(hosts).all();
}
