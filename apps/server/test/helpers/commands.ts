import { setTimeout as sleep } from "node:timers/promises";
import { and, desc, eq, sql } from "drizzle-orm";
import { hostDaemonCommands, hostDaemonSessions } from "@bb/db";
import {
  hostDaemonCommandResultSchemaByType,
  hostDaemonCommandSchema,
} from "@bb/host-daemon-contract";
import {
  CLIENT_TURN_REQUEST_ID_ALPHABET,
  hostDaemonProducerEventIdSchema,
  type HostDaemonProducerEventId,
  type HostType,
  type ThreadEvent,
} from "@bb/domain";
import type {
  HostDaemonCommand,
  HostDaemonCommandResultByType,
  HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import type { TestAppHarness } from "./test-app.js";
import { createTestDaemonHostKey } from "./test-app.js";

export interface QueuedCommand<
  TCommand extends HostDaemonCommand = HostDaemonCommand,
> {
  command: TCommand;
  row: typeof hostDaemonCommands.$inferSelect;
}

export function listQueuedThreadCommands(
  harness: TestAppHarness,
  type: HostDaemonCommand["type"],
  threadId: string,
): HostDaemonCommand[] {
  return harness.db
    .select({ payload: hostDaemonCommands.payload })
    .from(hostDaemonCommands)
    .where(
      and(
        eq(hostDaemonCommands.type, type),
        sql`json_extract(${hostDaemonCommands.payload}, '$.threadId') = ${threadId}`,
      ),
    )
    .all()
    .map((row) => hostDaemonCommandSchema.parse(JSON.parse(row.payload)));
}

const TEST_PRODUCER_EVENT_ID_PREFIX = "hdevt_";
const TEST_PRODUCER_EVENT_ID_SUFFIX_LENGTH = 20;

export interface CreateTestProducerEventIdArgs {
  value: number;
}

export interface CreateTestDaemonEventEnvelopeArgs {
  event: ThreadEvent;
  producerEventIdValue: number;
  threadId?: string;
}

export function createTestProducerEventId(
  args: CreateTestProducerEventIdArgs,
): HostDaemonProducerEventId {
  if (!Number.isSafeInteger(args.value) || args.value < 0) {
    throw new Error(
      "Producer event id number must be a safe non-negative integer",
    );
  }

  let value = args.value;
  let suffix = "";
  for (
    let index = 0;
    index < TEST_PRODUCER_EVENT_ID_SUFFIX_LENGTH;
    index += 1
  ) {
    const alphabetIndex = value % CLIENT_TURN_REQUEST_ID_ALPHABET.length;
    suffix = CLIENT_TURN_REQUEST_ID_ALPHABET.charAt(alphabetIndex) + suffix;
    value = Math.floor(value / CLIENT_TURN_REQUEST_ID_ALPHABET.length);
  }

  return hostDaemonProducerEventIdSchema.parse(
    `${TEST_PRODUCER_EVENT_ID_PREFIX}${suffix}`,
  );
}

export function createTestDaemonEventEnvelope(
  args: CreateTestDaemonEventEnvelopeArgs,
): HostDaemonEventEnvelope {
  return {
    producerEventId: createTestProducerEventId({
      value: args.producerEventIdValue,
    }),
    threadId: args.threadId ?? args.event.threadId,
    event: args.event,
  };
}

export function internalAuthHeaders(
  harness: TestAppHarness,
  args: { hostId?: string; hostType?: HostType } = {},
): HeadersInit {
  const activeSessions = harness.db
    .select({
      hostId: hostDaemonSessions.hostId,
      hostType: hostDaemonSessions.hostType,
    })
    .from(hostDaemonSessions)
    .where(eq(hostDaemonSessions.status, "active"))
    .all();

  const inferredHost = activeSessions.length === 1 ? activeSessions[0] : null;

  return {
    authorization: `Bearer ${createTestDaemonHostKey({
      hostId: args.hostId ?? inferredHost?.hostId ?? "host-1",
      hostType: args.hostType ?? inferredHost?.hostType ?? "persistent",
    })}`,
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
  args: { hostId?: string; hostType?: HostType } = {},
): Promise<Response> {
  const sessionId = queued.row.sessionId;
  if (!sessionId) {
    throw new Error("Queued command is missing sessionId");
  }

  return harness.app.request("/internal/session/command-result", {
    method: "POST",
    headers: internalAuthHeaders(harness, args),
    body: JSON.stringify({
      sessionId,
      commandId: queued.row.id,
      completedAt: Date.now(),
      type: queued.command.type,
      ok: true,
      result:
        hostDaemonCommandResultSchemaByType[queued.command.type].parse(result),
    }),
  });
}

export async function reportQueuedCommandError(
  harness: TestAppHarness,
  queued: QueuedCommand,
  args: { errorCode: string; errorMessage: string },
  auth: { hostId?: string; hostType?: HostType } = {},
): Promise<Response> {
  const sessionId = queued.row.sessionId;
  if (!sessionId) {
    throw new Error("Queued command is missing sessionId");
  }

  return harness.app.request("/internal/session/command-result", {
    method: "POST",
    headers: internalAuthHeaders(harness, auth),
    body: JSON.stringify({
      sessionId,
      commandId: queued.row.id,
      completedAt: Date.now(),
      type: queued.command.type,
      ok: false,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
    }),
  });
}

export async function reportNextRuntimeMaterialSyncSuccess(
  harness: TestAppHarness,
  args: {
    hostId: string;
    hostType?: HostType;
    timeoutMs?: number;
  },
): Promise<
  QueuedCommand<
    Extract<HostDaemonCommand, { type: "host.sync_runtime_material" }>
  >
> {
  const queued = await waitForQueuedCommand(
    harness,
    ({ command, row }) =>
      row.hostId === args.hostId &&
      command.type === "host.sync_runtime_material",
    args.timeoutMs,
  );
  const command = queued.command;
  if (command.type !== "host.sync_runtime_material") {
    throw new Error("Expected a host.sync_runtime_material command");
  }
  const narrowed: QueuedCommand<
    Extract<HostDaemonCommand, { type: "host.sync_runtime_material" }>
  > = { command, row: queued.row };

  const response = await reportQueuedCommandSuccess(
    harness,
    narrowed,
    {
      appliedVersion: command.version,
    },
    {
      hostId: args.hostId,
      hostType: args.hostType ?? "ephemeral",
    },
  );
  if (!response.ok) {
    throw new Error(
      `Expected runtime material sync success, got ${response.status}`,
    );
  }

  return narrowed;
}
