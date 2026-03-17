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
  environmentAgentCommands,
  environmentAgentCursors,
  environmentAgentSessions,
} from "./schema.js";

export type EnvironmentAgentSessionStatus =
  | "active"
  | "expired"
  | "closed"
  | "replaced";

export type EnvironmentAgentSessionCloseReason =
  | "agent_shutdown"
  | "daemon_shutdown"
  | "lease_expired"
  | "newer_session"
  | "migration"
  | "internal_error";

export interface EnvironmentAgentCursorPosition {
  generation: number;
  sequence: number;
}

export interface EnvironmentAgentSessionRecord {
  id: string;
  threadId: string;
  environmentId?: string;
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
  status: EnvironmentAgentSessionStatus;
  leaseExpiresAt: number;
  lastHeartbeatAt?: number;
  closedAt?: number;
  closeReason?: EnvironmentAgentSessionCloseReason;
  createdAt: number;
  updatedAt: number;
}

export interface EnvironmentAgentCursorRecord
  extends EnvironmentAgentCursorPosition {
  threadId: string;
  updatedAt: number;
}

export type EnvironmentAgentCursorAdvanceResult =
  | {
      advanced: true;
      cursor: EnvironmentAgentCursorRecord;
    }
  | {
      advanced: false;
      cursor?: EnvironmentAgentCursorRecord;
    };

export type EnvironmentAgentCommandState =
  | "queued"
  | "sent"
  | "received"
  | "started"
  | "completed"
  | "failed"
  | "cancelled";

