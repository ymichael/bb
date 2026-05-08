import { z } from "zod";
import {
  appendStoredThreadEventInTransaction,
  appendStoredThreadEventsInTransaction,
  createEventId,
  getActiveStoredTurnId,
  getLastStoredProviderThreadId,
  getLastStoredTurnRequestEvent,
  getThread,
  listStoredTurnStartedKeys,
  type StoredTurnRequestEventRow,
} from "@bb/db";
import {
  CLIENT_TURN_REQUEST_ID_ALPHABET,
  CLIENT_TURN_REQUEST_ID_SUFFIX_LENGTH,
  encodeClientTurnRequestIdAlphabetIndexes,
  getThreadEventScopeTurnId,
  parseStoredThreadEvent,
  systemErrorEventDataSchema,
  threadScope,
  turnRequestEventDataSchema,
} from "@bb/domain";
import { randomBytes } from "node:crypto";
import type {
  ClientTurnRequestId,
  ClientTurnLifecycleEventData,
  PromptInput,
  ProvisioningTranscriptEntry,
  SystemThreadProvisioningStatus,
  TurnRequestEventData,
  TurnRequestTarget,
  ThreadEventType,
  ResolvedThreadExecutionOptions,
  SystemErrorEventData,
  SystemThreadInterruptedReason,
  ThreadEventScope,
  ThreadTurnInitiator,
} from "@bb/domain";
import { ApiError, TurnStartGuardError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import type { DbNotifier, DbQueryConnection, DbTransaction } from "@bb/db";
import type { AppendStoredThreadEventArgs as AppendThreadEventArgs } from "@bb/db";

interface ThreadEventReadDeps {
  db: DbQueryConnection;
}

interface ThreadEventTransactionDeps {
  db: DbTransaction;
  hub: DbNotifier;
}

export interface ClientTurnRequestedEventArgs {
  environmentId: string | null;
  execution: ResolvedThreadExecutionOptions;
  initiator: ThreadTurnInitiator;
  input: PromptInput[];
  requestMethod: "thread/start" | "turn/start";
  source: "spawn" | "tell";
  target: TurnRequestTarget;
  threadId: string;
  type: "client/turn/requested";
}

export interface ClientTurnLifecycleEventArgs {
  environmentId: string | null;
  initiator: ThreadTurnInitiator;
  requestMethod: "thread/start" | "turn/start";
  source: "spawn" | "tell";
  threadId: string;
  type: "client/thread/start" | "client/turn/start";
}

export type ClientTurnEventArgs =
  | ClientTurnLifecycleEventArgs
  | ClientTurnRequestedEventArgs;

export interface AppendedClientTurnRequest {
  requestId: ClientTurnRequestId;
  sequence: number;
}

export type ThreadOwnershipChangeAction = "assign" | "release" | "transfer";

export interface AppendThreadOwnershipChangeEventArgs {
  environmentId?: string | null;
  nextParentThreadId: string | null;
  previousParentThreadId: string | null;
  threadId: string;
}

export interface AppendSystemErrorEventArgs {
  code: string;
  detail?: string;
  environmentId?: string | null;
  message: string;
  reconnectAttempt?: number;
  reconnectTotal?: number;
  scope: ThreadEventScope;
  threadId: string;
}

export interface AppendThreadProvisioningEventArgs {
  entries: ProvisioningTranscriptEntry[];
  environmentId: string;
  provisioningId: string;
  status: SystemThreadProvisioningStatus;
  threadId: string;
}

export interface BuildCwdBranchEntriesArgs {
  branchName: string | null;
  path: string;
}

export interface AppendThreadInterruptedEventArgs {
  reason: SystemThreadInterruptedReason;
  threadId: string;
}

const storedEventPayloadSchema = z.record(z.string(), z.unknown());

const LEGACY_THREAD_START_TARGET = {
  kind: "thread-start",
} satisfies TurnRequestTarget;
const LEGACY_NEW_TURN_TARGET = { kind: "new-turn" } satisfies TurnRequestTarget;
type LegacyTurnRequestEventType = "client/thread/start" | "client/turn/start";
const LEGACY_TURN_REQUEST_TARGET_BY_TYPE = {
  "client/thread/start": LEGACY_THREAD_START_TARGET,
  "client/turn/start": LEGACY_NEW_TURN_TARGET,
} satisfies Record<LegacyTurnRequestEventType, TurnRequestTarget>;

interface TurnStartKey {
  threadId: string;
  turnId: string;
}

interface ReconnectProgress {
  attempt: number;
  total: number;
}

function legacyTurnRequestTargetForType(
  type: LegacyTurnRequestEventType,
): TurnRequestTarget {
  return LEGACY_TURN_REQUEST_TARGET_BY_TYPE[type];
}

function parseReconnectProgress(message: string): ReconnectProgress | null {
  const match = message.trim().match(/^Reconnecting\.\.\.\s+(\d+)\/(\d+)$/);
  if (!match) {
    return null;
  }

  const attempt = Number.parseInt(match[1] ?? "", 10);
  const total = Number.parseInt(match[2] ?? "", 10);
  if (
    !Number.isFinite(attempt) ||
    !Number.isFinite(total) ||
    attempt <= 0 ||
    total <= 0 ||
    attempt > total
  ) {
    return null;
  }

  return { attempt, total };
}

function resolveReconnectProgress(
  args: Pick<
    AppendSystemErrorEventArgs,
    "code" | "message" | "reconnectAttempt" | "reconnectTotal"
  >,
): ReconnectProgress | null {
  if (
    args.reconnectAttempt !== undefined &&
    args.reconnectTotal !== undefined
  ) {
    return {
      attempt: args.reconnectAttempt,
      total: args.reconnectTotal,
    };
  }

  if (args.code !== "provider_reconnect") {
    return null;
  }

  return parseReconnectProgress(args.message);
}

function buildClientTurnBaseEventData(
  args: ClientTurnEventArgs,
): ClientTurnLifecycleEventData {
  return {
    direction: "outbound",
    source: args.source,
    initiator: args.initiator,
    request: {
      method: args.requestMethod,
      params: {},
    },
  };
}

function buildClientTurnLifecycleEventData(
  args: ClientTurnLifecycleEventArgs,
): ClientTurnLifecycleEventData {
  return buildClientTurnBaseEventData(args);
}

function buildClientTurnRequestedEventData(
  args: ClientTurnRequestedEventArgs,
  requestId: ClientTurnRequestId,
): TurnRequestEventData {
  return {
    ...buildClientTurnBaseEventData(args),
    requestId,
    input: args.input,
    target: args.target,
    execution: args.execution,
  };
}

type AppendClientTurnEvent = (args: AppendThreadEventArgs) => number;

function createClientTurnRequestId(): ClientTurnRequestId {
  const bytes = randomBytes(CLIENT_TURN_REQUEST_ID_SUFFIX_LENGTH);
  return encodeClientTurnRequestIdAlphabetIndexes({
    indexes: [...bytes].map(
      (byte) => byte % CLIENT_TURN_REQUEST_ID_ALPHABET.length,
    ),
  });
}

function appendBuiltClientTurnEvent(
  append: AppendClientTurnEvent,
  args: ClientTurnEventArgs,
): number | AppendedClientTurnRequest {
  switch (args.type) {
    case "client/thread/start":
    case "client/turn/start":
      return append({
        threadId: args.threadId,
        environmentId: args.environmentId,
        type: args.type,
        scope: threadScope(),
        data: buildClientTurnLifecycleEventData(args),
      });
    case "client/turn/requested": {
      const requestId = createClientTurnRequestId();
      const sequence = append({
        threadId: args.threadId,
        environmentId: args.environmentId,
        type: args.type,
        scope: threadScope(),
        data: buildClientTurnRequestedEventData(args, requestId),
      });
      return { requestId, sequence };
    }
  }
}

function getTurnStartKey(args: TurnStartKey): string {
  return `${args.threadId}\0${args.turnId}`;
}

function collectTurnStartRequirements(
  eventArgs: readonly AppendThreadEventArgs[],
): TurnStartKey[] {
  return eventArgs.flatMap((args) => {
    if (args.type === "turn/started") {
      return [];
    }

    const turnId = getThreadEventScopeTurnId(args.scope);
    if (turnId === undefined) {
      return [];
    }

    return [
      {
        threadId: args.threadId,
        turnId,
      },
    ];
  });
}

function listExistingTurnStartKeys(
  db: DbQueryConnection,
  requirements: readonly TurnStartKey[],
): Set<string> {
  return new Set(
    listStoredTurnStartedKeys(db, { keys: requirements }).map((key) =>
      getTurnStartKey(key),
    ),
  );
}

function assertStoredTurnStartedForEvents(
  db: DbQueryConnection,
  eventArgs: readonly AppendThreadEventArgs[],
): void {
  // Same-batch satisfaction is ordered: turn/started only unlocks later events
  // in this append list. Daemon batches enforce the same invariant separately.
  const existingTurnKeys = listExistingTurnStartKeys(
    db,
    collectTurnStartRequirements(eventArgs),
  );
  const startedTurnKeys = new Set<string>();

  for (const args of eventArgs) {
    if (args.type === "turn/started") {
      const turnId = getThreadEventScopeTurnId(args.scope);
      if (turnId !== undefined) {
        startedTurnKeys.add(
          getTurnStartKey({ threadId: args.threadId, turnId }),
        );
      }
      continue;
    }

    const turnId = getThreadEventScopeTurnId(args.scope);
    if (turnId === undefined) {
      continue;
    }

    const key = getTurnStartKey({ threadId: args.threadId, turnId });
    if (startedTurnKeys.has(key) || existingTurnKeys.has(key)) {
      continue;
    }

    throw new TurnStartGuardError({
      eventType: args.type,
      scopeKind: args.scope.kind,
      threadId: args.threadId,
      turnId,
    });
  }
}

export function appendThreadEvent<TType extends ThreadEventType>(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendThreadEventArgs<TType>,
): number;
export function appendThreadEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendThreadEventArgs,
): number {
  const sequence = deps.db.transaction(
    (tx) => {
      assertStoredTurnStartedForEvents(tx, [args]);
      return appendStoredThreadEventInTransaction(tx, args);
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(args.threadId, ["events-appended"]);
  return sequence;
}

export function appendThreadEventInTransaction<TType extends ThreadEventType>(
  db: DbTransaction,
  args: AppendThreadEventArgs<TType>,
): number;
export function appendThreadEventInTransaction(
  db: DbTransaction,
  args: AppendThreadEventArgs,
): number {
  assertStoredTurnStartedForEvents(db, [args]);
  return appendStoredThreadEventInTransaction(db, args);
}

export function appendThreadEventsInTransaction(
  db: DbTransaction,
  args: readonly AppendThreadEventArgs[],
): number[] {
  assertStoredTurnStartedForEvents(db, args);
  return appendStoredThreadEventsInTransaction(db, args);
}

export function appendClientTurnEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ClientTurnRequestedEventArgs,
): AppendedClientTurnRequest;
export function appendClientTurnEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ClientTurnLifecycleEventArgs,
): number;
export function appendClientTurnEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ClientTurnEventArgs,
): number | AppendedClientTurnRequest {
  return appendBuiltClientTurnEvent(
    (eventArgs) => appendThreadEvent(deps, eventArgs),
    args,
  );
}

