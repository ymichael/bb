import { and, eq, inArray, max, sql } from "drizzle-orm";
import type { DbConnection, DbTransaction } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { hostDaemonCommands } from "../schema.js";
import { createHostDaemonCommandId } from "../ids.js";

export interface QueueCommandInput {
  hostId: string;
  sessionId?: string | null;
  type: string;
  payload: string;
}

type CommandWriteConnection = DbConnection | DbTransaction;
type CommandReadConnection = DbConnection | DbTransaction;
export type HostDaemonCommandRow = typeof hostDaemonCommands.$inferSelect;

export interface HasPendingHostCommandForThreadArgs {
  hostId: string;
  threadId: string;
  type: "thread.stop" | "turn.submit";
}

export interface GetPendingEnvironmentCommandArgs {
  environmentId: string;
  type: "environment.destroy" | "workspace.status";
}

export function getCommand(db: CommandReadConnection, id: string) {
  return (
    db
      .select()
      .from(hostDaemonCommands)
      .where(eq(hostDaemonCommands.id, id))
      .get() ?? null
  );
}

function queueCommandRecord(
  db: CommandWriteConnection,
  input: QueueCommandInput,
) {
  const now = Date.now();
  const id = createHostDaemonCommandId();

  const maxRow = db
    .select({ maxCursor: max(hostDaemonCommands.cursor) })
    .from(hostDaemonCommands)
    .where(eq(hostDaemonCommands.hostId, input.hostId))
    .get();

  const cursor = (maxRow?.maxCursor ?? 0) + 1;

  return db
    .insert(hostDaemonCommands)
    .values({
      id,
      hostId: input.hostId,
      sessionId: input.sessionId ?? null,
      cursor,
      type: input.type,
      payload: input.payload,
      state: "pending",
      retryCount: 0,
      createdAt: now,
    })
    .returning()
    .get();
}

export function queueCommandInTransaction(
  db: DbTransaction,
  input: QueueCommandInput,
) {
  return queueCommandRecord(db, input);
}

/**
 * Queue a command with a monotonic per-host cursor.
 * Runs in a transaction to ensure cursor uniqueness.
 */
export function queueCommand(
  db: DbConnection,
  notifier: DbNotifier,
  input: QueueCommandInput,
) {
  const command = db.transaction((tx) => queueCommandRecord(tx, input));
  notifier.notifyCommand(input.hostId);
  return command;
}

export function hasPendingHostCommandForThread(
  db: CommandReadConnection,
  args: HasPendingHostCommandForThreadArgs,
): boolean {
  const row = db
    .select({ id: hostDaemonCommands.id })
    .from(hostDaemonCommands)
    .where(
      and(
        eq(hostDaemonCommands.hostId, args.hostId),
        eq(hostDaemonCommands.type, args.type),
        inArray(hostDaemonCommands.state, ["pending", "fetched"]),
        sql`json_extract(${hostDaemonCommands.payload}, '$.threadId') = ${args.threadId}`,
      ),
    )
    .get();

  return row !== undefined;
}

export function getPendingEnvironmentCommand(
  db: CommandReadConnection,
  args: GetPendingEnvironmentCommandArgs,
) {
  return (
    db
      .select({ id: hostDaemonCommands.id })
      .from(hostDaemonCommands)
      .where(
        and(
          eq(hostDaemonCommands.type, args.type),
          inArray(hostDaemonCommands.state, ["pending", "fetched"]),
          sql`json_extract(${hostDaemonCommands.payload}, '$.environmentId') = ${args.environmentId}`,
        ),
      )
      .get() ?? null
  );
}

export interface FetchCommandsOptions {
  hostId: string;
  limit?: number;
}

/**
 * Fetch pending commands for a host.
 * Marks them as fetched.
 */
export function fetchCommands(
  db: DbConnection,
  notifier: DbNotifier,
  options: FetchCommandsOptions,
) {
  const { hostId, limit = 100 } = options;
  const now = Date.now();

  return db.transaction((tx) => {
    const commands = tx
      .select()
      .from(hostDaemonCommands)
      .where(
        and(
          eq(hostDaemonCommands.hostId, hostId),
          eq(hostDaemonCommands.state, "pending"),
        ),
      )
      .orderBy(hostDaemonCommands.cursor)
      .limit(limit)
      .all();

    if (commands.length === 0) return commands;

    // Batch update: mark all fetched commands in one query
    tx.update(hostDaemonCommands)
      .set({ state: "fetched", fetchedAt: now })
      .where(
        inArray(
          hostDaemonCommands.id,
          commands.map((c) => c.id),
        ),
      )
      .run();

    return commands.map((cmd) => ({
      ...cmd,
      state: "fetched" as const,
      fetchedAt: now,
    }));
  });
}

export interface ReportCommandResultInput {
  commandId: string;
  state: "success" | "error";
  completedAt: number;
  resultPayload?: string | null;
}

export interface CancelCommandArgs {
  commandId: string;
  completedAt?: number;
  resultPayload?: string | null;
}

/**
 * Report the result of a command execution.
 */
export function reportCommandResult(
  db: DbConnection,
  notifier: DbNotifier,
  input: ReportCommandResultInput,
) {
  return (
    db
      .update(hostDaemonCommands)
      .set({
        state: input.state,
        resultPayload: input.resultPayload ?? null,
        completedAt: input.completedAt,
      })
      .where(eq(hostDaemonCommands.id, input.commandId))
      .returning()
      .get() ?? null
  );
}

export function cancelCommand(db: DbConnection, args: CancelCommandArgs) {
  return (
    db
      .update(hostDaemonCommands)
      .set({
        state: "error",
        completedAt: args.completedAt ?? Date.now(),
        resultPayload: args.resultPayload ?? null,
      })
      .where(
        and(
          eq(hostDaemonCommands.id, args.commandId),
          inArray(hostDaemonCommands.state, ["pending", "fetched"]),
        ),
      )
      .returning()
      .get() ?? null
  );
}
