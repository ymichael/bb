import { eq, and, sql, gt, isNull, desc, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  Project,
  Thread,
  ThreadStatus,
  ThreadEvent,
  ThreadEventData,
  ThreadEventType,
  ThreadExecutionOptions,
  PersistedThreadEventData,
} from "@beanbag/agent-core";
import {
  extractProviderThreadIdFromPersistedEventData,
  extractTurnIdFromPersistedEventData,
  getStringField,
  normalizeThreadEventType,
  toRecord,
} from "@beanbag/agent-core";
import type { DbConnection } from "./connection.js";
import {
  projects,
  threads,
  events,
} from "./schema.js";

function deriveEventLookupFields(type: string, data: unknown): {
  normType: string;
  turnId?: string;
  providerThreadId?: string;
  isTurnLifecycle: boolean;
  isThreadIdentity: boolean;
} {
  const normType = normalizeThreadEventType(type);
  const turnId = extractTurnIdFromPersistedEventData(data);
  const providerThreadId = extractProviderThreadIdFromPersistedEventData(data);
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

function parseThreadExecutionOptions(
  data: PersistedThreadEventData,
): ThreadExecutionOptions | undefined {
  const root = toRecord(data);
  const execution = toRecord(root?.execution);
  if (!execution) return undefined;

  const model = getStringField(execution, "model");
  const reasoningLevel = toThreadExecutionReasoningLevel(
    getStringField(execution, "reasoningLevel"),
  );
  const sandboxMode = toThreadExecutionSandboxMode(
    getStringField(execution, "sandboxMode"),
  );
  const approvalPolicy = getStringField(execution, "approvalPolicy");

  const hasAny =
    Boolean(model) ||
    Boolean(reasoningLevel) ||
    Boolean(sandboxMode) ||
    Boolean(approvalPolicy);
  if (!hasAny) return undefined;

  return {
    ...(model ? { model } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(sandboxMode ? { sandboxMode } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
  };
}

function isThreadStatus(status: string): status is ThreadStatus {
  return (
    status === "created" ||
    status === "provisioning" ||
    status === "provisioning_failed" ||
    status === "active" ||
    status === "idle"
  );
}

function normalizeThreadStatus(status: string): ThreadStatus {
  if (isThreadStatus(status)) return status;
  throw new Error(`Invalid persisted thread status: ${status}`);
}

function toThreadExecutionReasoningLevel(
  value: string | undefined,
): ThreadExecutionOptions["reasoningLevel"] | undefined {
  if (value === undefined) return undefined;
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  throw new Error(`Invalid persisted reasoning level: ${value}`);
}

function toThreadExecutionSandboxMode(
  value: string | undefined,
): ThreadExecutionOptions["sandboxMode"] | undefined {
  if (value === undefined) return undefined;
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  ) {
    return value;
  }
  throw new Error(`Invalid persisted sandbox mode: ${value}`);
}

function toThreadExecutionSource(
  value: string,
): ThreadExecutionOptions["source"] {
  if (value === "client/thread/start" || value === "client/turn/start") {
    return value;
  }
  throw new Error(`Invalid persisted thread execution source: ${value}`);
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

  update(
    id: string,
    data: { name?: string; rootPath?: string },
  ): Project | undefined {
    const existing = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!existing) return undefined;

    const updates: Record<string, unknown> = { updatedAt: Date.now() };
    if (data.name !== undefined) updates.name = data.name;
    if (data.rootPath !== undefined) updates.rootPath = data.rootPath;

    this.db.update(projects).set(updates).where(eq(projects.id, id)).run();
    const updated = this.db.select().from(projects).where(eq(projects.id, id)).get();
    return updated ? (updated as Project) : undefined;
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

  create(data: {
    projectId: string;
    title?: string;
    parentThreadId?: string;
  }): Thread {
    const now = Date.now();
    const row = {
      id: nanoid(),
      projectId: data.projectId,
      title: data.title ?? null,
      status: "created" as const,
      parentThreadId: data.parentThreadId ?? null,
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
    parentThreadId?: string;
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
    if (filters?.parentThreadId) {
      conditions.push(eq(threads.parentThreadId, filters.parentThreadId));
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
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title ?? undefined,
      status: normalizeThreadStatus(row.status),
      parentThreadId: row.parentThreadId ?? undefined,
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

  getLatestExecutionOptions(
    threadId: string,
  ): ThreadExecutionOptions | undefined {
    const row = this.db
      .select({
        seq: events.seq,
        normType: events.normType,
        data: events.data,
      })
      .from(events)
      .where(
        and(
          eq(events.threadId, threadId),
          inArray(events.normType, ["client/turn/start", "client/thread/start"]),
        ),
      )
      .orderBy(desc(events.seq))
      .get();

    if (!row) return undefined;
    const data = JSON.parse(row.data);
    const execution = parseThreadExecutionOptions(data);
    if (!execution) return undefined;
    const source = toThreadExecutionSource(row.normType);

    return {
      ...execution,
      source,
      seq: row.seq,
    };
  }
}
