import { z } from "zod";
import { resolvedThreadExecutionOptionsSchema } from "./shared-types.js";
import { threadEventSchema, threadEventTypeSchema } from "./provider-event.js";
import {
  turnRequestEventDataSchema,
  turnRequestTargetSchema,
} from "./thread-events.js";
import {
  threadEventScopeSchema,
  type ThreadEventScope,
} from "./thread-event-scope.js";
import type { ThreadEvent, ThreadEventType } from "./provider-event.js";
import type { TurnRequestTarget } from "./thread-events.js";

type ThreadEventByType = {
  [TType in ThreadEventType]: Extract<ThreadEvent, { type: TType }>;
};

type ThreadEventForType<TType extends ThreadEventType> =
  ThreadEventByType[TType];

type StoredThreadEventDataFromEvent<TEvent extends ThreadEvent> = Omit<
  TEvent,
  "threadId" | "type" | "scope"
>;

interface ThreadEventRowBase {
  id: string;
  scope: ThreadEventScope;
  threadId: string;
  seq: number;
  createdAt: number;
}

interface ThreadEventRowInput extends ThreadEventRowBase {
  type: ThreadEventType;
  data: Record<string, unknown>;
}

export interface StoredThreadEventParseArgs {
  data: Record<string, unknown>;
  providerThreadId?: string | null;
  scope: ThreadEventScope;
  threadId: string;
  type: ThreadEventType;
}

export type StoredThreadEventDataByType = {
  [TType in ThreadEventType]: StoredThreadEventDataFromEvent<
    ThreadEventForType<TType>
  >;
};

export type StoredThreadEventData =
  StoredThreadEventDataByType[ThreadEventType];

export type StoredThreadEventDataForType<TType extends ThreadEventType> =
  StoredThreadEventDataByType[TType];

type ThreadEventRowFromEvent<TEvent extends ThreadEvent> =
  ThreadEventRowBase & {
    type: TEvent["type"];
    data: StoredThreadEventDataFromEvent<TEvent>;
  };

export type ThreadEventRowOfType<TType extends ThreadEventType> =
  ThreadEventRowFromEvent<ThreadEventForType<TType>>;

export type ThreadEventRow = {
  [TType in ThreadEventType]: ThreadEventRowOfType<TType>;
}[ThreadEventType];

export type ThreadEventOfType<TType extends ThreadEventType> = Extract<
  ThreadEventRow,
  { type: TType }
>;

const threadEventRowInputSchema = z.object({
  id: z.string(),
  scope: threadEventScopeSchema,
  threadId: z.string(),
  seq: z.number(),
  type: threadEventTypeSchema,
  data: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
});

const storedTurnRequestTypeSet = new Set<ThreadEventType>([
  "client/turn/requested",
]);

const LEGACY_TURN_REQUEST_TARGET = {
  kind: "new-turn",
} satisfies TurnRequestTarget;

const storedTurnRequestEventDataSchema = turnRequestEventDataSchema.extend({
  target: turnRequestTargetSchema.default(LEGACY_TURN_REQUEST_TARGET),
  execution: resolvedThreadExecutionOptionsSchema,
});

function parseStoredTurnRequestEventData(
  args: StoredThreadEventParseArgs,
): StoredThreadEventParseArgs["data"] {
  return storedTurnRequestEventDataSchema.parse(args.data);
}

function toStoredThreadEventData<TEvent extends ThreadEvent>(
  event: TEvent,
): StoredThreadEventDataFromEvent<TEvent> {
  const { scope: _scope, threadId: _threadId, type: _type, ...data } = event;
  return data;
}

function omitStoredScopeFields(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const { scope: _scope, turnId: _turnId, ...rest } = data;
  return rest;
}

export function parseStoredThreadEvent(
  args: StoredThreadEventParseArgs,
): ThreadEvent {
  const scopeResult = threadEventScopeSchema.safeParse(args.scope);
  if (!scopeResult.success) {
    throw new Error("Stored thread event is missing valid scope");
  }
  const scope = scopeResult.data;
  const eventData = storedTurnRequestTypeSet.has(args.type)
    ? parseStoredTurnRequestEventData(args)
    : args.data;

  return threadEventSchema.parse({
    ...omitStoredScopeFields(eventData),
    ...(args.providerThreadId != null
      ? { providerThreadId: args.providerThreadId }
      : {}),
    scope,
    threadId: args.threadId,
    type: args.type,
  });
}

export function buildThreadEventRow(
  args: ThreadEventRowBase & { event: ThreadEvent },
): ThreadEventRow;
export function buildThreadEventRow<TEvent extends ThreadEvent>(
  args: ThreadEventRowBase & { event: TEvent },
): ThreadEventRowFromEvent<TEvent>;
export function buildThreadEventRow<TEvent extends ThreadEvent>(
  args: ThreadEventRowBase & { event: TEvent },
): ThreadEventRowFromEvent<TEvent> {
  const { event, ...row } = args;
  return {
    ...row,
    type: event.type,
    data: toStoredThreadEventData(event),
  };
}

export function buildThreadEvent(row: ThreadEventRow): ThreadEvent {
  return parseStoredThreadEvent({
    data: row.data,
    providerThreadId:
      "providerThreadId" in row.data ? row.data.providerThreadId : undefined,
    scope: row.scope,
    threadId: row.threadId,
    type: row.type,
  });
}

export function isThreadEventRowOfType<TType extends ThreadEventType>(
  row: ThreadEventRow,
  type: TType,
): row is ThreadEventOfType<TType> {
  return row.type === type;
}

function parseThreadEventRowInput(row: ThreadEventRowInput): ThreadEventRow {
  return buildThreadEventRow({
    id: row.id,
    scope: row.scope,
    threadId: row.threadId,
    seq: row.seq,
    createdAt: row.createdAt,
    event: parseStoredThreadEvent({
      type: row.type,
      data: row.data,
      threadId: row.threadId,
      scope: row.scope,
    }),
  });
}

export function parseThreadEventRow(value: unknown): ThreadEventRow {
  const row = threadEventRowInputSchema.parse(value);
  return parseThreadEventRowInput(row);
}

export const threadEventRowSchema =
  threadEventRowInputSchema.transform<ThreadEventRow>((row) =>
    parseThreadEventRowInput(row),
  );
