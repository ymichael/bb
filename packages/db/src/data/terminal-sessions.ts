import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type {
  TerminalSessionCloseReason,
  TerminalSessionStatus,
} from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import { createTerminalSessionId } from "../ids.js";
import { terminalSessions } from "../schema.js";

type TerminalSessionWriteConnection = DbConnection | DbTransaction;
type TerminalSessionReadConnection = DbConnection | DbTransaction;

export type TerminalSessionRow = typeof terminalSessions.$inferSelect;

export interface CreateTerminalSessionInput {
  cols: number;
  currentCwd: string | null;
  daemonSessionId: string | null;
  environmentId: string;
  hostId: string;
  initialCwd: string;
  now?: number;
  rows: number;
  status: TerminalSessionStatus;
  threadId: string;
  title: string;
}

export interface GetTerminalSessionForThreadArgs {
  terminalId: string;
  threadId: string;
}

export interface UpdateTerminalSessionTitleArgs {
  now?: number;
  terminalId: string;
  threadId: string;
  title: string;
}

export interface MarkTerminalSessionRunningArgs {
  cols: number;
  currentCwd: string | null;
  daemonSessionId: string;
  initialCwd: string;
  now?: number;
  rows: number;
  terminalId: string;
  title: string;
}

export interface UpdateTerminalSessionSizeArgs {
  cols: number;
  now?: number;
  rows: number;
  terminalId: string;
  threadId: string;
}

export interface MarkTerminalSessionExitedArgs {
  closeReason: TerminalSessionCloseReason;
  exitCode: number | null;
  now?: number;
  terminalId: string;
}

export interface MarkTerminalSessionUserInputArgs {
  now?: number;
  terminalId: string;
  threadId: string;
}

export interface MarkDaemonTerminalSessionExitedArgs {
  closeReason: TerminalSessionCloseReason;
  daemonSessionId: string;
  exitCode: number | null;
  now?: number;
  terminalId: string;
}

export interface MarkThreadTerminalSessionsExitedArgs {
  closeReason: TerminalSessionCloseReason;
  now?: number;
  threadId: string;
}

export interface MarkEnvironmentTerminalSessionsExitedArgs {
  closeReason: TerminalSessionCloseReason;
  environmentId: string;
  now?: number;
}

export interface MarkHostDisconnectedTerminalSessionsExitedArgs {
  closeReason: TerminalSessionCloseReason;
  hostId: string;
  now?: number;
}

export interface MarkDaemonTerminalSessionsDisconnectedArgs {
  daemonSessionId: string;
  now?: number;
}

const DAEMON_OWNED_TERMINAL_STATUSES: TerminalSessionStatus[] = [
  "starting",
  "running",
];
const NON_TERMINAL_SESSION_STATUSES: TerminalSessionStatus[] = [
  ...DAEMON_OWNED_TERMINAL_STATUSES,
  "disconnected",
];

export function createTerminalSession(
  db: TerminalSessionWriteConnection,
  input: CreateTerminalSessionInput,
): TerminalSessionRow {
  const now = input.now ?? Date.now();
  return db
    .insert(terminalSessions)
    .values({
      id: createTerminalSessionId(),
      threadId: input.threadId,
      environmentId: input.environmentId,
      hostId: input.hostId,
      daemonSessionId: input.daemonSessionId,
      title: input.title,
      initialCwd: input.initialCwd,
      currentCwd: input.currentCwd,
      cols: input.cols,
      rows: input.rows,
      status: input.status,
      exitCode: null,
      closeReason: null,
      createdAt: now,
      updatedAt: now,
      lastUserInputAt: null,
      lastConnectedAt: input.daemonSessionId === null ? null : now,
      exitedAt: null,
    })
    .returning()
    .get();
}

