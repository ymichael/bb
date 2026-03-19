import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lte,
  sql,
} from "drizzle-orm";
import { nanoid } from "nanoid";
import { assertNever } from "@bb/core";
import type { DbConnection } from "./connection.js";
import {
  environmentDaemonCommands,
  environmentDaemonCursors,
  environmentDaemonSessions,
} from "./schema.js";

export type EnvironmentDaemonSessionStatus =
  | "active"
  | "expired"
  | "closed"
  | "replaced";

export type EnvironmentDaemonSessionCloseReason =
  | "agent_shutdown"
  | "server_shutdown"
  | "lease_expired"
  | "newer_session"
  | "migration"
  | "internal_error";

export interface EnvironmentDaemonCursorPosition {
  generation: number;
  sequence: number;
}

export interface EnvironmentDaemonSessionRecord {
  id: string;
  environmentId: string;
  agentId: string;
  agentInstanceId: string;
  protocolVersion: number;
  workerName?: string;
  workerVersion?: string;
  workerBuildId?: string;
  providerMetadata?: unknown;
  selectedCapabilities?: unknown;
  controlBaseUrl?: string;
  controlAuthToken?: string;
  status: EnvironmentDaemonSessionStatus;
  leaseExpiresAt: number;
  lastHeartbeatAt?: number;
  closedAt?: number;
  closeReason?: EnvironmentDaemonSessionCloseReason;
  createdAt: number;
  updatedAt: number;
}

export interface EnvironmentDaemonCursorRecord
  extends EnvironmentDaemonCursorPosition {
  threadId: string;
  updatedAt: number;
}

export type EnvironmentDaemonCursorAdvanceResult =
  | {
      advanced: true;
      cursor: EnvironmentDaemonCursorRecord;
    }
  | {
      advanced: false;
      cursor?: EnvironmentDaemonCursorRecord;
    };

export type EnvironmentDaemonCommandState =
  | "queued"
  | "sent"
  | "received"
  | "started"
  | "completed"
  | "failed"
  | "cancelled";

