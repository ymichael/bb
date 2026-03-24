import { z } from "zod";
import {
  systemErrorEventDataSchema,
  systemManagerUserMessageEventDataSchema,
  systemOperationEventDataSchema,
  systemProvisioningEventDataSchema,
  systemThreadInterruptedEventDataSchema,
  systemThreadTitleUpdatedEventDataSchema,
  turnRequestEventDataSchema,
} from "./thread-events.js";

export const threadEventItemStatusSchema = z.enum([
  "pending",
  "completed",
  "failed",
  "interrupted",
]);
export type ThreadEventItemStatus = z.infer<typeof threadEventItemStatusSchema>;

export const threadEventTurnStatusSchema = z.enum([
  "completed",
  "failed",
  "interrupted",
]);
export type ThreadEventTurnStatus = z.infer<typeof threadEventTurnStatusSchema>;

export const threadEventFileChangeKindSchema = z.enum([
  "add",
  "delete",
  "update",
]);
export type ThreadEventFileChangeKind = z.infer<
  typeof threadEventFileChangeKindSchema
>;

export const threadEventFileChangeSchema = z.object({
  path: z.string(),
  kind: threadEventFileChangeKindSchema,
  movePath: z.string().optional(),
  diff: z.string().optional(),
});
export type ThreadEventFileChange = z.infer<typeof threadEventFileChangeSchema>;

export const threadEventPlanStepStatusSchema = z.enum([
  "pending",
  "active",
  "completed",
  "failed",
]);
export type ThreadEventPlanStepStatus = z.infer<
  typeof threadEventPlanStepStatusSchema
>;

export const threadEventPlanStepSchema = z.object({
  step: z.string(),
  status: threadEventPlanStepStatusSchema.optional(),
});
export type ThreadEventPlanStep = z.infer<typeof threadEventPlanStepSchema>;

export const threadEventUserContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), url: z.string() }),
  z.object({ type: z.literal("localImage"), path: z.string() }),
  z.object({ type: z.literal("localFile"), path: z.string() }),
]);
export type ThreadEventUserContent = z.infer<
  typeof threadEventUserContentSchema
>;

export const threadEventTokenUsageBreakdownSchema = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
});
export type ThreadEventTokenUsageBreakdown = z.infer<
  typeof threadEventTokenUsageBreakdownSchema
>;

export const threadEventTokenUsageSchema = z.object({
  total: threadEventTokenUsageBreakdownSchema,
  last: threadEventTokenUsageBreakdownSchema,
  modelContextWindow: z.number().nullable(),
});
export type ThreadEventTokenUsage = z.infer<typeof threadEventTokenUsageSchema>;

export const threadEventWarningCategorySchema = z.enum([
  "deprecation",
  "config",
  "general",
]);
export type ThreadEventWarningCategory = z.infer<
  typeof threadEventWarningCategorySchema
>;

