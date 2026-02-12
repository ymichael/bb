import { eq, and, sql, gt, isNull, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  Project,
  Thread,
  ThreadStatus,
  ThreadEvent,
  ThreadEventData,
  ThreadEventType,
} from "@beanbag/core";
import type { DbConnection } from "./connection.js";
import { projects, threads, events } from "./schema.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getStringField(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
}

function extractTurnIdFromEventData(data: unknown): string | undefined {
  const root = asRecord(data);
  if (!root) return undefined;

  const direct =
    getStringField(root, "turnId") ??
    getStringField(root, "turn_id");
  if (direct) return direct;

  const turn = asRecord(root.turn);
  const turnId = getStringField(turn, "id");
  if (turnId) return turnId;

  const msg = asRecord(root.msg);
  const msgTurnId =
    getStringField(msg, "turn_id") ??
    getStringField(msg, "turnId");
  if (msgTurnId) return msgTurnId;

  const payload = asRecord(root.payload);
  if (!payload) return undefined;

  return (
    getStringField(payload, "turnId") ??
    getStringField(payload, "turn_id") ??
    getStringField(asRecord(payload.turn), "id") ??
    getStringField(asRecord(payload.msg), "turn_id") ??
    getStringField(asRecord(payload.msg), "turnId")
  );
}

function extractProviderThreadIdFromEventData(data: unknown): string | undefined {
  const root = asRecord(data);
  if (!root) return undefined;

  const candidates = [
    root,
    asRecord(root.msg),
    asRecord(root.thread),
    asRecord(root.payload),
    asRecord(asRecord(root.payload)?.msg),
    asRecord(asRecord(root.payload)?.thread),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    const threadId =
      getStringField(candidate, "threadId") ??
      getStringField(candidate, "thread_id") ??
      getStringField(candidate, "conversationId") ??
      getStringField(candidate, "conversation_id");
    if (threadId) return threadId;

    const thread = asRecord(candidate.thread);
    const nestedThreadId = getStringField(thread, "id");
    if (nestedThreadId) return nestedThreadId;
  }

  return undefined;
}

function deriveEventLookupFields(type: string, data: unknown): {
  normType: string;
  turnId?: string;
  providerThreadId?: string;
  isTurnLifecycle: boolean;
  isThreadIdentity: boolean;
} {
  const normType = normalizeEventType(type);
  const turnId = extractTurnIdFromEventData(data);
  const providerThreadId = extractProviderThreadIdFromEventData(data);
  const isTurnLifecycle =
    normType === "turn/start" ||
    normType === "turn/started" ||
    normType === "turn/end" ||
    normType === "turn/completed";

  return {
    normType,
    ...(turnId ? { turnId } : {}),
    ...(providerThreadId ? { providerThreadId } : {}),
    isTurnLifecycle,
    isThreadIdentity: Boolean(providerThreadId),
  };
}

// ---------------------------------------------------------------------------
// ProjectRepository
// ---------------------------------------------------------------------------

export class ProjectRepository {
  constructor(private db: DbConnection) {}

  create(data: { name: string; rootPath: string }): Project {
    const now = Date.now();
    const row = {
      id: nanoid(),
      name: data.name,
      rootPath: data.rootPath,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(projects).values(row).run();
    return row;
  }

  getById(id: string): Project | undefined {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) return undefined;
    return row as Project;
  }

  list(): Project[] {
    const rows = this.db.select().from(projects).all();
    return rows as Project[];
  }

  delete(id: string): void {
    this.db.delete(projects).where(eq(projects.id, id)).run();
  }
}

// ---------------------------------------------------------------------------
// ThreadRepository
// ---------------------------------------------------------------------------

export class ThreadRepository {
  constructor(private db: DbConnection) {}

  create(data: { projectId: string; title?: string }): Thread {
    const now = Date.now();
    const row = {
      id: nanoid(),
      projectId: data.projectId,
      title: data.title ?? null,
      status: "created" as const,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(threads).values(row).run();
    return this.rowToThread(row);
  }

  getById(id: string): Thread | undefined {
    const row = this.db
      .select()
      .from(threads)
      .where(eq(threads.id, id))
      .get();
    if (!row) return undefined;
    return this.rowToThread(row);
  }

  list(filters?: {
    projectId?: string;
    status?: ThreadStatus;
    includeArchived?: boolean;
  }): Thread[] {
    const conditions = [];
    if (!filters?.includeArchived) {
      conditions.push(isNull(threads.archivedAt));
    }
    if (filters?.projectId) {
      conditions.push(eq(threads.projectId, filters.projectId));
    }
    if (filters?.status) {
      conditions.push(eq(threads.status, filters.status));
    }

    let query = this.db.select().from(threads);
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }
    const rows = query.all();
    return rows.map((row) => this.rowToThread(row));
  }