export function appendClientTurnEventInTransaction(
  db: DbTransaction,
  args: ClientTurnRequestedEventArgs,
): AppendedClientTurnRequest;
export function appendClientTurnEventInTransaction(
  db: DbTransaction,
  args: ClientTurnLifecycleEventArgs,
): number;
export function appendClientTurnEventInTransaction(
  db: DbTransaction,
  args: ClientTurnEventArgs,
): number | AppendedClientTurnRequest {
  return appendBuiltClientTurnEvent(
    (eventArgs) => appendThreadEventInTransaction(db, eventArgs),
    args,
  );
}

export function parseStoredTurnRequestEvent(
  row: StoredTurnRequestEventRow,
): TurnRequestEventData {
  let eventData: unknown;
  try {
    eventData = JSON.parse(row.data);
  } catch {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is not valid JSON`,
    );
  }

  const parsedEventData = storedEventPayloadSchema.safeParse(eventData);
  if (!parsedEventData.success) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
    );
  }

  let event;
  try {
    event = parseStoredThreadEvent({
      data: parsedEventData.data,
      threadId: row.threadId,
      type: row.type,
      scope: threadScope(),
    });
  } catch {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
    );
  }

  if (event.type === "client/turn/requested") {
    return {
      direction: event.direction,
      requestId: event.requestId,
      source: event.source,
      ...(event.initiator ? { initiator: event.initiator } : {}),
      input: event.input,
      target: event.target,
      request: event.request,
      execution: event.execution,
    };
  }

  if (row.type === "client/thread/start" || row.type === "client/turn/start") {
    const legacyTurnRequest = turnRequestEventDataSchema.safeParse({
      ...parsedEventData.data,
      target: legacyTurnRequestTargetForType(row.type),
    });
    if (legacyTurnRequest.success) {
      return legacyTurnRequest.data;
    }
  }

  throw new ApiError(
    500,
    "internal_error",
    `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
  );
}

