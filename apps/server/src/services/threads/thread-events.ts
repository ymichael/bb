import { z } from "zod";
import {
  appendStoredThreadEvent,
  appendStoredThreadEventInTransaction,
  getActiveStoredTurnId,
  getLastStoredProviderThreadId,
  getLastStoredTurnRequestEvent,
  type StoredTurnRequestEventRow,
} from "@bb/db";
import {
  parseStoredThreadEvent,
  systemErrorEventDataSchema,
} from "@bb/domain";
import type {
  PromptInput,
  ProvisioningTranscriptEntry,
  SystemThreadProvisioningStatus,
  TurnRequestEventData,
  ThreadEventType,
  ResolvedThreadExecutionOptions,
  SystemErrorEventData,
  ThreadTurnInitiator,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import type { DbTransaction } from "@bb/db";
import type { AppendStoredThreadEventArgs as AppendThreadEventArgs } from "@bb/db";

export interface ClientTurnEventArgs {
  environmentId: string | null;
  execution: ResolvedThreadExecutionOptions;
  initiator: ThreadTurnInitiator;
  input: PromptInput[];
  requestMethod: "thread/start" | "turn/start";
  source: "spawn" | "tell";
  threadId: string;
  type: "client/thread/start" | "client/turn/requested" | "client/turn/start";
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
  threadId: string;
}

export interface AppendThreadProvisioningEventArgs {
  entries: ProvisioningTranscriptEntry[];
  environmentId: string;
  status: SystemThreadProvisioningStatus;
  threadId: string;
}

export interface BuildCwdBranchEntriesArgs {
  branchName: string | null;
  path: string;
}

export interface AppendThreadInterruptedEventArgs {
  message?: string;
  threadId: string;
}

const storedEventPayloadSchema = z.record(z.unknown());

function buildClientTurnEventData(
  args: ClientTurnEventArgs,
) {
  return {
    direction: "outbound" as const,
    source: args.source,
    initiator: args.initiator,
    input: args.input,
    request: {
      method: args.requestMethod,
      params: {},
    },
    execution: args.execution,
  };
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

function appendThreadEventInTransaction<TType extends ThreadEventType>(
  db: DbTransaction,
  args: AppendThreadEventArgs<TType>,
): number;
function appendThreadEventInTransaction(
  db: DbTransaction,
  args: AppendThreadEventArgs,
): number {
  return appendStoredThreadEventInTransaction(db, args);
}

export function appendClientTurnEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ClientTurnEventArgs,
): number {
  return appendThreadEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    type: args.type,
    data: buildClientTurnEventData(args),
  });
}

export function appendClientTurnEventInTransaction(
  db: DbTransaction,
  args: ClientTurnEventArgs,
): number {
  return appendThreadEventInTransaction(db, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    type: args.type,
    data: buildClientTurnEventData(args),
  });
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
    });
  } catch {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
    );
  }

  switch (event.type) {
    case "client/thread/start":
    case "client/turn/requested":
    case "client/turn/start":
      return event.execution
        ? {
            direction: event.direction,
            source: event.source,
            ...(event.initiator ? { initiator: event.initiator } : {}),
            ...(event.input ? { input: event.input } : {}),
            request: event.request,
            execution: event.execution,
          }
        : event;
    default:
      throw new ApiError(
        500,
        "internal_error",
        `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
      );
  }
}

export function appendThreadProvisioningEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendThreadProvisioningEventArgs,
): number {
  return appendThreadEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    type: "system/thread-provisioning",
    data: {
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
    data: {
      status: args.status,
      environmentId: args.environmentId,
      entries: args.entries,
    },
  });
}

export function buildCwdBranchEntries(args: BuildCwdBranchEntriesArgs): ProvisioningTranscriptEntry[] {
  const now = Date.now();
  const entries: ProvisioningTranscriptEntry[] = [
    { type: "step", key: "workspace-path", text: `Using workspace: ${args.path}`, status: "completed", startedAt: now },
  ];
  if (args.branchName) {
    entries.push({
      type: "step", key: "workspace-branch", text: `Using branch: ${args.branchName}`, status: "completed", startedAt: now,
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
    data: buildSystemErrorEventData(args),
  });
}

export function buildSystemErrorEventData(
  args: Pick<AppendSystemErrorEventArgs, "code" | "detail" | "message">,
): SystemErrorEventData {
  return systemErrorEventDataSchema.parse({
    code: args.code,
    message: args.message,
    ...(args.detail ? { detail: args.detail } : {}),
  });
}

export function appendThreadInterruptedEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendThreadInterruptedEventArgs,
): number {
  return appendThreadEvent(deps, {
    threadId: args.threadId,
    type: "system/thread/interrupted",
    data: {
      reason: "user",
      ...(args.message ? { message: args.message } : {}),
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
    data: {
      operation: "ownership_change",
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

export function requireActiveTurnId(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): string {
  const activeTurnId = getActiveTurnId(deps, threadId);
  if (activeTurnId === null) {
    throw new ApiError(409, "invalid_request", "No active turn to steer");
  }
  return activeTurnId;
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
