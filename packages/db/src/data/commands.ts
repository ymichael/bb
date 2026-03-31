import { eq, and, max, gt, inArray } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { hostDaemonCommands } from "../schema.js";
import { createHostDaemonCommandId } from "../ids.js";

export interface QueueCommandInput {
  hostId: string;
  sessionId?: string | null;
  type: string;
  payload: string;
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
  const now = Date.now();
  const id = createHostDaemonCommandId();

  return db.transaction((tx) => {
    // Get max cursor for this host
    const maxRow = tx
      .select({ maxCursor: max(hostDaemonCommands.cursor) })
      .from(hostDaemonCommands)
      .where(eq(hostDaemonCommands.hostId, input.hostId))
      .get();

    const cursor = (maxRow?.maxCursor ?? 0) + 1;

    const command = tx.insert(hostDaemonCommands)
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

    notifier.notifyCommand(input.hostId);

    return command;
  });
}

export interface FetchCommandsOptions {
  hostId: string;
  afterCursor?: number;
  limit?: number;
}

/**
 * Fetch pending commands for a host after the given cursor.
 * Marks them as fetched.
 */
export function fetchCommands(
  db: DbConnection,
  notifier: DbNotifier,
  options: FetchCommandsOptions,
) {
  const { hostId, afterCursor = 0, limit = 100 } = options;
  const now = Date.now();

  return db.transaction((tx) => {
    const commands = tx
      .select()
      .from(hostDaemonCommands)
      .where(
        and(
          eq(hostDaemonCommands.hostId, hostId),
          eq(hostDaemonCommands.state, "pending"),
          gt(hostDaemonCommands.cursor, afterCursor),
        ),
      )
      .orderBy(hostDaemonCommands.cursor)
      .limit(limit)
      .all();

    if (commands.length === 0) return commands;

    // Batch update: mark all fetched commands in one query
    tx.update(hostDaemonCommands)
      .set({ state: "fetched", fetchedAt: now })
      .where(inArray(hostDaemonCommands.id, commands.map((c) => c.id)))
      .run();

    return commands.map((cmd) => ({ ...cmd, state: "fetched" as const, fetchedAt: now }));
  });
}

export interface ReportCommandResultInput {
  commandId: string;
  state: "success" | "error";
  completedAt: number;
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
  return db.update(hostDaemonCommands)
    .set({
      state: input.state,
      resultPayload: input.resultPayload ?? null,
      completedAt: input.completedAt,
    })
    .where(eq(hostDaemonCommands.id, input.commandId))
    .returning()
    .get() ?? null;
}
