import { z } from "zod";
import {
  threadEventSchema,
  threadEventTypeSchema,
} from "./provider-event.js";
import type { ThreadEvent, ThreadEventType } from "./provider-event.js";

type ThreadEventForType<TType extends ThreadEventType> = Extract<
  ThreadEvent,
  { type: TType }
>;

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

export interface ThreadEventRowOfType<TType extends ThreadEventType>
  extends ThreadEventRowBase {
  type: TType;
  data: StoredThreadEventDataForType<TType>;
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
    ...(args.providerThreadId ? { providerThreadId: args.providerThreadId } : {}),
    ...(args.turnId ? { turnId: args.turnId } : {}),
    threadId: args.threadId,
    type: args.type,
  });
}

export function buildThreadEventRow(
  args: ThreadEventRowBase & { event: ThreadEvent },
): ThreadEventRow {
  switch (args.event.type) {
    case "thread/started":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "thread/identity":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "turn/started":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "turn/completed":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "thread/name/updated":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "thread/compacted":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "item/started":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "item/completed":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "item/agentMessage/delta":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "item/commandExecution/outputDelta":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "item/fileChange/outputDelta":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "item/reasoning/summaryTextDelta":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "item/reasoning/textDelta":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "item/plan/delta":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "item/mcpToolCall/progress":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "item/toolCall/progress":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "thread/tokenUsage/updated":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "turn/plan/updated":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "turn/diff/updated":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "error":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "warning":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "provider/unhandled":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "client/thread/start":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "client/turn/requested":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "client/turn/start":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "system/error":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "system/manager/user_message":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "system/thread/interrupted":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "system/thread-title/updated":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "system/operation":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
    case "system/provisioning":
      return { ...args, type: args.event.type, data: toStoredThreadEventData(args.event) };
  }
}

export function buildThreadEvent(row: ThreadEventRow): ThreadEvent {
  switch (row.type) {
    case "thread/started":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "thread/identity":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "turn/started":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "turn/completed":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "thread/name/updated":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "thread/compacted":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "item/started":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "item/completed":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "item/agentMessage/delta":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "item/commandExecution/outputDelta":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "item/fileChange/outputDelta":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "item/reasoning/summaryTextDelta":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "item/reasoning/textDelta":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "item/plan/delta":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "item/mcpToolCall/progress":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "item/toolCall/progress":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "thread/tokenUsage/updated":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "turn/plan/updated":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "turn/diff/updated":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "error":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "warning":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "provider/unhandled":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "client/thread/start":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "client/turn/requested":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "client/turn/start":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "system/error":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "system/manager/user_message":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "system/thread/interrupted":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "system/thread-title/updated":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "system/operation":
      return { ...row.data, threadId: row.threadId, type: row.type };
    case "system/provisioning":
      return { ...row.data, threadId: row.threadId, type: row.type };
  }
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