export const threadEventItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("userMessage"),
    id: z.string(),
    content: z.array(threadEventUserContentSchema),
  }),
  z.object({
    type: z.literal("agentMessage"),
    id: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("commandExecution"),
    id: z.string(),
    command: z.string(),
    cwd: z.string(),
    status: threadEventItemStatusSchema,
    aggregatedOutput: z.string().optional(),
    exitCode: z.number().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({
    type: z.literal("fileChange"),
    id: z.string(),
    changes: z.array(threadEventFileChangeSchema),
    status: threadEventItemStatusSchema,
  }),
  z.object({
    type: z.literal("webSearch"),
    id: z.string(),
    query: z.string(),
    action: z.string().optional(),
  }),
  z.object({
    type: z.literal("toolCall"),
    id: z.string(),
    server: z.string().optional(),
    tool: z.string(),
    arguments: z.unknown().optional(),
    status: threadEventItemStatusSchema,
    result: z.unknown().optional(),
    error: z.string().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({
    type: z.literal("reasoning"),
    id: z.string(),
    summary: z.array(z.string()),
    content: z.array(z.string()),
  }),
  z.object({
    type: z.literal("plan"),
    id: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("contextCompaction"),
    id: z.string(),
  }),
]);
export type ThreadEventItem = z.infer<typeof threadEventItemSchema>;

/**
 * Events originating from a provider process via the agent runtime.
 * These carry `providerThreadId` — the provider's internal session/thread ID.
 */
export const providerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("thread/started"),
    threadId: z.string(),
  }),
  z.object({
    type: z.literal("thread/identity"),
    threadId: z.string(),
    providerThreadId: z.string(),
  }),
  z.object({
    type: z.literal("turn/started"),
    threadId: z.string(),
    providerThreadId: z.string(),
    turnId: z.string(),
  }),
  z.object({
    type: z.literal("turn/completed"),
    threadId: z.string(),
    providerThreadId: z.string(),
    turnId: z.string(),
    status: threadEventTurnStatusSchema,
    error: z.object({ message: z.string() }).optional(),
  }),
  z.object({
    type: z.literal("thread/name/updated"),
    threadId: z.string(),
    providerThreadId: z.string(),
    threadName: z.string(),
  }),
  z.object({
    type: z.literal("thread/compacted"),
    threadId: z.string(),
    providerThreadId: z.string(),
  }),
  z.object({
    type: z.literal("item/started"),
    threadId: z.string(),
    providerThreadId: z.string(),
    turnId: z.string(),
    item: threadEventItemSchema,
  }),
  z.object({
    type: z.literal("item/completed"),
    threadId: z.string(),
    providerThreadId: z.string(),
    turnId: z.string(),
    item: threadEventItemSchema,
  }),
  z.object({
    type: z.literal("item/agentMessage/delta"),
    threadId: z.string(),
    providerThreadId: z.string(),
    turnId: z.string(),
    itemId: z.string().optional(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("item/commandExecution/outputDelta"),
    threadId: z.string(),
    providerThreadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("item/fileChange/outputDelta"),
    threadId: z.string(),
    providerThreadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("item/reasoning/summaryTextDelta"),
    threadId: z.string(),
    providerThreadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("item/reasoning/textDelta"),
    threadId: z.string(),
    providerThreadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("item/plan/delta"),
    threadId: z.string(),
    providerThreadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("item/mcpToolCall/progress"),
    threadId: z.string(),
    providerThreadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal("thread/tokenUsage/updated"),
    threadId: z.string(),
    providerThreadId: z.string(),
    turnId: z.string(),
    tokenUsage: threadEventTokenUsageSchema,
  }),
  z.object({
    type: z.literal("turn/plan/updated"),
    threadId: z.string(),
    providerThreadId: z.string(),
    turnId: z.string(),
    plan: z.array(threadEventPlanStepSchema),
    explanation: z.string().optional(),
  }),
  z.object({
    type: z.literal("turn/diff/updated"),
    threadId: z.string(),
    providerThreadId: z.string(),
    turnId: z.string(),
    diff: z.string().optional(),
  }),
  z.object({
    type: z.literal("error"),
    threadId: z.string(),
    providerThreadId: z.string(),
    turnId: z.string().optional(),
    message: z.string(),
    detail: z.string().optional(),
    willRetry: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("warning"),
    threadId: z.string(),
    providerThreadId: z.string(),
    category: threadEventWarningCategorySchema,
    summary: z.string().optional(),
    details: z.string().optional(),
  }),
]);
export type ProviderEvent = z.infer<typeof providerEventSchema>;

/**
 * Events originating from the server/system layer (not from a provider process).
 * These do NOT carry `providerThreadId`.
 */
export const systemEventSchema = z.union([
  z.object({
    type: z.literal("client/thread/start"),
    threadId: z.string(),
  }).merge(turnRequestEventDataSchema),
  z.object({
    type: z.literal("client/turn/requested"),
    threadId: z.string(),
  }).merge(turnRequestEventDataSchema),
  z.object({
    type: z.literal("client/turn/start"),
    threadId: z.string(),
  }).merge(turnRequestEventDataSchema),
  z.object({
    type: z.literal("system/error"),
    threadId: z.string(),
  }).merge(systemErrorEventDataSchema),
  z.object({
    type: z.literal("system/manager/user_message"),
    threadId: z.string(),
  }).merge(systemManagerUserMessageEventDataSchema),
  z.object({
    type: z.literal("system/thread/interrupted"),
    threadId: z.string(),
  }).merge(systemThreadInterruptedEventDataSchema),
  z.object({
    type: z.literal("system/thread-title/updated"),
    threadId: z.string(),
  }).merge(systemThreadTitleUpdatedEventDataSchema),
  z.object({
    type: z.literal("system/operation"),
    threadId: z.string(),
  }).merge(systemOperationEventDataSchema),
  z.object({
    type: z.literal("system/provisioning"),
    threadId: z.string(),
  }).merge(systemProvisioningEventDataSchema),
]);
export type SystemEvent = z.infer<typeof systemEventSchema>;

/** All thread events — provider-originated or system-originated. */
export const threadEventSchema = z.union([
  providerEventSchema,
  systemEventSchema,
]);
export type ThreadEvent = z.infer<typeof threadEventSchema>;

export type ThreadEventType = ThreadEvent["type"];