export function appendThreadProvisioningEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendThreadProvisioningEventArgs,
): number {
  return appendThreadEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    type: "system/thread-provisioning",
    scope: threadScope(),
    data: {
      provisioningId: args.provisioningId,
      status: args.status,
      environmentId: args.environmentId,
      entries: args.entries,
    },
  });
}

export function appendThreadProvisioningEventInTransaction(
  db: DbTransaction,
  args: AppendThreadProvisioningEventArgs,
): number {
  return appendThreadEventInTransaction(db, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    type: "system/thread-provisioning",
    scope: threadScope(),
    data: {
      provisioningId: args.provisioningId,
      status: args.status,
      environmentId: args.environmentId,
      entries: args.entries,
    },
  });
}

export function buildCwdBranchEntries(
  args: BuildCwdBranchEntriesArgs,
): ProvisioningTranscriptEntry[] {
  const now = Date.now();
  const entries: ProvisioningTranscriptEntry[] = [
    {
      type: "step",
      key: "workspace-path",
      text: `Using workspace: ${args.path}`,
      status: "completed",
      startedAt: now,
    },
  ];
  if (args.branchName) {
    entries.push({
      type: "step",
      key: "workspace-branch",
      text: `Using branch: ${args.branchName}`,
      status: "completed",
      startedAt: now,
    });
  }
  return entries;
}

