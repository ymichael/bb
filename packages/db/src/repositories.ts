import {
  eq,
  and,
  or,
  sql,
  gt,
  lte,
  like,
  isNull,
  desc,
  inArray,
  notInArray,
} from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  PersistedEnvironmentRecord,
  PromptInput,
  Project,
  ReasoningLevel,
  SandboxMode,
  ServiceTier,
  Thread,
  ThreadQueuedMessage,
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
  promptInputSchema,
  toRecord,
} from "@beanbag/agent-core";
import type { DbConnection } from "./connection.js";
import {
  projects,
  threads,
  queuedThreadMessages,
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

const PRUNABLE_NOISE_EVENT_NORM_TYPES: readonly string[] = [
  "account/ratelimits/updated",
  "thread/tokenusage/updated",
  "item/reasoning/summarypartadded",
  "turn/diff/updated",
  "codex/event/token_count",
  "codex/event/turn_diff",
  "codex/event/agent_reasoning",
  "codex/event/user_message",
];

const ALWAYS_PRUNABLE_NOISE_EVENT_NORM_TYPES: readonly string[] = [];

const STORAGE_RECLAIM_MIN_INTERVAL_MS = 60_000;
const STORAGE_RECLAIM_MIN_FREE_PAGES = 2_048;
const STORAGE_RECLAIM_MAX_INCREMENTAL_PAGES = 8_192;

interface SqlitePragmaClient {
  pragma(sql: string): unknown;
  exec(sql: string): unknown;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : undefined;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readPragmaNumber(
  sqlite: SqlitePragmaClient,
  pragma: string,
): number | undefined {
  const raw = sqlite.pragma(pragma);
  const direct = toFiniteNumber(raw);
  if (direct !== undefined) return direct;

  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }

  const first = raw[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return undefined;
  }
  const value = Object.values(first as Record<string, unknown>)[0];
  return toFiniteNumber(value);
}

function parseThreadExecutionOptions(
  data: PersistedThreadEventData,
): ThreadExecutionOptions | undefined {
  const root = toRecord(data);
  const execution = toRecord(root?.execution);
  if (!execution) return undefined;

  const model = getStringField(execution, "model");
  const serviceTier = toThreadExecutionServiceTier(
    getStringField(execution, "serviceTier"),
  );
  const reasoningLevel = toThreadExecutionReasoningLevel(
    getStringField(execution, "reasoningLevel"),
  );
  const sandboxMode = toThreadExecutionSandboxMode(
    getStringField(execution, "sandboxMode"),
  );
  const approvalPolicy = getStringField(execution, "approvalPolicy");

  const hasAny =
    Boolean(model) ||
    Boolean(serviceTier) ||
    Boolean(reasoningLevel) ||
    Boolean(sandboxMode) ||
    Boolean(approvalPolicy);
  if (!hasAny) return undefined;

  return {
    ...(model ? { model } : {}),
    ...(serviceTier ? { serviceTier } : {}),
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

function toThreadExecutionServiceTier(
  value: string | undefined,
): ThreadExecutionOptions["serviceTier"] | undefined {
  if (value === undefined) return undefined;
  if (value === "fast" || value === "flex") {
    return value;
  }
  throw new Error(`Invalid persisted service tier: ${value}`);
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

function parseQueuedPromptInput(rawInput: string): PromptInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    throw new Error("Invalid persisted queued thread input JSON");
  }
  const validationResult = promptInputSchema.array().safeParse(parsed);
  if (!validationResult.success) {
    throw new Error("Invalid persisted queued thread input payload");
  }
  return validationResult.data;
}

function toReasoningLevel(value: string): ReasoningLevel {
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

function toSandboxMode(value: string): SandboxMode {
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  ) {
    return value;
  }
  throw new Error(`Invalid persisted sandbox mode: ${value}`);
}

// ---------------------------------------------------------------------------
// ProjectRepository
// ---------------------------------------------------------------------------

export class ProjectRepository {
  constructor(private db: DbConnection) {}

  private rowToProject(row: typeof projects.$inferSelect): Project {
    return {
      id: row.id,
      name: row.name,
      rootPath: row.rootPath,
      projectInstructions: row.projectInstructions ?? undefined,
      primaryCheckoutThreadId: row.primaryCheckoutThreadId ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  create(data: { name: string; rootPath: string; projectInstructions?: string }): Project {
    const now = Date.now();
    const row = {
      id: nanoid(),
      name: data.name,
      rootPath: data.rootPath,
      projectInstructions: data.projectInstructions ?? null,
      primaryCheckoutThreadId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(projects).values(row).run();
    return this.rowToProject(row);
  }

  getById(id: string): Project | undefined {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) return undefined;
    return this.rowToProject(row);
  }

  list(): Project[] {
    const rows = this.db.select().from(projects).all();
    return rows.map((row) => this.rowToProject(row));
  }

  update(
    id: string,
    data: {
      name?: string;
      rootPath?: string;
      projectInstructions?: string;
      primaryCheckoutThreadId?: string | null;
    },
    opts?: { touchUpdatedAt?: boolean },
  ): Project | undefined {
    const existing = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!existing) return undefined;

    const updates: Record<string, unknown> = {};
    if (opts?.touchUpdatedAt !== false) {
      updates.updatedAt = Date.now();
    }
    if (data.name !== undefined) updates.name = data.name;
    if (data.rootPath !== undefined) updates.rootPath = data.rootPath;
    if (data.projectInstructions !== undefined) {
      updates.projectInstructions = data.projectInstructions;
    }
    if (data.primaryCheckoutThreadId !== undefined) {
      updates.primaryCheckoutThreadId = data.primaryCheckoutThreadId;
    }

    if (Object.keys(updates).length === 0) {
      return this.rowToProject(existing);
    }

    this.db.update(projects).set(updates).where(eq(projects.id, id)).run();
    const updated = this.db.select().from(projects).where(eq(projects.id, id)).get();
    return updated ? this.rowToProject(updated) : undefined;
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
    environmentId?: string;
    environmentRecord?: PersistedEnvironmentRecord;
    environmentAgentCursor?: number;
    parentThreadId?: string;
  }): Thread {
    const now = Date.now();
    const row = {
      id: nanoid(),
      projectId: data.projectId,
      title: data.title ?? null,
      status: "created" as const,
      environmentId: data.environmentId ?? null,
      environmentRecord: data.environmentRecord
        ? JSON.stringify(data.environmentRecord)
        : null,
      environmentAgentCursor: data.environmentAgentCursor ?? null,
      parentThreadId: data.parentThreadId ?? null,
      archivedAt: null,
      lastReadAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(threads).values(row).run();
    return this.rowToThread(row, []);
  }

  getById(id: string): Thread | undefined {
    const row = this.db
      .select()
      .from(threads)
      .where(eq(threads.id, id))
      .get();
    if (!row) return undefined;
    return this.rowToThread(row, this.listQueuedMessages(id));
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
    const queueByThreadId = this.listQueuedMessagesByThreadIds(rows.map((row) => row.id));
    return rows.map((row) =>
      this.rowToThread(row, queueByThreadId.get(row.id) ?? []),
    );
  }

  listArchivedIdsWithEnvironmentRecord(): string[] {
    return this.db
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          sql`${threads.archivedAt} is not null`,
          sql`${threads.environmentRecord} is not null`,
        ),
      )
      .all()
      .map((row) => row.id);
  }

  listNonArchivedActiveIdsWithEnvironmentRecord(): string[] {
    return this.db
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          isNull(threads.archivedAt),
          eq(threads.status, "active"),
          sql`${threads.environmentRecord} is not null`,
        ),
      )
      .all()
      .map((row) => row.id);
  }

  listProjectNonArchivedIdsWithEnvironmentRecord(projectId: string): string[] {
    return this.db
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.projectId, projectId),
          isNull(threads.archivedAt),
          sql`${threads.environmentRecord} is not null`,
        ),
      )
      .all()
      .map((row) => row.id);
  }

  update(
    id: string,
    data: {
      status?: ThreadStatus;
      title?: string;
      environmentId?: string | null;
      environmentRecord?: PersistedEnvironmentRecord | null;
      environmentAgentCursor?: number | null;
      archivedAt?: number | null;
      lastReadAt?: number;
    },
    opts?: {
      touchUpdatedAt?: boolean;
    },
  ): Thread | undefined {
    const existing = this.db
      .select()
      .from(threads)
      .where(eq(threads.id, id))
      .get();
    if (!existing) return undefined;

    const updates: Record<string, unknown> = {};
    if (opts?.touchUpdatedAt !== false) {
      updates.updatedAt = Date.now();
    }
    if (data.status !== undefined) updates.status = data.status;
    if (data.title !== undefined) updates.title = data.title;
    if (data.environmentId !== undefined) updates.environmentId = data.environmentId;
    if (data.environmentRecord !== undefined) {
      updates.environmentRecord = data.environmentRecord
        ? JSON.stringify(data.environmentRecord)
        : null;
    }
    if (data.environmentAgentCursor !== undefined) {
      updates.environmentAgentCursor = data.environmentAgentCursor;
    }
    if (data.archivedAt !== undefined) updates.archivedAt = data.archivedAt;
    if (data.lastReadAt !== undefined) updates.lastReadAt = data.lastReadAt;

    this.db.update(threads).set(updates).where(eq(threads.id, id)).run();
    return this.getById(id);
  }

  delete(id: string): void {
    this.db
      .delete(queuedThreadMessages)
      .where(eq(queuedThreadMessages.threadId, id))
      .run();
    this.db.delete(threads).where(eq(threads.id, id)).run();
  }

  enqueueQueuedMessage(
    threadId: string,
    data: {
      input: PromptInput[];
      model?: string;
      serviceTier?: ServiceTier;
      reasoningLevel: ReasoningLevel;
      sandboxMode: SandboxMode;
    },
  ): ThreadQueuedMessage {
    const row = {
      id: nanoid(),
      threadId,
      input: JSON.stringify(data.input),
      model: data.model ?? null,
      serviceTier: data.serviceTier ?? null,
      reasoningLevel: data.reasoningLevel,
      sandboxMode: data.sandboxMode,
      createdAt: Date.now(),
    };
    this.db.insert(queuedThreadMessages).values(row).run();
    return this.rowToQueuedMessage({ seq: 0, ...row });
  }

  listQueuedMessages(threadId: string): ThreadQueuedMessage[] {
    const rows = this.db
      .select()
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.threadId, threadId))
      .orderBy(queuedThreadMessages.seq)
      .all();
    return rows.map((row) => this.rowToQueuedMessage(row));
  }

  getQueuedMessage(
    threadId: string,
    queuedMessageId: string,
  ): ThreadQueuedMessage | undefined {
    const row = this.db
      .select()
      .from(queuedThreadMessages)
      .where(
        and(
          eq(queuedThreadMessages.threadId, threadId),
          eq(queuedThreadMessages.id, queuedMessageId),
        ),
      )
      .get();
    if (!row) return undefined;
    return this.rowToQueuedMessage(row);
  }

  deleteQueuedMessage(
    threadId: string,
    queuedMessageId: string,
  ): boolean {
    const result = this.db
      .delete(queuedThreadMessages)
      .where(
        and(
          eq(queuedThreadMessages.threadId, threadId),
          eq(queuedThreadMessages.id, queuedMessageId),
        ),
      )
      .run();
    return result.changes > 0;
  }

  markRead(id: string, readAt: number): Thread | undefined {
    if (!Number.isFinite(readAt) || readAt <= 0) {
      throw new Error(`Invalid thread read timestamp: ${readAt}`);
    }

    const existing = this.db
      .select()
      .from(threads)
      .where(eq(threads.id, id))
      .get();
    if (!existing) return undefined;

    const nextReadAt = Math.max(existing.lastReadAt, Math.floor(readAt));
    if (nextReadAt <= existing.lastReadAt) {
      return this.rowToThread(existing, this.listQueuedMessages(id));
    }

    this.db
      .update(threads)
      .set({ lastReadAt: nextReadAt })
      .where(eq(threads.id, id))
      .run();
    return this.getById(id);
  }

  private rowToThread(
    row: typeof threads.$inferSelect,
    queuedMessages: ThreadQueuedMessage[],
  ): Thread {
    const thread = {
      id: row.id,
      projectId: row.projectId,
      title: row.title ?? undefined,
      status: normalizeThreadStatus(row.status),
      environmentId: row.environmentId ?? undefined,
      environmentRecord: parseEnvironmentRecord(row.environmentRecord),
      environmentAgentCursor: row.environmentAgentCursor ?? undefined,
      queuedMessages,
      parentThreadId: row.parentThreadId ?? undefined,
      archivedAt: row.archivedAt ?? undefined,
      lastReadAt: row.lastReadAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return thread as Thread;
  }

  private listQueuedMessagesByThreadIds(
    threadIds: readonly string[],
  ): Map<string, ThreadQueuedMessage[]> {
    const queueByThreadId = new Map<string, ThreadQueuedMessage[]>();
    if (threadIds.length === 0) return queueByThreadId;

    const rows = this.db
      .select()
      .from(queuedThreadMessages)
      .where(inArray(queuedThreadMessages.threadId, Array.from(new Set(threadIds))))
      .orderBy(queuedThreadMessages.threadId, queuedThreadMessages.seq)
      .all();

    for (const row of rows) {
      const queuedMessage = this.rowToQueuedMessage(row);
      const existing = queueByThreadId.get(row.threadId);
      if (existing) {
        existing.push(queuedMessage);
      } else {
        queueByThreadId.set(row.threadId, [queuedMessage]);
      }
    }

    return queueByThreadId;
  }

  private rowToQueuedMessage(
    row: typeof queuedThreadMessages.$inferSelect,
  ): ThreadQueuedMessage {
    return {
      id: row.id,
      input: parseQueuedPromptInput(row.input),
      model: row.model ?? undefined,
      serviceTier: toThreadExecutionServiceTier(row.serviceTier ?? undefined),
      reasoningLevel: toReasoningLevel(row.reasoningLevel),
      sandboxMode: toSandboxMode(row.sandboxMode),
      createdAt: row.createdAt,
    };
  }
}

