import { z } from "zod";
import {
  appendStoredThreadEvent,
  appendStoredThreadEventInTransaction,
  appendStoredThreadEventsInTransaction,
  createEventId,
  getActiveStoredTurnId,
  getLastStoredProviderThreadId,
  getLastStoredTurnRequestEvent,
  type StoredTurnRequestEventRow,
} from "@bb/db";
import {
  parseStoredThreadEvent,
  systemErrorEventDataSchema,
  threadScope,
  turnRequestEventDataSchema,
} from "@bb/domain";
import type {
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
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import type { DbTransaction } from "@bb/db";
import type { AppendStoredThreadEventArgs as AppendThreadEventArgs } from "@bb/db";

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

function buildClientTurnEventData(
  args: ClientTurnRequestedEventArgs,
): TurnRequestEventData;
function buildClientTurnEventData(
  args: ClientTurnLifecycleEventArgs,
): ClientTurnLifecycleEventData;
function buildClientTurnEventData(
  args: ClientTurnEventArgs,
): ClientTurnLifecycleEventData | TurnRequestEventData;
function buildClientTurnEventData(
  args: ClientTurnEventArgs,
): ClientTurnLifecycleEventData | TurnRequestEventData {
  const base: ClientTurnLifecycleEventData = {
    direction: "outbound",
    source: args.source,
    initiator: args.initiator,
    request: {
      method: args.requestMethod,
      params: {},
    },
  };

  if (args.type !== "client/turn/requested") {
    return base;
  }

  return {
    ...base,
    input: args.input,
    target: args.target,
    execution: args.execution,
  };
}

type AppendClientTurnEvent = (args: AppendThreadEventArgs) => number;

function appendBuiltClientTurnEvent(
  append: AppendClientTurnEvent,
  args: ClientTurnEventArgs,
): number {
  switch (args.type) {
    case "client/thread/start":
    case "client/turn/start":
      return append({
        threadId: args.threadId,
        environmentId: args.environmentId,
        type: args.type,
        scope: threadScope(),
        data: buildClientTurnEventData(args),
      });
    case "client/turn/requested":
      return append({
        threadId: args.threadId,
        environmentId: args.environmentId,
        type: args.type,
        scope: threadScope(),
        data: buildClientTurnEventData(args),
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
  return appendStoredThreadEvent(deps.db, deps.hub, args);
}

export function appendThreadEventInTransaction<TType extends ThreadEventType>(
  db: DbTransaction,
  args: AppendThreadEventArgs<TType>,
): number;
export function appendThreadEventInTransaction(
  db: DbTransaction,
  args: AppendThreadEventArgs,
): number {
  return appendStoredThreadEventInTransaction(db, args);
}

export function appendThreadEventsInTransaction(
  db: DbTransaction,
  args: readonly AppendThreadEventArgs[],
): number[] {
  return appendStoredThreadEventsInTransaction(db, args);
}

export function appendClientTurnEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ClientTurnEventArgs,
): number {
  return appendBuiltClientTurnEvent(
    (eventArgs) => appendThreadEvent(deps, eventArgs),
    args,
  );
}

export function appendClientTurnEventInTransaction(
  db: DbTransaction,
  args: ClientTurnEventArgs,
): number {
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

export function appendThreadOwnershipChangeEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendThreadOwnershipChangeEventArgs,
): number | null {
  const action = resolveThreadOwnershipChangeAction(args);
  if (!action) {
    return null;
  }

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
        nextParentThreadId: args.nextParentThreadId,
      },
    },
  });
}

export function getActiveTurnId(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): string | null {
  return getActiveStoredTurnId(deps.db, threadId);
}

export function getLastProviderThreadId(
  deps: Pick<AppDeps, "db">,
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