export function appendSystemErrorEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendSystemErrorEventArgs,
): number {
  return appendThreadEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId ?? null,
    type: "system/error",
    scope: args.scope,
    data: buildSystemErrorEventData(args),
  });
}

export function appendSystemErrorEventInTransaction(
  deps: ThreadEventTransactionDeps,
  args: AppendSystemErrorEventArgs,
): number {
  const sequence = appendThreadEventInTransaction(deps.db, {
    threadId: args.threadId,
    environmentId: args.environmentId ?? null,
    type: "system/error",
    scope: args.scope,
    data: buildSystemErrorEventData(args),
  });
  deps.hub.notifyThread(args.threadId, ["events-appended"]);
  return sequence;
}

export function buildSystemErrorEventData(
  args: Pick<
    AppendSystemErrorEventArgs,
    "code" | "detail" | "message" | "reconnectAttempt" | "reconnectTotal"
  >,
): SystemErrorEventData {
  const reconnectProgress = resolveReconnectProgress(args);
  return systemErrorEventDataSchema.parse({
    code: args.code,
    message: args.message,
    ...(args.detail ? { detail: args.detail } : {}),
    ...(reconnectProgress
      ? { reconnectAttempt: reconnectProgress.attempt }
      : {}),
    ...(reconnectProgress ? { reconnectTotal: reconnectProgress.total } : {}),
  });
}