export interface EnvironmentAgentCommandRecord {
  id: string;
  threadId: string;
  sessionId?: string;
  commandCursor: number;
  commandType: string;
  payload: unknown;
  state: EnvironmentAgentCommandState;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateEnvironmentAgentSessionInput {
  id?: string;
  threadId: string;
  environmentId?: string;
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

export interface ReplaceActiveEnvironmentAgentSessionInput
  extends CreateEnvironmentAgentSessionInput {}

export interface EnqueueEnvironmentAgentCommandInput {
  id?: string;
  threadId: string;
  commandType: string;
  payload: unknown;
  sessionId?: string;
  now?: number;
}

const PENDING_ENVIRONMENT_AGENT_COMMAND_STATES: readonly EnvironmentAgentCommandState[] = [
  "queued",
  "sent",
  "received",
  "started",
];

function isEnvironmentAgentSessionStatus(
  value: string,
): value is EnvironmentAgentSessionStatus {
  return (
    value === "active" ||
    value === "expired" ||
    value === "closed" ||
    value === "replaced"
  );
}

function normalizeEnvironmentAgentSessionStatus(
  value: string,
): EnvironmentAgentSessionStatus {
  if (isEnvironmentAgentSessionStatus(value)) return value;
  throw new Error(`Invalid persisted environment-agent session status: ${value}`);
}

function isEnvironmentAgentSessionCloseReason(
  value: string,
): value is EnvironmentAgentSessionCloseReason {
  return (
    value === "agent_shutdown" ||
    value === "daemon_shutdown" ||
    value === "lease_expired" ||
    value === "newer_session" ||
    value === "migration" ||
    value === "internal_error"
  );
}

function normalizeEnvironmentAgentSessionCloseReason(
  value: string | null | undefined,
): EnvironmentAgentSessionCloseReason | undefined {
  if (!value) return undefined;
  if (isEnvironmentAgentSessionCloseReason(value)) return value;
  throw new Error(`Invalid persisted environment-agent session close reason: ${value}`);
}

function isEnvironmentAgentCommandState(
  value: string,
): value is EnvironmentAgentCommandState {
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

function normalizeEnvironmentAgentCommandState(
  value: string,
): EnvironmentAgentCommandState {
  if (isEnvironmentAgentCommandState(value)) return value;
  throw new Error(`Invalid persisted environment-agent command state: ${value}`);
}

function parseJsonField(value: string, fieldName: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid persisted ${fieldName} JSON`);
  }
}

function rowToEnvironmentAgentSessionRecord(
  row: typeof environmentAgentSessions.$inferSelect,
): EnvironmentAgentSessionRecord {
  return {
    id: row.id,
    threadId: row.threadId,
    ...(row.environmentId !== null ? { environmentId: row.environmentId } : {}),
    agentId: row.agentId,
    agentInstanceId: row.agentInstanceId,
    protocolVersion: row.protocolVersion,
    ...(row.workerName !== null ? { workerName: row.workerName } : {}),
    ...(row.workerVersion !== null ? { workerVersion: row.workerVersion } : {}),
    ...(row.workerBuildId !== null ? { workerBuildId: row.workerBuildId } : {}),
    ...(row.providerMetadata !== null
      ? { providerMetadata: parseJsonField(row.providerMetadata, "environment-agent provider metadata") }
      : {}),
    ...(row.selectedCapabilities !== null
      ? {
          selectedCapabilities: parseJsonField(
            row.selectedCapabilities,
            "environment-agent selected capabilities",
          ),
        }
      : {}),
    ...(row.controlBaseUrl !== null ? { controlBaseUrl: row.controlBaseUrl } : {}),
    ...(row.controlAuthToken !== null ? { controlAuthToken: row.controlAuthToken } : {}),
    status: normalizeEnvironmentAgentSessionStatus(row.status),
    leaseExpiresAt: row.leaseExpiresAt,
    ...(row.lastHeartbeatAt !== null ? { lastHeartbeatAt: row.lastHeartbeatAt } : {}),
    ...(row.closedAt !== null ? { closedAt: row.closedAt } : {}),
    ...(row.closeReason !== null
      ? { closeReason: normalizeEnvironmentAgentSessionCloseReason(row.closeReason) }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isEnvironmentAgentSessionLeaseActive(
  session: Pick<EnvironmentAgentSessionRecord, "status" | "leaseExpiresAt">,
  now: number,
): boolean {
  return session.status === "active" && session.leaseExpiresAt > now;
}

function rowToEnvironmentAgentCursorRecord(
  row: typeof environmentAgentCursors.$inferSelect,
): EnvironmentAgentCursorRecord {
  return {
    threadId: row.threadId,
    generation: row.generation,
    sequence: row.sequence,
    updatedAt: row.updatedAt,
  };
}

function rowToEnvironmentAgentCommandRecord(
  row: typeof environmentAgentCommands.$inferSelect,
): EnvironmentAgentCommandRecord {
  return {
    id: row.id,
    threadId: row.threadId,
    ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
    commandCursor: row.commandCursor,
    commandType: row.commandType,
    payload: parseJsonField(row.payload, "environment-agent command payload"),
    state: normalizeEnvironmentAgentCommandState(row.state),
    ...(row.result !== null
      ? { result: parseJsonField(row.result, "environment-agent command result") }
      : {}),
    ...(row.errorCode !== null ? { errorCode: row.errorCode } : {}),
    ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sameCursor(
  left: EnvironmentAgentCursorPosition | undefined,
  right: EnvironmentAgentCursorPosition | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.generation === right.generation && left.sequence === right.sequence;
}

function canAdvanceCursorTo(
  current: EnvironmentAgentCursorPosition | undefined,
  next: EnvironmentAgentCursorPosition,
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

function resolveEnvironmentAgentCommandStateUpdate(
  current: EnvironmentAgentCommandState,
  target: EnvironmentAgentCommandState,
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

export class EnvironmentAgentSessionRepository {
  constructor(private db: DbConnection) {}

  create(args: CreateEnvironmentAgentSessionInput): EnvironmentAgentSessionRecord {
    const now = args.now ?? Date.now();
    const row = {
      id: args.id ?? nanoid(),
      threadId: args.threadId,
      environmentId: args.environmentId ?? null,
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
    } satisfies typeof environmentAgentSessions.$inferInsert;
    this.db.insert(environmentAgentSessions).values(row).run();
    return rowToEnvironmentAgentSessionRecord(row);
  }

  getById(id: string): EnvironmentAgentSessionRecord | undefined {
    const row = this.db
      .select()
      .from(environmentAgentSessions)
      .where(eq(environmentAgentSessions.id, id))
      .get();
    return row ? rowToEnvironmentAgentSessionRecord(row) : undefined;
  }

  getActiveByThreadId(
    threadId: string,
    now: number = Date.now(),
  ): EnvironmentAgentSessionRecord | undefined {
    const row = this.db
      .select()
      .from(environmentAgentSessions)
      .where(
        and(
          eq(environmentAgentSessions.threadId, threadId),
          eq(environmentAgentSessions.status, "active"),
          gt(environmentAgentSessions.leaseExpiresAt, now),
        ),
      )
      .orderBy(desc(environmentAgentSessions.updatedAt))
      .get();
    return row ? rowToEnvironmentAgentSessionRecord(row) : undefined;
  }

  getActiveByEnvironmentId(
    environmentId: string,
    now: number = Date.now(),
  ): EnvironmentAgentSessionRecord | undefined {
    const row = this.db
      .select()
      .from(environmentAgentSessions)
      .where(
        and(
          eq(environmentAgentSessions.environmentId, environmentId),
          eq(environmentAgentSessions.status, "active"),
          gt(environmentAgentSessions.leaseExpiresAt, now),
        ),
      )
      .orderBy(desc(environmentAgentSessions.updatedAt))
      .get();
    return row ? rowToEnvironmentAgentSessionRecord(row) : undefined;
  }

  getLatestByThreadId(threadId: string): EnvironmentAgentSessionRecord | undefined {
    const row = this.db
      .select()
      .from(environmentAgentSessions)
      .where(eq(environmentAgentSessions.threadId, threadId))
      .orderBy(desc(environmentAgentSessions.updatedAt))
      .get();
    return row ? rowToEnvironmentAgentSessionRecord(row) : undefined;
  }

  getLatestByEnvironmentId(environmentId: string): EnvironmentAgentSessionRecord | undefined {
    const row = this.db
      .select()
      .from(environmentAgentSessions)
      .where(eq(environmentAgentSessions.environmentId, environmentId))
      .orderBy(desc(environmentAgentSessions.updatedAt))
      .get();
    return row ? rowToEnvironmentAgentSessionRecord(row) : undefined;
  }

  listByThreadId(threadId: string): EnvironmentAgentSessionRecord[] {
    return this.db
      .select()
      .from(environmentAgentSessions)
      .where(eq(environmentAgentSessions.threadId, threadId))
      .orderBy(desc(environmentAgentSessions.updatedAt), desc(environmentAgentSessions.createdAt))
      .all()
      .map(rowToEnvironmentAgentSessionRecord);
  }

  listByEnvironmentId(environmentId: string): EnvironmentAgentSessionRecord[] {
    return this.db
      .select()
      .from(environmentAgentSessions)
      .where(eq(environmentAgentSessions.environmentId, environmentId))
      .orderBy(desc(environmentAgentSessions.updatedAt), desc(environmentAgentSessions.createdAt))
      .all()
      .map(rowToEnvironmentAgentSessionRecord);
  }

  listActive(now: number = Date.now()): EnvironmentAgentSessionRecord[] {
    return this.db
      .select()
      .from(environmentAgentSessions)
      .where(
        and(
          eq(environmentAgentSessions.status, "active"),
          gt(environmentAgentSessions.leaseExpiresAt, now),
        ),
      )
      .orderBy(desc(environmentAgentSessions.updatedAt))
      .all()
      .map(rowToEnvironmentAgentSessionRecord);
  }

  listExpiringBefore(timestamp: number): EnvironmentAgentSessionRecord[] {
    return this.db
      .select()
      .from(environmentAgentSessions)
      .where(
        and(
          eq(environmentAgentSessions.status, "active"),
          lte(environmentAgentSessions.leaseExpiresAt, timestamp),
        ),
      )
      .orderBy(asc(environmentAgentSessions.leaseExpiresAt))
      .all()
      .map(rowToEnvironmentAgentSessionRecord);
  }

  closeAllActive(args: {
    reason: Exclude<EnvironmentAgentSessionCloseReason, "lease_expired" | "newer_session">;
    now?: number;
  }): number {
    const now = args.now ?? Date.now();
    const result = this.db
      .update(environmentAgentSessions)
      .set({
        status: "closed",
        closedAt: now,
        closeReason: args.reason,
        updatedAt: now,
      })
      .where(eq(environmentAgentSessions.status, "active"))
      .run();
    return Number(result.changes ?? 0);
  }

  touchHeartbeat(args: {
    sessionId: string;
    leaseExpiresAt: number;
    heartbeatAt: number;
  }): EnvironmentAgentSessionRecord | undefined {
    return this.db.transaction((tx) => {
      const row = tx.select().from(environmentAgentSessions)
        .where(eq(environmentAgentSessions.id, args.sessionId)).get();
      if (!row) return undefined;
      const existing = rowToEnvironmentAgentSessionRecord(row);
      if (!isEnvironmentAgentSessionLeaseActive(existing, args.heartbeatAt)) {
        return existing;
      }
      tx.update(environmentAgentSessions)
        .set({
          leaseExpiresAt: args.leaseExpiresAt,
          lastHeartbeatAt: args.heartbeatAt,
          updatedAt: args.heartbeatAt,
        })
        .where(eq(environmentAgentSessions.id, args.sessionId))
        .run();
      const updated = tx.select().from(environmentAgentSessions)
        .where(eq(environmentAgentSessions.id, args.sessionId)).get();
      return updated ? rowToEnvironmentAgentSessionRecord(updated) : undefined;
    });
  }

  markExpired(sessionId: string, now: number = Date.now()): EnvironmentAgentSessionRecord | undefined {
    return this.db.transaction((tx) => {
      const row = tx.select().from(environmentAgentSessions)
        .where(eq(environmentAgentSessions.id, sessionId)).get();
      if (!row) return undefined;
      const existing = rowToEnvironmentAgentSessionRecord(row);
      if (existing.status === "expired") return existing;
      if (existing.status !== "active") return existing;
      tx.update(environmentAgentSessions)
        .set({
          status: "expired",
          closedAt: now,
          closeReason: "lease_expired",
          updatedAt: now,
        })
        .where(eq(environmentAgentSessions.id, sessionId))
        .run();
      const updated = tx.select().from(environmentAgentSessions)
        .where(eq(environmentAgentSessions.id, sessionId)).get();
      return updated ? rowToEnvironmentAgentSessionRecord(updated) : undefined;
    });
  }

  markClosed(args: {
    sessionId: string;
    reason: Exclude<EnvironmentAgentSessionCloseReason, "lease_expired" | "newer_session">;
    now?: number;
  }): EnvironmentAgentSessionRecord | undefined {
    return this.db.transaction((tx) => {
      const row = tx.select().from(environmentAgentSessions)
        .where(eq(environmentAgentSessions.id, args.sessionId)).get();
      if (!row) return undefined;
      const existing = rowToEnvironmentAgentSessionRecord(row);
      if (existing.status === "closed") return existing;
      if (existing.status === "replaced") return existing;
      const now = args.now ?? Date.now();
      tx.update(environmentAgentSessions)
        .set({
          status: "closed",
          closedAt: now,
          closeReason: args.reason,
          updatedAt: now,
        })
        .where(eq(environmentAgentSessions.id, args.sessionId))
        .run();
      const updated = tx.select().from(environmentAgentSessions)
        .where(eq(environmentAgentSessions.id, args.sessionId)).get();
      return updated ? rowToEnvironmentAgentSessionRecord(updated) : undefined;
    });
  }

  markReplaced(args: {
    sessionId: string;
    now?: number;
  }): EnvironmentAgentSessionRecord | undefined {
    return this.db.transaction((tx) => {
      const row = tx.select().from(environmentAgentSessions)
        .where(eq(environmentAgentSessions.id, args.sessionId)).get();
      if (!row) return undefined;
      const existing = rowToEnvironmentAgentSessionRecord(row);
      if (existing.status === "replaced") return existing;
      if (existing.status === "closed") return existing;
      const now = args.now ?? Date.now();
      tx.update(environmentAgentSessions)
        .set({
          status: "replaced",
          closedAt: now,
          closeReason: "newer_session",
          updatedAt: now,
        })
        .where(eq(environmentAgentSessions.id, args.sessionId))
        .run();
      const updated = tx.select().from(environmentAgentSessions)
        .where(eq(environmentAgentSessions.id, args.sessionId)).get();
      return updated ? rowToEnvironmentAgentSessionRecord(updated) : undefined;
    });
  }

  replaceActiveForThread(args: {
    threadId: string;
    nextSession: ReplaceActiveEnvironmentAgentSessionInput;
    now?: number;
  }): { replaced?: EnvironmentAgentSessionRecord; active: EnvironmentAgentSessionRecord } {
    const now = args.now ?? args.nextSession.now ?? Date.now();
    return this.db.transaction((tx) => {
      const existingRow = tx
        .select()
        .from(environmentAgentSessions)
        .where(
          and(
            eq(environmentAgentSessions.threadId, args.threadId),
            eq(environmentAgentSessions.status, "active"),
          ),
        )
        .orderBy(desc(environmentAgentSessions.updatedAt))
        .get();

      let replaced: EnvironmentAgentSessionRecord | undefined;
      if (existingRow) {
        tx
          .update(environmentAgentSessions)
          .set({
            status: "replaced",
            closedAt: now,
            closeReason: "newer_session",
            updatedAt: now,
          })
          .where(eq(environmentAgentSessions.id, existingRow.id))
          .run();
        replaced = rowToEnvironmentAgentSessionRecord({
          ...existingRow,
          status: "replaced",
          closedAt: now,
          closeReason: "newer_session",
          updatedAt: now,
        });
      }

      const inserted = {
        id: args.nextSession.id ?? nanoid(),
        threadId: args.nextSession.threadId,
        environmentId: args.nextSession.environmentId ?? null,
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
      } satisfies typeof environmentAgentSessions.$inferInsert;
      tx.insert(environmentAgentSessions).values(inserted).run();

      return {
        ...(replaced ? { replaced } : {}),
        active: rowToEnvironmentAgentSessionRecord(inserted),
      };
    });
  }

  replaceActiveForEnvironment(args: {
    environmentId: string;
    nextSession: ReplaceActiveEnvironmentAgentSessionInput;
    now?: number;
  }): { replaced?: EnvironmentAgentSessionRecord; active: EnvironmentAgentSessionRecord } {
    const now = args.now ?? args.nextSession.now ?? Date.now();
    return this.db.transaction((tx) => {
      const existingRow = tx
        .select()
        .from(environmentAgentSessions)
        .where(
          and(
            eq(environmentAgentSessions.environmentId, args.environmentId),
            eq(environmentAgentSessions.status, "active"),
          ),
        )
        .orderBy(desc(environmentAgentSessions.updatedAt))
        .get();

      let replaced: EnvironmentAgentSessionRecord | undefined;
      if (existingRow) {
        tx
          .update(environmentAgentSessions)
          .set({
            status: "replaced",
            closedAt: now,
            closeReason: "newer_session",
            updatedAt: now,
          })
          .where(eq(environmentAgentSessions.id, existingRow.id))
          .run();
        replaced = rowToEnvironmentAgentSessionRecord({
          ...existingRow,
          status: "replaced",
          closedAt: now,
          closeReason: "newer_session",
          updatedAt: now,
        });
      }

      const inserted = {
        id: args.nextSession.id ?? nanoid(),
        threadId: args.nextSession.threadId,
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
      } satisfies typeof environmentAgentSessions.$inferInsert;
      tx.insert(environmentAgentSessions).values(inserted).run();

      return {
        ...(replaced ? { replaced } : {}),
        active: rowToEnvironmentAgentSessionRecord(inserted),
      };
    });
  }
}

export class EnvironmentAgentCursorRepository {
  constructor(private db: DbConnection) {}

  getByThreadId(threadId: string): EnvironmentAgentCursorRecord | undefined {
    const row = this.db
      .select()
      .from(environmentAgentCursors)
      .where(eq(environmentAgentCursors.threadId, threadId))
      .get();
    return row ? rowToEnvironmentAgentCursorRecord(row) : undefined;
  }

  deleteByThreadId(threadId: string): void {
    this.db
      .delete(environmentAgentCursors)
      .where(eq(environmentAgentCursors.threadId, threadId))
      .run();
  }

  upsert(
    threadId: string,
    cursor: EnvironmentAgentCursorPosition,
    now: number = Date.now(),
  ): EnvironmentAgentCursorRecord {
    return this.db.transaction((tx) => {
      const existing = tx.select().from(environmentAgentCursors)
        .where(eq(environmentAgentCursors.threadId, threadId)).get();
      if (!existing) {
        const row = {
          threadId,
          generation: cursor.generation,
          sequence: cursor.sequence,
          updatedAt: now,
        } satisfies typeof environmentAgentCursors.$inferInsert;
        tx.insert(environmentAgentCursors).values(row).run();
        return rowToEnvironmentAgentCursorRecord(row);
      }

      tx.update(environmentAgentCursors)
        .set({
          generation: cursor.generation,
          sequence: cursor.sequence,
          updatedAt: now,
        })
        .where(eq(environmentAgentCursors.threadId, threadId))
        .run();
      const updated = tx.select().from(environmentAgentCursors)
        .where(eq(environmentAgentCursors.threadId, threadId)).get();
      return rowToEnvironmentAgentCursorRecord(updated!);
    });
  }

  advanceIfNext(args: {
    threadId: string;
    expectedCurrent?: EnvironmentAgentCursorPosition;
    next: EnvironmentAgentCursorPosition;
    now?: number;
  }): EnvironmentAgentCursorAdvanceResult {
    return this.db.transaction((tx) => {
      const now = args.now ?? Date.now();
      const currentRow = tx.select().from(environmentAgentCursors)
        .where(eq(environmentAgentCursors.threadId, args.threadId)).get();
      const current = currentRow ? rowToEnvironmentAgentCursorRecord(currentRow) : undefined;
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

export class EnvironmentAgentCommandRepository {
  constructor(private db: DbConnection) {}

  enqueue(args: EnqueueEnvironmentAgentCommandInput): EnvironmentAgentCommandRecord {
    const now = args.now ?? Date.now();
    return this.db.transaction((tx) => {
      const maxRow = tx
        .select({
          maxCursor: sql<number>`MAX(${environmentAgentCommands.commandCursor})`,
        })
        .from(environmentAgentCommands)
        .where(eq(environmentAgentCommands.threadId, args.threadId))
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
      } satisfies typeof environmentAgentCommands.$inferInsert;
      tx.insert(environmentAgentCommands).values(row).run();
      return rowToEnvironmentAgentCommandRecord(row);
    });
  }

  getById(id: string): EnvironmentAgentCommandRecord | undefined {
    const row = this.db
      .select()
      .from(environmentAgentCommands)
      .where(eq(environmentAgentCommands.id, id))
      .get();
    return row ? rowToEnvironmentAgentCommandRecord(row) : undefined;
  }

  listPendingByThreadId(threadId: string): EnvironmentAgentCommandRecord[] {
    return this.db
      .select()
      .from(environmentAgentCommands)
      .where(
        and(
          eq(environmentAgentCommands.threadId, threadId),
          inArray(environmentAgentCommands.state, [...PENDING_ENVIRONMENT_AGENT_COMMAND_STATES]),
        ),
      )
      .orderBy(asc(environmentAgentCommands.commandCursor))
      .all()
      .map(rowToEnvironmentAgentCommandRecord);
  }

  listPendingBySessionId(sessionId: string): EnvironmentAgentCommandRecord[] {
    return this.db
      .select()
      .from(environmentAgentCommands)
      .where(
        and(
          eq(environmentAgentCommands.sessionId, sessionId),
          inArray(environmentAgentCommands.state, [...PENDING_ENVIRONMENT_AGENT_COMMAND_STATES]),
        ),
      )
      .orderBy(asc(environmentAgentCommands.commandCursor))
      .all()
      .map(rowToEnvironmentAgentCommandRecord);
  }

  listDeliverableBySessionId(
    sessionId: string,
    afterCursor: number = 0,
    limit?: number,
  ): EnvironmentAgentCommandRecord[] {
    let query = this.db
      .select()
      .from(environmentAgentCommands)
      .where(
        and(
          eq(environmentAgentCommands.sessionId, sessionId),
          gt(environmentAgentCommands.commandCursor, afterCursor),
          inArray(environmentAgentCommands.state, ["queued", "sent"]),
        ),
      )
      .orderBy(asc(environmentAgentCommands.commandCursor));

    if (limit !== undefined) {
      query = query.limit(limit) as typeof query;
    }

    return query.all().map(rowToEnvironmentAgentCommandRecord);
  }

  markSent(commandId: string, now?: number): EnvironmentAgentCommandRecord | undefined {
    return this.transitionCommand(commandId, "sent", { now });
  }

  markReceived(commandId: string, now?: number): EnvironmentAgentCommandRecord | undefined {
    return this.transitionCommand(commandId, "received", { now });
  }

  markStarted(commandId: string, now?: number): EnvironmentAgentCommandRecord | undefined {
    return this.transitionCommand(commandId, "started", { now });
  }

  markCompleted(args: {
    commandId: string;
    result?: unknown;
    now?: number;
  }): EnvironmentAgentCommandRecord | undefined {
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
  }): EnvironmentAgentCommandRecord | undefined {
    return this.transitionCommand(args.commandId, "failed", {
      now: args.now,
      ...(args.errorCode !== undefined ? { errorCode: args.errorCode } : {}),
      ...(args.errorMessage !== undefined ? { errorMessage: args.errorMessage } : {}),
    });
  }

  markCancelled(commandId: string, now?: number): EnvironmentAgentCommandRecord | undefined {
    return this.transitionCommand(commandId, "cancelled", { now });
  }

  getNextCursorForThread(threadId: string): number {
    const row = this.db
      .select({
        maxCursor: sql<number>`MAX(${environmentAgentCommands.commandCursor})`,
      })
      .from(environmentAgentCommands)
      .where(eq(environmentAgentCommands.threadId, threadId))
      .get();
    return (row?.maxCursor ?? 0) + 1;
  }

  private transitionCommand(
    commandId: string,
    target: EnvironmentAgentCommandState,
    opts?: {
      result?: unknown;
      errorCode?: string;
      errorMessage?: string;
      now?: number;
    },
  ): EnvironmentAgentCommandRecord | undefined {
    const existing = this.getById(commandId);
    if (!existing) return undefined;

    const resolution = resolveEnvironmentAgentCommandStateUpdate(
      existing.state,
      target,
    );
    if (resolution === "noop") {
      return existing;
    }
    if (resolution === "conflict") {
      throw new Error(
        `Invalid environment-agent command transition: ${existing.state} -> ${target}`,
      );
    }

    const now = opts?.now ?? Date.now();
    this.db
      .update(environmentAgentCommands)
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
      .where(eq(environmentAgentCommands.id, commandId))
      .run();
    return this.getById(commandId);
  }
}
