import { eq, and, sql, gt, isNull, desc, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  Project,
  Task,
  TaskStatus,
  TaskCloseReason,
  TaskDependency,
  TaskDependencyType,
  TaskEvent,
  Thread,
  ThreadStatus,
  ThreadEvent,
  ThreadEventData,
  ThreadEventType,
  ThreadExecutionOptions,
} from "@beanbag/core";
import type { DbConnection } from "./connection.js";
import {
  projects,
  threads,
  events,
  tasks,
  taskDependencies,
  taskEvents,
} from "./schema.js";

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

function parseThreadExecutionOptions(
  data: unknown,
): ThreadExecutionOptions | undefined {
  const root = asRecord(data);
  const execution = asRecord(root?.execution);
  if (!execution) return undefined;

  const model = getStringField(execution, "model");
  const reasoningLevel = getStringField(execution, "reasoningLevel");
  const sandboxMode = getStringField(execution, "sandboxMode");
  const approvalPolicy = getStringField(execution, "approvalPolicy");

  const hasAny =
    Boolean(model) ||
    Boolean(reasoningLevel) ||
    Boolean(sandboxMode) ||
    Boolean(approvalPolicy);
  if (!hasAny) return undefined;

  return {
    ...(model ? { model } : {}),
    ...(reasoningLevel ? { reasoningLevel: reasoningLevel as ThreadExecutionOptions["reasoningLevel"] } : {}),
    ...(sandboxMode ? { sandboxMode: sandboxMode as ThreadExecutionOptions["sandboxMode"] } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
  };
}

function normalizeTaskStatus(status: string): TaskStatus {
  if (
    status === "open" ||
    status === "in_progress" ||
    status === "blocked" ||
    status === "closed"
  ) {
    return status;
  }
  return "open";
}

function normalizeTaskCloseReason(
  closeReason: string | null | undefined,
): TaskCloseReason | undefined {
  if (
    closeReason === "completed" ||
    closeReason === "failed" ||
    closeReason === "canceled"
  ) {
    return closeReason;
  }
  return undefined;
}

function normalizeTaskDependencyType(type: string): TaskDependencyType {
  if (
    type === "blocks" ||
    type === "parent-child" ||
    type === "related"
  ) {
    return type;
  }
  return "related";
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

    return {
      ...execution,
      source: row.normType as ThreadExecutionOptions["source"],
      seq: row.seq,
    };
  }
}

// ---------------------------------------------------------------------------
// TaskRepository
// ---------------------------------------------------------------------------

export class TaskRepository {
  constructor(private db: DbConnection) {}

  create(data: {
    projectId: string;
    title: string;
    description?: string;
    parentId?: string;
  }): Task {
    const now = Date.now();
    const row = {
      id: nanoid(),
      projectId: data.projectId,
      title: data.title,
      description: data.description ?? null,
      status: "open",
      closeReason: null,
      assignee: null,
      closedAt: null,
      resultSummary: null,
      createdAt: now,
      updatedAt: now,
    } as const;

    return this.withTransaction((tx) => {
      tx.insert(tasks).values(row).run();
      this.appendTaskEventTx(tx, row.id, "task.created", {
        projectId: row.projectId,
        title: row.title,
      });

      if (data.parentId) {
        const parent = tx
          .select()
          .from(tasks)
          .where(eq(tasks.id, data.parentId))
          .get();
        if (!parent) {
          throw new Error(`Parent task ${data.parentId} not found`);
        }
        if (parent.projectId !== row.projectId) {
          throw new Error("Parent task must belong to the same project");
        }
        const dependency = {
          taskId: row.id,
          dependsOnTaskId: data.parentId,
          type: "parent-child" as const,
          createdAt: now,
        };
        tx.insert(taskDependencies).values(dependency).run();
        this.appendTaskEventTx(tx, row.id, "task.dependency_added", {
          dependsOnTaskId: dependency.dependsOnTaskId,
          type: dependency.type,
        });
      }

      return this.rowToTask(row);
    });
  }

  getById(id: string): Task | undefined {
    const row = this.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .get();
    if (!row) return undefined;
    return this.rowToTask(row);
  }

  list(filters?: {
    projectId?: string;
    status?: TaskStatus;
    parentId?: string;
  }): Task[] {
    if (filters?.parentId) {
      const conditions = [
        eq(taskDependencies.dependsOnTaskId, filters.parentId),
        eq(taskDependencies.type, "parent-child"),
      ];
      if (filters.projectId) {
        conditions.push(eq(tasks.projectId, filters.projectId));
      }
      if (filters.status) {
        conditions.push(eq(tasks.status, filters.status));
      }

      const rows = this.db
        .select({ task: tasks })
        .from(tasks)
        .innerJoin(taskDependencies, eq(taskDependencies.taskId, tasks.id))
        .where(and(...conditions))
        .orderBy(desc(tasks.updatedAt))
        .all();

      return rows.map((row) => this.rowToTask(row.task));
    }

    const conditions = [];
    if (filters?.projectId) {
      conditions.push(eq(tasks.projectId, filters.projectId));
    }
    if (filters?.status) {
      conditions.push(eq(tasks.status, filters.status));
    }

    let query = this.db.select().from(tasks);
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    const rows = query.orderBy(desc(tasks.updatedAt)).all();
    return rows.map((row) => this.rowToTask(row));
  }