  update(
    id: string,
    data: { status?: ThreadStatus; title?: string; archivedAt?: number | null }
  ): Thread | undefined {
    const existing = this.db
      .select()
      .from(threads)
      .where(eq(threads.id, id))
      .get();
    if (!existing) return undefined;

    const updates: Record<string, unknown> = { updatedAt: Date.now() };
    if (data.status !== undefined) updates.status = data.status;
    if (data.title !== undefined) updates.title = data.title;
    if (data.archivedAt !== undefined) updates.archivedAt = data.archivedAt;

    this.db.update(threads).set(updates).where(eq(threads.id, id)).run();
    return this.getById(id);
  }

  delete(id: string): void {
    this.db.delete(threads).where(eq(threads.id, id)).run();
  }

  private rowToThread(row: typeof threads.$inferSelect): Thread {
    const normalizedStatus = (() => {
      if (
        row.status === "created" ||
        row.status === "provisioning" ||
        row.status === "provisioning_failed" ||
        row.status === "active" ||
        row.status === "idle"
      ) {
        return row.status;
      }
      // Backward compatibility for databases that still contain legacy statuses.
      if (row.status === "running") return "active";
      return "created";
    })();

    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title ?? undefined,
      status: normalizedStatus,
      archivedAt: row.archivedAt ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// EventRepository
// ---------------------------------------------------------------------------

export class EventRepository {
  constructor(private db: DbConnection) {}

  create(data: {
    threadId: string;
    seq: number;
    type: ThreadEventType;
    data: ThreadEventData;
  }): ThreadEvent {
    const now = Date.now();
    const lookupFields = deriveEventLookupFields(data.type, data.data);
    const row = {
      id: nanoid(),
      threadId: data.threadId,
      seq: data.seq,
      type: data.type,
      normType: lookupFields.normType,
      turnId: lookupFields.turnId ?? null,
      providerThreadId: lookupFields.providerThreadId ?? null,
      isTurnLifecycle: lookupFields.isTurnLifecycle,
      isThreadIdentity: lookupFields.isThreadIdentity,
      data: JSON.stringify(data.data),
      createdAt: now,
    };
    this.db.insert(events).values(row).run();
    return {
      id: row.id,
      threadId: row.threadId,
      seq: row.seq,
      type: row.type,
      data: JSON.parse(row.data),
      createdAt: row.createdAt,
    };
  }

  listByThread(threadId: string, afterSeq?: number): ThreadEvent[] {
    const conditions = [eq(events.threadId, threadId)];
    if (afterSeq !== undefined) {
      conditions.push(gt(events.seq, afterSeq));
    }

    const rows = this.db
      .select()
      .from(events)
      .where(and(...conditions))
      .orderBy(events.seq)
      .all();

    return rows.map((r) => {
      return {
        id: r.id,
        threadId: r.threadId,
        seq: r.seq,
        type: r.type,
        data: JSON.parse(r.data),
        createdAt: r.createdAt,
      };
    });
  }

  getLatestSeq(threadId: string): number {
    const row = this.db
      .select({ maxSeq: sql<number>`MAX(${events.seq})` })
      .from(events)
      .where(eq(events.threadId, threadId))
      .get();
    return row?.maxSeq ?? 0;
  }

  getLatestTurnLifecycle(
    threadId: string,
  ): { normType: string; turnId?: string } | undefined {
    const row = this.db
      .select({
        normType: events.normType,
        turnId: events.turnId,
      })
      .from(events)
      .where(
        and(
          eq(events.threadId, threadId),
          eq(events.isTurnLifecycle, true),
        ),
      )
      .orderBy(desc(events.seq))
      .get();

    if (!row) return undefined;
    return {
      normType: row.normType,
      ...(row.turnId ? { turnId: row.turnId } : {}),
    };
  }

  getLatestProviderThreadId(threadId: string): string | undefined {
    const row = this.db
      .select({
        providerThreadId: events.providerThreadId,
      })
      .from(events)
      .where(
        and(
          eq(events.threadId, threadId),
          eq(events.isThreadIdentity, true),
        ),
      )
      .orderBy(desc(events.seq))
      .get();

    return row?.providerThreadId ?? undefined;
  }
}