export function listTerminalSessionsByThread(
  db: TerminalSessionReadConnection,
  threadId: string,
): TerminalSessionRow[] {
  return db
    .select()
    .from(terminalSessions)
    .where(eq(terminalSessions.threadId, threadId))
    .orderBy(asc(terminalSessions.createdAt), asc(terminalSessions.id))
    .all();
}

export function listVisibleTerminalSessionsByThread(
  db: TerminalSessionReadConnection,
  threadId: string,
): TerminalSessionRow[] {
  return db
    .select()
    .from(terminalSessions)
    .where(
      and(
        eq(terminalSessions.threadId, threadId),
        inArray(terminalSessions.status, NON_TERMINAL_SESSION_STATUSES),
      ),
    )
    .orderBy(asc(terminalSessions.createdAt), asc(terminalSessions.id))
    .all();
}

export function listTerminalSessionsByEnvironment(
  db: TerminalSessionReadConnection,
  environmentId: string,
): TerminalSessionRow[] {
  return db
    .select()
    .from(terminalSessions)
    .where(eq(terminalSessions.environmentId, environmentId))
    .orderBy(asc(terminalSessions.createdAt), asc(terminalSessions.id))
    .all();
}

export function getTerminalSessionForThread(
  db: TerminalSessionReadConnection,
  args: GetTerminalSessionForThreadArgs,
): TerminalSessionRow | null {
  return (
    db
      .select()
      .from(terminalSessions)
      .where(
        and(
          eq(terminalSessions.id, args.terminalId),
          eq(terminalSessions.threadId, args.threadId),
        ),
      )
      .get() ?? null
  );
}

export function updateTerminalSessionTitle(
  db: TerminalSessionWriteConnection,
  args: UpdateTerminalSessionTitleArgs,
): TerminalSessionRow | null {
  return (
    db
      .update(terminalSessions)
      .set({
        title: args.title,
        updatedAt: args.now ?? Date.now(),
      })
      .where(
        and(
          eq(terminalSessions.id, args.terminalId),
          eq(terminalSessions.threadId, args.threadId),
        ),
      )
      .returning()
      .get() ?? null
  );
}

export function markTerminalSessionRunning(
  db: TerminalSessionWriteConnection,
  args: MarkTerminalSessionRunningArgs,
): TerminalSessionRow | null {
  const now = args.now ?? Date.now();
  return (
    db
      .update(terminalSessions)
      .set({
        cols: args.cols,
        rows: args.rows,
        currentCwd: args.currentCwd,
        daemonSessionId: args.daemonSessionId,
        initialCwd: args.initialCwd,
        title: args.title,
        status: "running",
        closeReason: null,
        exitCode: null,
        updatedAt: now,
        lastConnectedAt: now,
        exitedAt: null,
      })
      .where(
        and(
          eq(terminalSessions.id, args.terminalId),
          eq(terminalSessions.status, "starting"),
          eq(terminalSessions.daemonSessionId, args.daemonSessionId),
        ),
      )
      .returning()
      .get() ?? null
  );
}

export function updateTerminalSessionSize(
  db: TerminalSessionWriteConnection,
  args: UpdateTerminalSessionSizeArgs,
): TerminalSessionRow | null {
  return (
    db
      .update(terminalSessions)
      .set({
        cols: args.cols,
        rows: args.rows,
        updatedAt: args.now ?? Date.now(),
      })
      .where(
        and(
          eq(terminalSessions.id, args.terminalId),
          eq(terminalSessions.threadId, args.threadId),
        ),
      )
      .returning()
      .get() ?? null
  );
}

export function markTerminalSessionUserInput(
  db: TerminalSessionWriteConnection,
  args: MarkTerminalSessionUserInputArgs,
): TerminalSessionRow | null {
  const now = args.now ?? Date.now();
  return (
    db
      .update(terminalSessions)
      .set({
        lastUserInputAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(terminalSessions.id, args.terminalId),
          eq(terminalSessions.threadId, args.threadId),
          isNull(terminalSessions.lastUserInputAt),
        ),
      )
      .returning()
      .get() ?? null
  );
}