function parseEnvironmentRecord(
  value: string | null | undefined,
): PersistedEnvironmentRecord | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as PersistedEnvironmentRecord;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.kind === "string" &&
      "state" in parsed
    ) {
      return parsed;
    }
  } catch {
    // Ignore malformed persisted environment records and treat them as missing.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// EventRepository
// ---------------------------------------------------------------------------

export class EventRepository {
  private lastStorageReclaimAt = 0;

  constructor(private db: DbConnection) {}

  private _sqliteClient(): SqlitePragmaClient | null {
    const candidate = (this.db as { $client?: unknown }).$client;
    if (!candidate || typeof candidate !== "object") {
      return null;
    }
    const client = candidate as Partial<SqlitePragmaClient>;
    if (typeof client.pragma !== "function" || typeof client.exec !== "function") {
      return null;
    }
    return client as SqlitePragmaClient;
  }

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

  updateData(id: string, data: ThreadEventData): void {
    this.db
      .update(events)
      .set({ data: JSON.stringify(data) })
      .where(eq(events.id, id))
      .run();
  }

  listByThread(
    threadId: string,
    afterSeq?: number,
    limit?: number,
    excludedTypes?: readonly string[],
  ): ThreadEvent[] {
    const conditions = [eq(events.threadId, threadId)];
    if (afterSeq !== undefined) {
      conditions.push(gt(events.seq, afterSeq));
    }
    if (excludedTypes && excludedTypes.length > 0) {
      conditions.push(notInArray(events.type, [...excludedTypes] as ThreadEventType[]));
    }

    let rows: Array<typeof events.$inferSelect>;
    if (limit !== undefined && afterSeq === undefined) {
      rows = this.db
        .select()
        .from(events)
        .where(and(...conditions))
        .orderBy(desc(events.seq))
        .limit(limit)
        .all()
        .reverse();
    } else {
      let query = this.db
        .select()
        .from(events)
        .where(and(...conditions))
        .orderBy(events.seq);
      if (limit !== undefined) {
        query = query.limit(limit) as typeof query;
      }
      rows = query.all();
    }

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

  getLatestByType(threadId: string, type: ThreadEventType): ThreadEvent | undefined {
    const row = this.db
      .select()
      .from(events)
      .where(and(eq(events.threadId, threadId), eq(events.type, type)))
      .orderBy(desc(events.seq))
      .limit(1)
      .get();
    if (!row) return undefined;
    return {
      id: row.id,
      threadId: row.threadId,
      seq: row.seq,
      type: row.type,
      data: JSON.parse(row.data),
      createdAt: row.createdAt,
    };
  }

  pruneHistoricalNoiseByThread(
    threadId: string,
    keepRecent: number = 600,
  ): number {
    const latestSeq = this.getLatestSeq(threadId);
    if (latestSeq <= 0) return 0;

    const normalizedKeepRecent = Number.isFinite(keepRecent)
      ? Math.max(0, Math.floor(keepRecent))
      : 600;
    const cutoffSeq = latestSeq - normalizedKeepRecent;
    let totalRemoved = 0;

    if (cutoffSeq > 0) {
      const historical = this.db
        .delete(events)
        .where(
          and(
            eq(events.threadId, threadId),
            lte(events.seq, cutoffSeq),
            or(
              like(events.normType, "%delta%"),
              inArray(events.normType, [...PRUNABLE_NOISE_EVENT_NORM_TYPES]),
            ),
          ),
        )
        .run() as { changes?: number };
      totalRemoved += historical.changes ?? 0;
    }

    if (ALWAYS_PRUNABLE_NOISE_EVENT_NORM_TYPES.length > 0) {
      const alwaysPrunable = this.db
        .delete(events)
        .where(
          and(
            eq(events.threadId, threadId),
            inArray(events.normType, [...ALWAYS_PRUNABLE_NOISE_EVENT_NORM_TYPES]),
          ),
        )
        .run() as { changes?: number };
      totalRemoved += alwaysPrunable.changes ?? 0;
    }

    const resolvedAssistantDeltas = this.db
      .delete(events)
      .where(
        and(
          eq(events.threadId, threadId),
          eq(events.normType, "item/agentmessage/delta"),
          sql`EXISTS (
            SELECT 1
            FROM events completed
            WHERE completed.thread_id = events.thread_id
              AND completed.norm_type = 'item/completed'
              AND lower(
                coalesce(
                  json_extract(completed.data, '$.item.type'),
                  json_extract(completed.data, '$.payload.item.type'),
                  json_extract(completed.data, '$.msg.item.type')
                )
              ) = 'agentmessage'
              AND coalesce(
                json_extract(completed.data, '$.item.id'),
                json_extract(completed.data, '$.item_id'),
                json_extract(completed.data, '$.payload.item.id'),
                json_extract(completed.data, '$.payload.item_id'),
                json_extract(completed.data, '$.msg.item.id'),
                json_extract(completed.data, '$.msg.item_id')
              ) = coalesce(
                json_extract(events.data, '$.itemId'),
                json_extract(events.data, '$.item_id'),
                json_extract(events.data, '$.payload.itemId'),
                json_extract(events.data, '$.payload.item_id'),
                json_extract(events.data, '$.msg.item_id'),
                json_extract(events.data, '$.msg.itemId')
              )
          )`,
        ),
      )
      .run() as { changes?: number };
    totalRemoved += resolvedAssistantDeltas.changes ?? 0;

    return totalRemoved;
  }

  reclaimStorageIfNeeded(opts?: {
    force?: boolean;
    ensureIncrementalAutoVacuum?: boolean;
    minFreelistPages?: number;
    maxIncrementalPages?: number;
    minIntervalMs?: number;
  }): {
    ran: boolean;
    fullVacuum: boolean;
    incrementalPages: number;
    freelistPages: number;
    autoVacuumMode: number;
  } {
    const sqlite = this._sqliteClient();
    if (!sqlite) {
      return {
        ran: false,
        fullVacuum: false,
        incrementalPages: 0,
        freelistPages: 0,
        autoVacuumMode: 0,
      };
    }

    const now = Date.now();
    const minIntervalCandidate = opts?.minIntervalMs;
    const minIntervalMs =
      typeof minIntervalCandidate === "number" && Number.isFinite(minIntervalCandidate)
      ? Math.max(0, Math.floor(minIntervalCandidate))
      : STORAGE_RECLAIM_MIN_INTERVAL_MS;
    if (!opts?.force && now - this.lastStorageReclaimAt < minIntervalMs) {
      const autoVacuumMode = Math.floor(readPragmaNumber(sqlite, "auto_vacuum") ?? 0);
      const freelistPages = Math.floor(readPragmaNumber(sqlite, "freelist_count") ?? 0);
      return {
        ran: false,
        fullVacuum: false,
        incrementalPages: 0,
        freelistPages,
        autoVacuumMode,
      };
    }
    this.lastStorageReclaimAt = now;

    let autoVacuumMode = Math.floor(readPragmaNumber(sqlite, "auto_vacuum") ?? 0);
    let fullVacuum = false;
    if (opts?.ensureIncrementalAutoVacuum && autoVacuumMode === 0) {
      sqlite.pragma("auto_vacuum = INCREMENTAL");
      sqlite.exec("VACUUM");
      sqlite.pragma("journal_mode = WAL");
      autoVacuumMode = Math.floor(readPragmaNumber(sqlite, "auto_vacuum") ?? 0);
      fullVacuum = true;
    }

    const minFreelistCandidate = opts?.minFreelistPages;
    const maxIncrementalCandidate = opts?.maxIncrementalPages;
    const minFreelistPages =
      typeof minFreelistCandidate === "number" && Number.isFinite(minFreelistCandidate)
      ? Math.max(0, Math.floor(minFreelistCandidate))
      : STORAGE_RECLAIM_MIN_FREE_PAGES;
    const maxIncrementalPages =
      typeof maxIncrementalCandidate === "number" && Number.isFinite(maxIncrementalCandidate)
      ? Math.max(1, Math.floor(maxIncrementalCandidate))
      : STORAGE_RECLAIM_MAX_INCREMENTAL_PAGES;

    let freelistPages = Math.floor(readPragmaNumber(sqlite, "freelist_count") ?? 0);
    let incrementalPages = 0;
    if (
      autoVacuumMode === 2 &&
      (opts?.force || freelistPages >= minFreelistPages)
    ) {
      incrementalPages = opts?.force
        ? freelistPages
        : Math.min(freelistPages, maxIncrementalPages);
      if (incrementalPages > 0) {
        sqlite.exec(`PRAGMA incremental_vacuum(${incrementalPages})`);
        freelistPages = Math.floor(readPragmaNumber(sqlite, "freelist_count") ?? 0);
      }
    }

    return {
      ran: fullVacuum || incrementalPages > 0,
      fullVacuum,
      incrementalPages,
      freelistPages,
      autoVacuumMode,
    };
  }

  deleteByThreadId(threadId: string): void {
    this.db.delete(events).where(eq(events.threadId, threadId)).run();
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
