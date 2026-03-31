import { z } from "zod";
import {
  threadEventSchema,
  threadEventTypeSchema,
} from "./provider-event.js";
import type { ThreadEvent, ThreadEventType } from "./provider-event.js";

type ThreadEventByType = {
  [TType in ThreadEventType]: Extract<ThreadEvent, { type: TType }>;
};

type ThreadEventForType<TType extends ThreadEventType> = ThreadEventByType[TType];

type StoredThreadEventDataFromEvent<TEvent extends ThreadEvent> = Omit<
  TEvent,
  "threadId" | "type"
>;

interface ThreadEventRowBase {
  id: string;
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
  threadId: string;
  turnId?: string | null;
  type: ThreadEventType;
}

export type StoredThreadEventDataByType = {
  [TType in ThreadEventType]: StoredThreadEventDataFromEvent<
    ThreadEventForType<TType>
  >;
};

export type StoredThreadEventData = StoredThreadEventDataByType[ThreadEventType];

export type StoredThreadEventDataForType<TType extends ThreadEventType> =
  StoredThreadEventDataByType[TType];

type ThreadEventRowFromEvent<TEvent extends ThreadEvent> = ThreadEventRowBase & {
  type: TEvent["type"];
  data: StoredThreadEventDataFromEvent<TEvent>;
};

export type ThreadEventRowOfType<TType extends ThreadEventType> =
  ThreadEventRowFromEvent<ThreadEventForType<TType>>;

export type ThreadEventRow = {
  [TType in ThreadEventType]: ThreadEventRowOfType<TType>;
}[ThreadEventType];

export type ThreadEventOfType<TType extends ThreadEventType> =
  Extract<ThreadEventRow, { type: TType }>;

const threadEventRowInputSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  seq: z.number(),
  type: threadEventTypeSchema,
  data: z.record(z.unknown()),
  createdAt: z.number(),
});

function toStoredThreadEventData<TEvent extends ThreadEvent>(
  event: TEvent,
): StoredThreadEventDataFromEvent<TEvent> {
  const { threadId: _threadId, type: _type, ...data } = event;
  return data;
}

export function parseStoredThreadEvent(
  args: StoredThreadEventParseArgs,
): ThreadEvent {
  return threadEventSchema.parse({
    ...args.data,
    ...(args.providerThreadId != null ? { providerThreadId: args.providerThreadId } : {}),
    ...(args.turnId != null ? { turnId: args.turnId } : {}),
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
    threadId: row.threadId,
    turnId: "turnId" in row.data ? row.data.turnId : undefined,
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
    threadId: row.threadId,
    seq: row.seq,
    createdAt: row.createdAt,
    event: parseStoredThreadEvent({
      type: row.type,
      data: row.data,
      threadId: row.threadId,
    }),
  });
}

export function parseThreadEventRow(value: unknown): ThreadEventRow {
  const row = threadEventRowInputSchema.parse(value);
  return parseThreadEventRowInput(row);
}

export const threadEventRowSchema = threadEventRowInputSchema.transform<ThreadEventRow>(
  (row) => parseThreadEventRowInput(row),
);