  getReady(projectId: string): Task[] {
    const rows = this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, projectId),
          eq(tasks.status, "open"),
          sql`(${tasks.assignee} IS NULL OR ${tasks.assignee} = '')`,
          sql`NOT EXISTS (
            SELECT 1
            FROM task_dependencies td
            JOIN tasks blocker ON blocker.id = td.depends_on_task_id
            WHERE td.task_id = ${tasks.id}
              AND td.type = 'blocks'
              AND blocker.status IN ('open', 'in_progress', 'blocked')
          )`,
        ),
      )
      .orderBy(desc(tasks.updatedAt))
      .all();

    return rows.map((row) => this.rowToTask(row));
  }

  update(
    id: string,
    data: {
      title?: string;
      description?: string;
      status?: TaskStatus;
      closeReason?: TaskCloseReason;
      resultSummary?: string;
      assignee?: string;
    },
  ): Task | undefined {
    return this.withTransaction((tx) => {
      const existing = tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, id))
        .get();
      if (!existing) return undefined;

      const currentStatus = normalizeTaskStatus(existing.status);
      const nextStatus = data.status ?? currentStatus;
      const updates: Record<string, unknown> = {
        updatedAt: Date.now(),
      };

      if (data.title !== undefined) updates.title = data.title;
      if (data.description !== undefined) updates.description = data.description;
      if (data.resultSummary !== undefined) {
        updates.resultSummary = data.resultSummary;
      }
      if (data.assignee !== undefined) {
        updates.assignee = data.assignee;
      }

      if (currentStatus === "closed" && nextStatus !== "closed") {
        throw new Error("Closed tasks cannot transition back to a non-closed status");
      }

      if (nextStatus === "closed") {
        const closeReason =
          data.closeReason ?? normalizeTaskCloseReason(existing.closeReason);
        if (!closeReason) {
          throw new Error("closeReason is required when closing a task");
        }
        updates.status = "closed";
        updates.closeReason = closeReason;
        updates.closedAt = existing.closedAt ?? Date.now();
      } else {
        if (data.closeReason !== undefined) {
          throw new Error("closeReason can only be set when status is 'closed'");
        }
        if (data.status !== undefined) {
          updates.status = data.status;
        }
        if (data.status && data.status !== "closed") {
          updates.closeReason = null;
          updates.closedAt = null;
        }
      }

      tx.update(tasks).set(updates).where(eq(tasks.id, id)).run();

      const updated = tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, id))
        .get();
      if (!updated) return undefined;

      this.appendTaskEventTx(tx, id, "task.updated", {
        updates: data,
      });
      return this.rowToTask(updated);
    });
  }

  assign(
    id: string,
    assignee: string,
  ): { task?: Task; alreadyAssignedTo?: string } | undefined {
    return this.withTransaction((tx) => {
      const existing = tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, id))
        .get();
      if (!existing) return undefined;

      if (normalizeTaskStatus(existing.status) === "closed") {
        throw new Error("Closed tasks cannot be assigned");
      }

      const nextStatus =
        normalizeTaskStatus(existing.status) === "open"
          ? "in_progress"
          : existing.status;

      const result = tx
        .update(tasks)
        .set({
          assignee,
          status: nextStatus,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(tasks.id, id),
            sql`(${tasks.assignee} IS NULL OR ${tasks.assignee} = '')`,
          ),
        )
        .run();

      const changes = Number((result as { changes?: number }).changes ?? 0);
      if (changes === 0) {
        const current = tx
          .select({ assignee: tasks.assignee })
          .from(tasks)
          .where(eq(tasks.id, id))
          .get();
        return { alreadyAssignedTo: current?.assignee ?? "" };
      }

      const updated = tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, id))
        .get();
      if (!updated) return undefined;

      this.appendTaskEventTx(tx, id, "task.assigned", {
        assignee,
      });
      return { task: this.rowToTask(updated) };
    });
  }

  addDependency(data: {
    taskId: string;
    dependsOnTaskId: string;
    type: TaskDependencyType;
  }): TaskDependency | undefined {
    return this.withTransaction((tx) => {
      const task = tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, data.taskId))
        .get();
      if (!task) return undefined;

      const dependsOnTask = tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, data.dependsOnTaskId))
        .get();
      if (!dependsOnTask) return undefined;

      if (task.projectId !== dependsOnTask.projectId) {
        throw new Error("Dependencies must stay within the same project");
      }

      if (data.type === "parent-child") {
        if (data.taskId === data.dependsOnTaskId) {
          throw new Error("parent-child dependency cannot point to itself");
        }
        if (
          this.hasParentChildPathTx(tx, data.dependsOnTaskId, data.taskId)
        ) {
          throw new Error("parent-child dependency would create a cycle");
        }
      }

      const row = {
        taskId: data.taskId,
        dependsOnTaskId: data.dependsOnTaskId,
        type: data.type,
        createdAt: Date.now(),
      } as const;
      tx.insert(taskDependencies).values(row).onConflictDoNothing().run();

      this.appendTaskEventTx(tx, data.taskId, "task.dependency_added", {
        dependsOnTaskId: data.dependsOnTaskId,
        type: data.type,
      });
      return this.rowToTaskDependency(row);
    });
  }

  removeDependency(data: {
    taskId: string;
    dependsOnTaskId: string;
    type: TaskDependencyType;
  }): boolean {
    return this.withTransaction((tx) => {
      const result = tx
        .delete(taskDependencies)
        .where(
          and(
            eq(taskDependencies.taskId, data.taskId),
            eq(taskDependencies.dependsOnTaskId, data.dependsOnTaskId),
            eq(taskDependencies.type, data.type),
          ),
        )
        .run();

      const changes = Number((result as { changes?: number }).changes ?? 0);
      if (changes > 0) {
        this.appendTaskEventTx(tx, data.taskId, "task.dependency_removed", {
          dependsOnTaskId: data.dependsOnTaskId,
          type: data.type,
        });
      }
      return changes > 0;
    });
  }

  listDependencies(
    taskId: string,
    type?: TaskDependencyType,
  ): TaskDependency[] {
    const conditions = [eq(taskDependencies.taskId, taskId)];
    if (type) {
      conditions.push(eq(taskDependencies.type, type));
    }
    const rows = this.db
      .select()
      .from(taskDependencies)
      .where(and(...conditions))
      .all();

    return rows.map((row) => this.rowToTaskDependency(row));
  }

  listEvents(taskId: string, afterSeq?: number): TaskEvent[] {
    const conditions = [eq(taskEvents.taskId, taskId)];
    if (afterSeq !== undefined) {
      conditions.push(gt(taskEvents.seq, afterSeq));
    }
    const rows = this.db
      .select()
      .from(taskEvents)
      .where(and(...conditions))
      .orderBy(taskEvents.seq)
      .all();

    return rows.map((row) => {
      return {
        id: row.id,
        taskId: row.taskId,
        seq: row.seq,
        type: row.type,
        data: JSON.parse(row.data),
        createdAt: row.createdAt,
      };
    });
  }

  private withTransaction<T>(work: (tx: any) => T): T {
    return (this.db as any).transaction(work);
  }

  private appendTaskEventTx(
    tx: any,
    taskId: string,
    type: string,
    data: Record<string, unknown>,
  ): void {
    const latest = tx
      .select({ maxSeq: sql<number>`MAX(${taskEvents.seq})` })
      .from(taskEvents)
      .where(eq(taskEvents.taskId, taskId))
      .get();

    const row = {
      id: nanoid(),
      taskId,
      seq: (latest?.maxSeq ?? 0) + 1,
      type,
      data: JSON.stringify(data),
      createdAt: Date.now(),
    };
    tx.insert(taskEvents).values(row).run();
  }

  private hasParentChildPathTx(
    tx: any,
    startTaskId: string,
    targetTaskId: string,
  ): boolean {
    if (startTaskId === targetTaskId) return true;

    const visited = new Set<string>();
    const queue = [startTaskId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === targetTaskId) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      const children = tx
        .select({ taskId: taskDependencies.taskId })
        .from(taskDependencies)
        .where(
          and(
            eq(taskDependencies.dependsOnTaskId, current),
            eq(taskDependencies.type, "parent-child"),
          ),
        )
        .all();
      for (const child of children) {
        if (!visited.has(child.taskId)) {
          queue.push(child.taskId);
        }
      }
    }

    return false;
  }

  private rowToTask(row: typeof tasks.$inferSelect): Task {
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      ...(row.description ? { description: row.description } : {}),
      status: normalizeTaskStatus(row.status),
      ...(normalizeTaskCloseReason(row.closeReason)
        ? { closeReason: normalizeTaskCloseReason(row.closeReason) }
        : {}),
      ...(row.assignee ? { assignee: row.assignee } : {}),
      ...(row.closedAt !== null ? { closedAt: row.closedAt } : {}),
      ...(row.resultSummary ? { resultSummary: row.resultSummary } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowToTaskDependency(
    row: typeof taskDependencies.$inferSelect,
  ): TaskDependency {
    return {
      taskId: row.taskId,
      dependsOnTaskId: row.dependsOnTaskId,
      type: normalizeTaskDependencyType(row.type),
      createdAt: row.createdAt,
    };
  }
}
