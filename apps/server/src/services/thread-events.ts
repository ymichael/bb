import { eq, max, sql } from "drizzle-orm";
import {
  createEventId,
  deriveStoredEventItemFieldsFromSource,
  events,
} from "@bb/db";
import {
  systemErrorEventDataSchema,
  turnRequestEventDataSchema,
} from "@bb/domain";
import type {
  PromptInput,
  ProvisioningTranscriptEntry,
  StoredThreadEventDataForType,
  TurnRequestEventData,
  ThreadEventType,
  ResolvedThreadExecutionOptions,
  SystemErrorEventData,
  ThreadTurnInitiator,
} from "@bb/domain";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";

export type AppendThreadEventArgs<TType extends ThreadEventType = ThreadEventType> = {
  [TEventType in TType]: {
    data: StoredThreadEventDataForType<TEventType>;
    environmentId?: string | null;
    providerThreadId?: string | null;
    threadId: string;
    turnId?: string | null;
    type: TEventType;
  };
}[TType];

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

export interface StoredTurnRequestEventRow {
  data: string;
  sequence: number;
  threadId: string;
  type: ThreadEventType;
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

export function appendThreadEvent<TType extends ThreadEventType>(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendThreadEventArgs<TType>,
): number;
export function appendThreadEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AppendThreadEventArgs,
): number {
  const now = Date.now();
  const nextSequence = deps.db.transaction(
    (tx) => {
      const maxRow = tx
        .select({ maxSeq: max(events.sequence) })
        .from(events)
        .where(eq(events.threadId, args.threadId))
        .get();
      const sequence = (maxRow?.maxSeq ?? 0) + 1;
      const itemFields = deriveStoredEventItemFieldsFromSource({
        type: args.type,
        item: "item" in args.data ? args.data.item : undefined,
        itemId: "itemId" in args.data ? args.data.itemId : undefined,
      });

      tx.run(
        sql`INSERT INTO events
          (id, thread_id, environment_id, turn_id, provider_thread_id, sequence, type, item_id, item_kind, data, created_at)
          VALUES (
            ${createEventId()},
            ${args.threadId},
            ${args.environmentId ?? null},
            ${args.turnId ?? null},
            ${args.providerThreadId ?? null},
            ${sequence},
            ${args.type},
            ${itemFields.itemId},
            ${itemFields.itemKind},
            ${JSON.stringify(args.data)},
            ${now}
          )`,
      );

      return sequence;
    },
    { behavior: "immediate" },
  );

  deps.hub.notifyThread(args.threadId, ["events-appended"]);
  return nextSequence;
}

export function appendClientTurnEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ClientTurnEventArgs,
): number {
  return appendThreadEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    type: args.type,
    data: {
      direction: "outbound",
      source: args.source,
      initiator: args.initiator,
      input: args.input,
      request: {
        method: args.requestMethod,
        params: {},
      },
      execution: args.execution,
    },
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

  const parsed = turnRequestEventDataSchema.safeParse(eventData);
  if (!parsed.success) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored ${row.type} event #${row.sequence} for thread ${row.threadId} is malformed`,
    );
  }

  return parsed.data;
}

export function appendProvisioningEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    entries: ProvisioningTranscriptEntry[];
    environmentId: string;
    status: "completed" | "failed" | "in_progress" | "started";
    threadId: string;
  },
): number {
  return appendThreadEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    type: "system/provisioning",
    data: {
      status: args.status,
      environmentId: args.environmentId,
      entries: args.entries,
    },
  });
}

export function buildCwdBranchEntries(args: {
  path: string;
  branchName?: string | null;
}): ProvisioningTranscriptEntry[] {
  const now = Date.now();
  const entries: ProvisioningTranscriptEntry[] = [
    { type: "step", key: "cwd", text: `cwd: ${args.path}`, status: "completed", startedAt: now },
  ];
  if (args.branchName) {
    entries.push({
      type: "step", key: "branch", text: `Branch: ${args.branchName}`, status: "completed", startedAt: now,
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
  args: {
    message?: string;
    threadId: string;
  },
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

export function appendThreadTitleUpdatedEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    nextTitle: string;
    previousTitle?: string | null;
    threadId: string;
  },
): number {
  return appendThreadEvent(deps, {
    threadId: args.threadId,
    type: "system/thread-title/updated",
    data: {
      title: args.nextTitle,
      ...(args.previousTitle ? { previousTitle: args.previousTitle } : {}),
      source: "provider",
      providerMethod: "server/thread-title",
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

export function getLastTurnId(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): string | null {
  const row = deps.db
    .select({ turnId: events.turnId })
    .from(events)
    .where(
      sql`${events.threadId} = ${threadId} AND ${events.turnId} IS NOT NULL`,
    )
    .orderBy(sql`${events.sequence} DESC`)
    .limit(1)
    .get();
  return row?.turnId ?? null;
}

export function getLastProviderThreadId(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): string | null {
  const row = deps.db
    .select({ providerThreadId: events.providerThreadId })
    .from(events)
    .where(
      sql`${events.threadId} = ${threadId}
        AND ${events.providerThreadId} IS NOT NULL`,
    )
    .orderBy(sql`${events.sequence} DESC`)
    .limit(1)
    .get();
  return row?.providerThreadId ?? null;
}

export function getLastExecutionOptions(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): ResolvedThreadExecutionOptions | null {
  const row = deps.db
    .select({
      data: events.data,
      sequence: events.sequence,
      threadId: events.threadId,
      type: events.type,
    })
    .from(events)
    .where(
      sql`${events.threadId} = ${threadId}
        AND ${events.type} IN ('client/thread/start', 'client/turn/requested', 'client/turn/start')`,
    )
    .orderBy(sql`${events.sequence} DESC`)
    .limit(1)
    .get();

  return row
    ? parseStoredTurnRequestEvent({
        data: row.data,
        sequence: row.sequence,
        threadId: row.threadId,
        type: row.type,
      }).execution
    : null;
}
