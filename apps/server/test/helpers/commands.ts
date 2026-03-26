import { setTimeout as sleep } from "node:timers/promises";
import { desc } from "drizzle-orm";
import { hostDaemonCommands } from "@bb/db";
import {
  hostDaemonCommandResultSchemaByType,
  hostDaemonCommandSchema,
} from "@bb/host-daemon-contract";
import type {
  HostDaemonCommand,
  HostDaemonCommandResultByType,
} from "@bb/host-daemon-contract";
import type { TestAppHarness } from "./test-app.js";

export interface QueuedCommand<
  TCommand extends HostDaemonCommand = HostDaemonCommand,
> {
  command: TCommand;
  row: typeof hostDaemonCommands.$inferSelect;
}

export function internalAuthHeaders(harness: TestAppHarness): HeadersInit {
  return {
    authorization: `Bearer ${harness.config.authToken}`,
    "content-type": "application/json",
  };
}

export async function waitForQueuedCommand(
  harness: TestAppHarness,
  predicate: (queued: QueuedCommand) => boolean,
  timeoutMs = 1_000,
): Promise<QueuedCommand> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = harness.db
      .select()
      .from(hostDaemonCommands)
      .orderBy(desc(hostDaemonCommands.createdAt))
      .all();

    for (const row of rows) {
      const queued = {
        command: hostDaemonCommandSchema.parse(JSON.parse(row.payload)),
        row,
      };
      if (predicate(queued)) {
        return queued;
      }
    }

    await sleep(10);
  }

  throw new Error("Timed out waiting for queued command");
}

export async function waitForQueuedCommandAfter(
  harness: TestAppHarness,
  afterCursor: number,
  predicate: (queued: QueuedCommand) => boolean,
  timeoutMs = 1_000,
): Promise<QueuedCommand> {
  return waitForQueuedCommand(
    harness,
    (queued) => queued.row.cursor > afterCursor && predicate(queued),
    timeoutMs,
  );
}

export async function reportQueuedCommandSuccess<
  TCommand extends HostDaemonCommand,
>(
  harness: TestAppHarness,
  queued: QueuedCommand<TCommand>,
  result: HostDaemonCommandResultByType[TCommand["type"]],
): Promise<Response> {
  const sessionId = queued.row.sessionId;
  if (!sessionId) {
    throw new Error("Queued command is missing sessionId");
  }

  return harness.app.request("/internal/session/command-result", {
    method: "POST",
    headers: internalAuthHeaders(harness),
    body: JSON.stringify({
      sessionId,
      commandId: queued.row.id,
      cursor: queued.row.cursor,
      completedAt: Date.now(),
      type: queued.command.type,
      ok: true,
      result: hostDaemonCommandResultSchemaByType[queued.command.type].parse(result),
    }),
  });
}

export async function reportQueuedCommandError(
  harness: TestAppHarness,
  queued: QueuedCommand,
  args: { errorCode: string; errorMessage: string },
): Promise<Response> {
  const sessionId = queued.row.sessionId;
  if (!sessionId) {
    throw new Error("Queued command is missing sessionId");
  }

  return harness.app.request("/internal/session/command-result", {
    method: "POST",
    headers: internalAuthHeaders(harness),
    body: JSON.stringify({
      sessionId,
      commandId: queued.row.id,
      cursor: queued.row.cursor,
      completedAt: Date.now(),
      type: queued.command.type,
      ok: false,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
    }),
  });
}