export function appendThreadInterruptedEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendThreadInterruptedEventArgs,
): number {
  return appendThreadEvent(deps, {
    threadId: args.threadId,
    type: "system/thread/interrupted",
    scope: threadScope(),
    data: {
      reason: args.reason,
    },
  });
}

export function appendThreadInterruptedEventInTransaction(
  db: DbTransaction,
  args: AppendThreadInterruptedEventArgs,
): number {
  return appendThreadEventInTransaction(db, {
    threadId: args.threadId,
    type: "system/thread/interrupted",
    scope: threadScope(),
    data: {
      reason: args.reason,
    },
  });
}

function resolveThreadOwnershipChangeAction(
  args: AppendThreadOwnershipChangeEventArgs,
): ThreadOwnershipChangeAction | null {
  const { previousParentThreadId, nextParentThreadId } = args;
  if (previousParentThreadId === nextParentThreadId) {
    return null;
  }
  if (previousParentThreadId === null && nextParentThreadId !== null) {
    return "assign";
  }
  if (previousParentThreadId !== null && nextParentThreadId === null) {
    return "release";
  }
  if (previousParentThreadId !== null && nextParentThreadId !== null) {
    return "transfer";
  }
  return null;
}

function threadOwnershipChangeMessage(
  action: ThreadOwnershipChangeAction,
): string {
  switch (action) {
    case "assign":
      return "Thread assigned to manager";
    case "release":
      return "Thread released from manager";
    case "transfer":
      return "Thread transferred to new manager";
  }
}

function resolveParentThreadTitle(
  db: DbQueryConnection,
  parentThreadId: string | null,
): string | null {
  if (parentThreadId === null) {
    return null;
  }
  const thread = getThread(db, parentThreadId);
  if (!thread) {
    return null;
  }
  return thread.title ?? thread.titleFallback ?? null;
}

export function appendThreadOwnershipChangeEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendThreadOwnershipChangeEventArgs,
): number | null {
  const action = resolveThreadOwnershipChangeAction(args);
  if (!action) {
    return null;
  }

  const previousParentThreadTitle = resolveParentThreadTitle(
    deps.db,
    args.previousParentThreadId,
  );
  const nextParentThreadTitle = resolveParentThreadTitle(
    deps.db,
    args.nextParentThreadId,
  );

  return appendThreadEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId ?? null,
    type: "system/operation",
    scope: threadScope(),
    data: {
      operation: "ownership_change",
      operationId: createEventId(),
      status: "completed",
      message: threadOwnershipChangeMessage(action),
      metadata: {
        action,
        previousParentThreadId: args.previousParentThreadId,
        previousParentThreadTitle,
        nextParentThreadId: args.nextParentThreadId,
        nextParentThreadTitle,
      },
    },
  });
}

export function getActiveTurnId(
  deps: ThreadEventReadDeps,
  threadId: string,
): string | null {
  return getActiveStoredTurnId(deps.db, threadId);
}

export function getLastProviderThreadId(
  deps: ThreadEventReadDeps,
  threadId: string,
): string | null {
  return getLastStoredProviderThreadId(deps.db, threadId);
}

export function getLastExecutionOptions(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): ResolvedThreadExecutionOptions | null {
  const row = getLastStoredTurnRequestEvent(deps.db, threadId);

  return row
    ? parseStoredTurnRequestEvent({
        data: row.data,
        sequence: row.sequence,
        threadId: row.threadId,
        type: row.type,
      }).execution
    : null;
}