export function markTerminalSessionExited(
  db: TerminalSessionWriteConnection,
  args: MarkTerminalSessionExitedArgs,
): TerminalSessionRow | null {
  const now = args.now ?? Date.now();
  return (
    db
      .update(terminalSessions)
      .set({
        status: "exited",
        exitCode: args.exitCode,
        closeReason: args.closeReason,
        daemonSessionId: null,
        updatedAt: now,
        exitedAt: now,
      })
      .where(eq(terminalSessions.id, args.terminalId))
      .returning()
      .get() ?? null
  );
}

export function markDaemonTerminalSessionExited(
  db: TerminalSessionWriteConnection,
  args: MarkDaemonTerminalSessionExitedArgs,
): TerminalSessionRow | null {
  const now = args.now ?? Date.now();
  return (
    db
      .update(terminalSessions)
      .set({
        status: "exited",
        exitCode: args.exitCode,
        closeReason: args.closeReason,
        daemonSessionId: null,
        updatedAt: now,
        exitedAt: now,
      })
      .where(
        and(
          eq(terminalSessions.id, args.terminalId),
          eq(terminalSessions.daemonSessionId, args.daemonSessionId),
        ),
      )
      .returning()
      .get() ?? null
  );
}

export function markThreadTerminalSessionsExited(
  db: TerminalSessionWriteConnection,
  args: MarkThreadTerminalSessionsExitedArgs,
): TerminalSessionRow[] {
  const now = args.now ?? Date.now();
  return db
    .update(terminalSessions)
    .set({
      status: "exited",
      closeReason: args.closeReason,
      daemonSessionId: null,
      updatedAt: now,
      exitedAt: now,
    })
    .where(
      and(
        eq(terminalSessions.threadId, args.threadId),
        inArray(terminalSessions.status, NON_TERMINAL_SESSION_STATUSES),
      ),
    )
    .returning()
    .all();
}

export function markEnvironmentTerminalSessionsExited(
  db: TerminalSessionWriteConnection,
  args: MarkEnvironmentTerminalSessionsExitedArgs,
): TerminalSessionRow[] {
  const now = args.now ?? Date.now();
  return db
    .update(terminalSessions)
    .set({
      status: "exited",
      closeReason: args.closeReason,
      daemonSessionId: null,
      updatedAt: now,
      exitedAt: now,
    })
    .where(
      and(
        eq(terminalSessions.environmentId, args.environmentId),
        inArray(terminalSessions.status, NON_TERMINAL_SESSION_STATUSES),
      ),
    )
    .returning()
    .all();
}

export function markHostDisconnectedTerminalSessionsExited(
  db: TerminalSessionWriteConnection,
  args: MarkHostDisconnectedTerminalSessionsExitedArgs,
): TerminalSessionRow[] {
  const now = args.now ?? Date.now();
  return db
    .update(terminalSessions)
    .set({
      status: "exited",
      closeReason: args.closeReason,
      daemonSessionId: null,
      updatedAt: now,
      exitedAt: now,
    })
    .where(
      and(
        eq(terminalSessions.hostId, args.hostId),
        eq(terminalSessions.status, "disconnected"),
      ),
    )
    .returning()
    .all();
}

export function markDaemonTerminalSessionsDisconnected(
  db: TerminalSessionWriteConnection,
  args: MarkDaemonTerminalSessionsDisconnectedArgs,
): TerminalSessionRow[] {
  return db
    .update(terminalSessions)
    .set({
      status: "disconnected",
      daemonSessionId: null,
      updatedAt: args.now ?? Date.now(),
    })
    .where(
      and(
        eq(terminalSessions.daemonSessionId, args.daemonSessionId),
        inArray(terminalSessions.status, DAEMON_OWNED_TERMINAL_STATUSES),
      ),
    )
    .returning()
    .all();
}