export interface EnvironmentDaemonCommandRecord {
  id: string;
  threadId: string;
  sessionId?: string;
  commandCursor: number;
  commandType: string;
  payload: unknown;
  state: EnvironmentDaemonCommandState;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateEnvironmentDaemonSessionInput {
  id?: string;
  environmentId: string;
  agentId: string;
  agentInstanceId: string;
  protocolVersion: number;
  workerName?: string;
  workerVersion?: string;
  workerBuildId?: string;
  providerMetadata?: unknown;
  selectedCapabilities?: unknown;
  controlBaseUrl?: string;
  controlAuthToken?: string;
  leaseExpiresAt: number;
  now?: number;
}

export interface ReplaceActiveEnvironmentDaemonSessionInput
  extends CreateEnvironmentDaemonSessionInput {}

export interface EnqueueEnvironmentDaemonCommandInput {
  id?: string;
  threadId: string;
  commandType: string;
  payload: unknown;
  sessionId?: string;
  now?: number;
}

const PENDING_ENVIRONMENT_DAEMON_COMMAND_STATES: readonly EnvironmentDaemonCommandState[] = [
  "queued",
  "sent",
  "received",
  "started",
];

function isEnvironmentDaemonSessionStatus(
  value: string,
): value is EnvironmentDaemonSessionStatus {
  return (
    value === "active" ||
    value === "expired" ||
    value === "closed" ||
    value === "replaced"
  );
}

function normalizeEnvironmentDaemonSessionStatus(
  value: string,
): EnvironmentDaemonSessionStatus {
  if (isEnvironmentDaemonSessionStatus(value)) return value;
  throw new Error(`Invalid persisted environment-daemon session status: ${value}`);
}

function isEnvironmentDaemonSessionCloseReason(
  value: string,
): value is EnvironmentDaemonSessionCloseReason {
  return (
    value === "agent_shutdown" ||
    value === "server_shutdown" ||
    value === "lease_expired" ||
    value === "newer_session" ||
    value === "migration" ||
    value === "internal_error"
  );
}

function normalizeEnvironmentDaemonSessionCloseReason(
  value: string | null | undefined,
): EnvironmentDaemonSessionCloseReason | undefined {
  if (!value) return undefined;
  if (isEnvironmentDaemonSessionCloseReason(value)) return value;
  throw new Error(`Invalid persisted environment-daemon session close reason: ${value}`);
}

function isEnvironmentDaemonCommandState(
  value: string,
): value is EnvironmentDaemonCommandState {
  return (
    value === "queued" ||
    value === "sent" ||
    value === "received" ||
    value === "started" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function normalizeEnvironmentDaemonCommandState(
  value: string,
): EnvironmentDaemonCommandState {
  if (isEnvironmentDaemonCommandState(value)) return value;
  throw new Error(`Invalid persisted environment-daemon command state: ${value}`);
}

function parseJsonField(value: string, fieldName: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid persisted ${fieldName} JSON`);
  }
}

function rowToEnvironmentDaemonSessionRecord(
  row: typeof environmentDaemonSessions.$inferSelect,
): EnvironmentDaemonSessionRecord {
  return {
    id: row.id,
    environmentId: row.environmentId,
    agentId: row.agentId,
    agentInstanceId: row.agentInstanceId,
    protocolVersion: row.protocolVersion,
    ...(row.workerName !== null ? { workerName: row.workerName } : {}),
    ...(row.workerVersion !== null ? { workerVersion: row.workerVersion } : {}),
    ...(row.workerBuildId !== null ? { workerBuildId: row.workerBuildId } : {}),
    ...(row.providerMetadata !== null
      ? { providerMetadata: parseJsonField(row.providerMetadata, "environment-daemon provider metadata") }
      : {}),
    ...(row.selectedCapabilities !== null
      ? {
          selectedCapabilities: parseJsonField(
            row.selectedCapabilities,
            "environment-daemon selected capabilities",
          ),
        }
      : {}),
    ...(row.controlBaseUrl !== null ? { controlBaseUrl: row.controlBaseUrl } : {}),
    ...(row.controlAuthToken !== null ? { controlAuthToken: row.controlAuthToken } : {}),
    status: normalizeEnvironmentDaemonSessionStatus(row.status),
    leaseExpiresAt: row.leaseExpiresAt,
    ...(row.lastHeartbeatAt !== null ? { lastHeartbeatAt: row.lastHeartbeatAt } : {}),
    ...(row.closedAt !== null ? { closedAt: row.closedAt } : {}),
    ...(row.closeReason !== null
      ? { closeReason: normalizeEnvironmentDaemonSessionCloseReason(row.closeReason) }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isEnvironmentDaemonSessionLeaseActive(
  session: Pick<EnvironmentDaemonSessionRecord, "status" | "leaseExpiresAt">,
  now: number,
): boolean {
  return session.status === "active" && session.leaseExpiresAt > now;
}

function rowToEnvironmentDaemonCursorRecord(
  row: typeof environmentDaemonCursors.$inferSelect,
): EnvironmentDaemonCursorRecord {
  return {
    threadId: row.threadId,
    generation: row.generation,
    sequence: row.sequence,
    updatedAt: row.updatedAt,
  };
}

function rowToEnvironmentDaemonCommandRecord(
  row: typeof environmentDaemonCommands.$inferSelect,
): EnvironmentDaemonCommandRecord {
  return {
    id: row.id,
    threadId: row.threadId,
    ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
    commandCursor: row.commandCursor,
    commandType: row.commandType,
    payload: parseJsonField(row.payload, "environment-daemon command payload"),
    state: normalizeEnvironmentDaemonCommandState(row.state),
    ...(row.result !== null
      ? { result: parseJsonField(row.result, "environment-daemon command result") }
      : {}),
    ...(row.errorCode !== null ? { errorCode: row.errorCode } : {}),
    ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sameCursor(
  left: EnvironmentDaemonCursorPosition | undefined,
  right: EnvironmentDaemonCursorPosition | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.generation === right.generation && left.sequence === right.sequence;
}

function canAdvanceCursorTo(
  current: EnvironmentDaemonCursorPosition | undefined,
  next: EnvironmentDaemonCursorPosition,
): boolean {
  if (!current) {
    return next.generation >= 0 && next.sequence >= 0;
  }
  if (next.generation < current.generation) return false;
  if (next.generation === current.generation) {
    return next.sequence === current.sequence + 1;
  }
  return next.generation === current.generation + 1 && next.sequence >= 0;
}

function resolveEnvironmentDaemonCommandStateUpdate(
  current: EnvironmentDaemonCommandState,
  target: EnvironmentDaemonCommandState,
): "apply" | "noop" | "conflict" {
  if (current === target) {
    return "noop";
  }

  switch (current) {
    case "queued":
      switch (target) {
        case "sent":
        case "received":
        case "started":
        case "completed":
        case "failed":
        case "cancelled":
          return "apply";
        case "queued":
          return "noop";
        default:
          return assertNever(target);
      }
    case "sent":
      switch (target) {
        case "queued":
          return "noop";
        case "received":
        case "started":
        case "completed":
        case "failed":
        case "cancelled":
          return "apply";
        case "sent":
          return "noop";
        default:
          return assertNever(target);
      }
    case "received":
      switch (target) {
        case "queued":
        case "sent":
          return "noop";
        case "started":
        case "completed":
        case "failed":
        case "cancelled":
          return "apply";
        case "received":
          return "noop";
        default:
          return assertNever(target);
      }
    case "started":
      switch (target) {
        case "queued":
        case "sent":
        case "received":
          return "noop";
        case "completed":
        case "failed":
        case "cancelled":
          return "apply";
        case "started":
          return "noop";
        default:
          return assertNever(target);
      }
    case "completed":
      switch (target) {
        case "queued":
        case "sent":
        case "received":
        case "started":
          return "noop";
        case "completed":
          return "noop";
        case "failed":
        case "cancelled":
          return "conflict";
        default:
          return assertNever(target);
      }
    case "failed":
      switch (target) {
        case "queued":
        case "sent":
        case "received":
        case "started":
          return "noop";
        case "failed":
          return "noop";
        case "completed":
        case "cancelled":
          return "conflict";
        default:
          return assertNever(target);
      }
    case "cancelled":
      switch (target) {
        case "queued":
        case "sent":
        case "received":
        case "started":
          return "noop";
        case "cancelled":
          return "noop";
        case "completed":
        case "failed":
          return "conflict";
        default:
          return assertNever(target);
      }
    default:
      return assertNever(current);
  }
}

export class EnvironmentDaemonSessionRepository {
  constructor(private db: DbConnection) {}

  create(args: CreateEnvironmentDaemonSessionInput): EnvironmentDaemonSessionRecord {
    const now = args.now ?? Date.now();
    const row = {
      id: args.id ?? nanoid(),
      environmentId: args.environmentId,
      agentId: args.agentId,
      agentInstanceId: args.agentInstanceId,
      protocolVersion: args.protocolVersion,
      workerName: args.workerName ?? null,
      workerVersion: args.workerVersion ?? null,
      workerBuildId: args.workerBuildId ?? null,
      providerMetadata:
        args.providerMetadata !== undefined ? JSON.stringify(args.providerMetadata) : null,
      selectedCapabilities:
        args.selectedCapabilities !== undefined
          ? JSON.stringify(args.selectedCapabilities)
          : null,
      controlBaseUrl: args.controlBaseUrl ?? null,
      controlAuthToken: args.controlAuthToken ?? null,
      status: "active",
      leaseExpiresAt: args.leaseExpiresAt,
      lastHeartbeatAt: null,
      closedAt: null,
      closeReason: null,
      createdAt: now,
      updatedAt: now,
    } satisfies typeof environmentDaemonSessions.$inferInsert;
    this.db.insert(environmentDaemonSessions).values(row).run();
    return rowToEnvironmentDaemonSessionRecord(row);
  }

  getById(id: string): EnvironmentDaemonSessionRecord | undefined {
    const row = this.db
      .select()
      .from(environmentDaemonSessions)
      .where(eq(environmentDaemonSessions.id, id))
      .get();
    return row ? rowToEnvironmentDaemonSessionRecord(row) : undefined;
  }

  getActiveByEnvironmentId(
    environmentId: string,
    now: number = Date.now(),
  ): EnvironmentDaemonSessionRecord | undefined {
    const row = this.db
      .select()
      .from(environmentDaemonSessions)
      .where(
        and(
          eq(environmentDaemonSessions.environmentId, environmentId),
          eq(environmentDaemonSessions.status, "active"),
          gt(environmentDaemonSessions.leaseExpiresAt, now),
        ),
      )
      .orderBy(desc(environmentDaemonSessions.updatedAt))
      .get();
    return row ? rowToEnvironmentDaemonSessionRecord(row) : undefined;
  }

  getLatestByEnvironmentId(environmentId: string): EnvironmentDaemonSessionRecord | undefined {
    const row = this.db
      .select()
      .from(environmentDaemonSessions)
      .where(eq(environmentDaemonSessions.environmentId, environmentId))
      .orderBy(desc(environmentDaemonSessions.updatedAt))
      .get();
    return row ? rowToEnvironmentDaemonSessionRecord(row) : undefined;
  }

  listByEnvironmentId(environmentId: string): EnvironmentDaemonSessionRecord[] {
    return this.db
      .select()
      .from(environmentDaemonSessions)
      .where(eq(environmentDaemonSessions.environmentId, environmentId))
      .orderBy(desc(environmentDaemonSessions.updatedAt), desc(environmentDaemonSessions.createdAt))
      .all()
      .map(rowToEnvironmentDaemonSessionRecord);
  }

  listActive(now: number = Date.now()): EnvironmentDaemonSessionRecord[] {
    return this.db
      .select()
      .from(environmentDaemonSessions)
      .where(
        and(
          eq(environmentDaemonSessions.status, "active"),
          gt(environmentDaemonSessions.leaseExpiresAt, now),
        ),
      )
      .orderBy(desc(environmentDaemonSessions.updatedAt))
      .all()
      .map(rowToEnvironmentDaemonSessionRecord);
  }

  listExpiringBefore(timestamp: number): EnvironmentDaemonSessionRecord[] {
    return this.db
      .select()
      .from(environmentDaemonSessions)
      .where(
        and(
          eq(environmentDaemonSessions.status, "active"),
          lte(environmentDaemonSessions.leaseExpiresAt, timestamp),
        ),
      )
      .orderBy(asc(environmentDaemonSessions.leaseExpiresAt))
      .all()
      .map(rowToEnvironmentDaemonSessionRecord);
  }

  closeAllActive(args: {
    reason: Exclude<EnvironmentDaemonSessionCloseReason, "lease_expired" | "newer_session">;
    now?: number;
  }): number {
    const now = args.now ?? Date.now();
    const result = this.db
      .update(environmentDaemonSessions)
      .set({
        status: "closed",
        closedAt: now,
        closeReason: args.reason,
        updatedAt: now,
      })
      .where(eq(environmentDaemonSessions.status, "active"))
      .run();
    return Number(result.changes ?? 0);
  }

  touchHeartbeat(args: {
    sessionId: string;
    leaseExpiresAt: number;
    heartbeatAt: number;
  }): EnvironmentDaemonSessionRecord | undefined {
    return this.db.transaction((tx) => {
      const row = tx.select().from(environmentDaemonSessions)
        .where(eq(environmentDaemonSessions.id, args.sessionId)).get();
      if (!row) return undefined;
      const existing = rowToEnvironmentDaemonSessionRecord(row);
      if (!isEnvironmentDaemonSessionLeaseActive(existing, args.heartbeatAt)) {
        return existing;
      }
      tx.update(environmentDaemonSessions)
        .set({
          leaseExpiresAt: args.leaseExpiresAt,
          lastHeartbeatAt: args.heartbeatAt,
          updatedAt: args.heartbeatAt,
        })
        .where(eq(environmentDaemonSessions.id, args.sessionId))
        .run();
      const updated = tx.select().from(environmentDaemonSessions)
        .where(eq(environmentDaemonSessions.id, args.sessionId)).get();
      return updated ? rowToEnvironmentDaemonSessionRecord(updated) : undefined;
    });
  }

  markExpired(sessionId: string, now: number = Date.now()): EnvironmentDaemonSessionRecord | undefined {
    return this.db.transaction((tx) => {
      const row = tx.select().from(environmentDaemonSessions)
        .where(eq(environmentDaemonSessions.id, sessionId)).get();
      if (!row) return undefined;
      const existing = rowToEnvironmentDaemonSessionRecord(row);
      if (existing.status === "expired") return existing;
      if (existing.status !== "active") return existing;
      tx.update(environmentDaemonSessions)
        .set({
          status: "expired",
          closedAt: now,
          closeReason: "lease_expired",
          updatedAt: now,
        })
        .where(eq(environmentDaemonSessions.id, sessionId))
        .run();
      const updated = tx.select().from(environmentDaemonSessions)
        .where(eq(environmentDaemonSessions.id, sessionId)).get();
      return updated ? rowToEnvironmentDaemonSessionRecord(updated) : undefined;
    });
  }

  markClosed(args: {
    sessionId: string;
    reason: Exclude<EnvironmentDaemonSessionCloseReason, "lease_expired" | "newer_session">;
    now?: number;
  }): EnvironmentDaemonSessionRecord | undefined {
    return this.db.transaction((tx) => {
      const row = tx.select().from(environmentDaemonSessions)
        .where(eq(environmentDaemonSessions.id, args.sessionId)).get();
      if (!row) return undefined;
      const existing = rowToEnvironmentDaemonSessionRecord(row);
      if (existing.status === "closed") return existing;
      if (existing.status === "replaced") return existing;
      const now = args.now ?? Date.now();
      tx.update(environmentDaemonSessions)
        .set({
          status: "closed",
          closedAt: now,
          closeReason: args.reason,
          updatedAt: now,
        })
        .where(eq(environmentDaemonSessions.id, args.sessionId))
        .run();
      const updated = tx.select().from(environmentDaemonSessions)
        .where(eq(environmentDaemonSessions.id, args.sessionId)).get();
      return updated ? rowToEnvironmentDaemonSessionRecord(updated) : undefined;
    });
  }

  markReplaced(args: {
    sessionId: string;
    now?: number;
  }): EnvironmentDaemonSessionRecord | undefined {
    return this.db.transaction((tx) => {
      const row = tx.select().from(environmentDaemonSessions)
        .where(eq(environmentDaemonSessions.id, args.sessionId)).get();
      if (!row) return undefined;
      const existing = rowToEnvironmentDaemonSessionRecord(row);
      if (existing.status === "replaced") return existing;
      if (existing.status === "closed") return existing;
      const now = args.now ?? Date.now();
      tx.update(environmentDaemonSessions)
        .set({
          status: "replaced",
          closedAt: now,
          closeReason: "newer_session",
          updatedAt: now,
        })
        .where(eq(environmentDaemonSessions.id, args.sessionId))
        .run();
      const updated = tx.select().from(environmentDaemonSessions)
        .where(eq(environmentDaemonSessions.id, args.sessionId)).get();
      return updated ? rowToEnvironmentDaemonSessionRecord(updated) : undefined;
    });
  }

  replaceActiveForEnvironment(args: {
    environmentId: string;
    nextSession: ReplaceActiveEnvironmentDaemonSessionInput;
    now?: number;
  }): { replaced?: EnvironmentDaemonSessionRecord; active: EnvironmentDaemonSessionRecord } {
    const now = args.now ?? args.nextSession.now ?? Date.now();
    return this.db.transaction((tx) => {
      const existingRow = tx
        .select()
        .from(environmentDaemonSessions)
        .where(
          and(
            eq(environmentDaemonSessions.environmentId, args.environmentId),
            eq(environmentDaemonSessions.status, "active"),
          ),
        )
        .orderBy(desc(environmentDaemonSessions.updatedAt))
        .get();

      let replaced: EnvironmentDaemonSessionRecord | undefined;
      if (existingRow) {
        tx
          .update(environmentDaemonSessions)
          .set({
            status: "replaced",
            closedAt: now,
            closeReason: "newer_session",
            updatedAt: now,
          })
          .where(eq(environmentDaemonSessions.id, existingRow.id))
          .run();
        replaced = rowToEnvironmentDaemonSessionRecord({
          ...existingRow,
          status: "replaced",
          closedAt: now,
          closeReason: "newer_session",
          updatedAt: now,
        });
      }

      const inserted = {
        id: args.nextSession.id ?? nanoid(),
        environmentId: args.nextSession.environmentId ?? args.environmentId,
        agentId: args.nextSession.agentId,
        agentInstanceId: args.nextSession.agentInstanceId,
        protocolVersion: args.nextSession.protocolVersion,
        workerName: args.nextSession.workerName ?? null,
        workerVersion: args.nextSession.workerVersion ?? null,
        workerBuildId: args.nextSession.workerBuildId ?? null,
        providerMetadata:
          args.nextSession.providerMetadata !== undefined
            ? JSON.stringify(args.nextSession.providerMetadata)
            : null,
        selectedCapabilities:
          args.nextSession.selectedCapabilities !== undefined
            ? JSON.stringify(args.nextSession.selectedCapabilities)
            : null,
        controlBaseUrl: args.nextSession.controlBaseUrl ?? null,
        controlAuthToken: args.nextSession.controlAuthToken ?? null,
        status: "active",
        leaseExpiresAt: args.nextSession.leaseExpiresAt,
        lastHeartbeatAt: null,
        closedAt: null,
        closeReason: null,
        createdAt: now,
        updatedAt: now,
      } satisfies typeof environmentDaemonSessions.$inferInsert;
      tx.insert(environmentDaemonSessions).values(inserted).run();

      return {
        ...(replaced ? { replaced } : {}),
        active: rowToEnvironmentDaemonSessionRecord(inserted),
      };
    });
  }
}

export class EnvironmentDaemonCursorRepository {
  constructor(private db: DbConnection) {}

  getByThreadId(threadId: string): EnvironmentDaemonCursorRecord | undefined {
    const row = this.db
      .select()
      .from(environmentDaemonCursors)
      .where(eq(environmentDaemonCursors.threadId, threadId))
      .get();
    return row ? rowToEnvironmentDaemonCursorRecord(row) : undefined;
  }

  deleteByThreadId(threadId: string): void {
    this.db
      .delete(environmentDaemonCursors)
      .where(eq(environmentDaemonCursors.threadId, threadId))
      .run();
  }

  upsert(
    threadId: string,
    cursor: EnvironmentDaemonCursorPosition,
    now: number = Date.now(),
  ): EnvironmentDaemonCursorRecord {
    return this.db.transaction((tx) => {
      const existing = tx.select().from(environmentDaemonCursors)
        .where(eq(environmentDaemonCursors.threadId, threadId)).get();
      if (!existing) {
        const row = {
          threadId,
          generation: cursor.generation,
          sequence: cursor.sequence,
          updatedAt: now,
        } satisfies typeof environmentDaemonCursors.$inferInsert;
        tx.insert(environmentDaemonCursors).values(row).run();
        return rowToEnvironmentDaemonCursorRecord(row);
      }

      tx.update(environmentDaemonCursors)
        .set({
          generation: cursor.generation,
          sequence: cursor.sequence,
          updatedAt: now,
        })
        .where(eq(environmentDaemonCursors.threadId, threadId))
        .run();
      const updated = tx.select().from(environmentDaemonCursors)
        .where(eq(environmentDaemonCursors.threadId, threadId)).get();
      return rowToEnvironmentDaemonCursorRecord(updated!);
    });
  }

  advanceIfNext(args: {
    threadId: string;
    expectedCurrent?: EnvironmentDaemonCursorPosition;
    next: EnvironmentDaemonCursorPosition;
    now?: number;
  }): EnvironmentDaemonCursorAdvanceResult {
    return this.db.transaction((tx) => {
      const now = args.now ?? Date.now();
      const currentRow = tx.select().from(environmentDaemonCursors)
        .where(eq(environmentDaemonCursors.threadId, args.threadId)).get();
      const current = currentRow ? rowToEnvironmentDaemonCursorRecord(currentRow) : undefined;
      const currentPosition = current
        ? { generation: current.generation, sequence: current.sequence }
        : undefined;

      if (args.expectedCurrent && !sameCursor(currentPosition, args.expectedCurrent)) {
        return {
          advanced: false,
          ...(current ? { cursor: current } : {}),
        };
      }

      if (!canAdvanceCursorTo(currentPosition, args.next)) {
        return {
          advanced: false,
          cursor: current ?? this.upsert(args.threadId, args.next, now),
        };
      }

      return {
        advanced: true,
        cursor: this.upsert(args.threadId, args.next, now),
      };
    });
  }
}

export class EnvironmentDaemonCommandRepository {
  constructor(private db: DbConnection) {}

  enqueue(args: EnqueueEnvironmentDaemonCommandInput): EnvironmentDaemonCommandRecord {
    const now = args.now ?? Date.now();
    return this.db.transaction((tx) => {
      const maxRow = tx
        .select({
          maxCursor: sql<number>`MAX(${environmentDaemonCommands.commandCursor})`,
        })
        .from(environmentDaemonCommands)
        .where(eq(environmentDaemonCommands.threadId, args.threadId))
        .get();
      const nextCursor = (maxRow?.maxCursor ?? 0) + 1;
      const row = {
        id: args.id ?? nanoid(),
        threadId: args.threadId,
        sessionId: args.sessionId ?? null,
        commandCursor: nextCursor,
        commandType: args.commandType,
        payload: JSON.stringify(args.payload),
        state: "queued",
        result: null,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      } satisfies typeof environmentDaemonCommands.$inferInsert;
      tx.insert(environmentDaemonCommands).values(row).run();
      return rowToEnvironmentDaemonCommandRecord(row);
    });
  }

  getById(id: string): EnvironmentDaemonCommandRecord | undefined {
    const row = this.db
      .select()
      .from(environmentDaemonCommands)
      .where(eq(environmentDaemonCommands.id, id))
      .get();
    return row ? rowToEnvironmentDaemonCommandRecord(row) : undefined;
  }

  listPendingByThreadId(threadId: string): EnvironmentDaemonCommandRecord[] {
    return this.db
      .select()
      .from(environmentDaemonCommands)
      .where(
        and(
          eq(environmentDaemonCommands.threadId, threadId),
          inArray(environmentDaemonCommands.state, [...PENDING_ENVIRONMENT_DAEMON_COMMAND_STATES]),
        ),
      )
      .orderBy(asc(environmentDaemonCommands.commandCursor))
      .all()
      .map(rowToEnvironmentDaemonCommandRecord);
  }

  listPendingBySessionId(sessionId: string): EnvironmentDaemonCommandRecord[] {
    return this.db
      .select()
      .from(environmentDaemonCommands)
      .where(
        and(
          eq(environmentDaemonCommands.sessionId, sessionId),
          inArray(environmentDaemonCommands.state, [...PENDING_ENVIRONMENT_DAEMON_COMMAND_STATES]),
        ),
      )
      .orderBy(asc(environmentDaemonCommands.commandCursor))
      .all()
      .map(rowToEnvironmentDaemonCommandRecord);
  }

  listDeliverableBySessionId(
    sessionId: string,
    afterCursor: number = 0,
    limit?: number,
  ): EnvironmentDaemonCommandRecord[] {
    let query = this.db
      .select()
      .from(environmentDaemonCommands)
      .where(
        and(
          eq(environmentDaemonCommands.sessionId, sessionId),
          gt(environmentDaemonCommands.commandCursor, afterCursor),
          inArray(environmentDaemonCommands.state, ["queued", "sent"]),
        ),
      )
      .orderBy(asc(environmentDaemonCommands.commandCursor));

    if (limit !== undefined) {
      query = query.limit(limit) as typeof query;
    }

    return query.all().map(rowToEnvironmentDaemonCommandRecord);
  }

  markSent(commandId: string, now?: number): EnvironmentDaemonCommandRecord | undefined {
    return this.transitionCommand(commandId, "sent", { now });
  }

  markReceived(commandId: string, now?: number): EnvironmentDaemonCommandRecord | undefined {
    return this.transitionCommand(commandId, "received", { now });
  }

  markStarted(commandId: string, now?: number): EnvironmentDaemonCommandRecord | undefined {
    return this.transitionCommand(commandId, "started", { now });
  }

  markCompleted(args: {
    commandId: string;
    result?: unknown;
    now?: number;
  }): EnvironmentDaemonCommandRecord | undefined {
    return this.transitionCommand(args.commandId, "completed", {
      now: args.now,
      ...(args.result !== undefined ? { result: args.result } : {}),
    });
  }

  markFailed(args: {
    commandId: string;
    errorCode?: string;
    errorMessage?: string;
    now?: number;
  }): EnvironmentDaemonCommandRecord | undefined {
    return this.transitionCommand(args.commandId, "failed", {
      now: args.now,
      ...(args.errorCode !== undefined ? { errorCode: args.errorCode } : {}),
      ...(args.errorMessage !== undefined ? { errorMessage: args.errorMessage } : {}),
    });
  }

  markCancelled(commandId: string, now?: number): EnvironmentDaemonCommandRecord | undefined {
    return this.transitionCommand(commandId, "cancelled", { now });
  }

  getNextCursorForThread(threadId: string): number {
    const row = this.db
      .select({
        maxCursor: sql<number>`MAX(${environmentDaemonCommands.commandCursor})`,
      })
      .from(environmentDaemonCommands)
      .where(eq(environmentDaemonCommands.threadId, threadId))
      .get();
    return (row?.maxCursor ?? 0) + 1;
  }

  private transitionCommand(
    commandId: string,
    target: EnvironmentDaemonCommandState,
    opts?: {
      result?: unknown;
      errorCode?: string;
      errorMessage?: string;
      now?: number;
    },
  ): EnvironmentDaemonCommandRecord | undefined {
    const existing = this.getById(commandId);
    if (!existing) return undefined;

    const resolution = resolveEnvironmentDaemonCommandStateUpdate(
      existing.state,
      target,
    );
    if (resolution === "noop") {
      return existing;
    }
    if (resolution === "conflict") {
      throw new Error(
        `Invalid environment-daemon command transition: ${existing.state} -> ${target}`,
      );
    }

    const now = opts?.now ?? Date.now();
    this.db
      .update(environmentDaemonCommands)
      .set({
        state: target,
        updatedAt: now,
        ...(target === "completed"
          ? {
              result:
                opts?.result !== undefined
                  ? JSON.stringify(opts.result)
                  : existing.result !== undefined
                    ? JSON.stringify(existing.result)
                    : null,
              errorCode: null,
              errorMessage: null,
            }
          : {}),
        ...(target === "failed"
          ? {
              errorCode: opts?.errorCode ?? existing.errorCode ?? null,
              errorMessage: opts?.errorMessage ?? existing.errorMessage ?? null,
            }
          : {}),
      })
      .where(eq(environmentDaemonCommands.id, commandId))
      .run();
    return this.getById(commandId);
  }
}
