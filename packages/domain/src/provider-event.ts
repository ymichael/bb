import { z } from "zod";
import {
  systemErrorEventDataSchema,
  systemInteractionLifecycleEventDataSchema,
  systemPermissionGrantLifecycleEventDataSchema,
  systemLegacyUserMessageEventDataSchema,
  systemOperationEventDataSchema,
  systemProviderTurnWatchdogEventDataSchema,
  systemThreadProvisioningEventDataSchema,
  systemUserQuestionLifecycleEventDataSchema,
  systemEventTypeValues,
  systemThreadInterruptedEventDataSchema,
  clientTurnLifecycleEventDataSchema,
  turnRequestEventDataSchema,
  turnRequestRejectedEventDataSchema,
} from "./thread-events.js";
import { jsonValueSchema } from "./json-value.js";
import {
  threadEventScopeSchema,
  validateThreadEventScope,
} from "./thread-event-scope.js";
import { clientTurnRequestIdSchema } from "./protocol-ids.js";
import {
  backgroundTaskStatusSchema,
  backgroundTaskUsageSchema,
  workflowProgressSnapshotSchema,
} from "./background-task.js";
import { threadTimelineGoalStatusSchema } from "./thread-timeline-goal.js";
import { threadEventItemPresentationSchema } from "./item-presentation.js";
import { extensionKindSchema } from "./provider-extension-kind.js";

export const threadEventItemStatusSchema = z.enum([
  "pending",
  "completed",
  "failed",
  "interrupted",
]);
export type ThreadEventItemStatus = z.infer<typeof threadEventItemStatusSchema>;

const threadEventItemApprovalStatusSchema = z
  .enum(["waiting_for_approval", "denied"])
  .nullable();
export type ThreadEventItemApprovalStatus = z.infer<
  typeof threadEventItemApprovalStatusSchema
>;

export const threadEventTurnStatusSchema = z.enum([
  "completed",
  "failed",
  "interrupted",
]);
export type ThreadEventTurnStatus = z.infer<typeof threadEventTurnStatusSchema>;

const providerErrorCategoryValues = [
  "active-turn-not-steerable",
  "bad-request",
  "connection-failed",
  "context-window-exceeded",
  "billing",
  "budget-exceeded",
  "internal",
  "max-output-tokens",
  "max-turns",
  "overloaded",
  "policy",
  "rate-limit",
  "sandbox",
  "stream-disconnected",
  "structured-output-retries",
  "thread-rollback-failed",
  "too-many-failed-attempts",
  "unauthorized",
  "unknown",
] as const;
export const providerErrorCategorySchema = z.enum(providerErrorCategoryValues);
export type ProviderErrorCategory = z.infer<typeof providerErrorCategorySchema>;

export const providerErrorInfoSchema = z.object({
  category: providerErrorCategorySchema,
  providerCode: z.string().nullable(),
  httpStatusCode: z.number().nullable(),
});
export type ProviderErrorInfo = z.infer<typeof providerErrorInfoSchema>;

const providerRateLimitStatusSchema = z.enum([
  "allowed",
  "warning",
  "blocked",
  "unknown",
]);
export type ProviderRateLimitStatus = z.infer<
  typeof providerRateLimitStatusSchema
>;

const providerRateLimitWindowSchema = z.object({
  providerKey: z.string().min(1).nullable(),
  label: z.string().min(1).nullable(),
  status: providerRateLimitStatusSchema,
  resetsAtMs: z.number().int().nonnegative().nullable(),
});
export type ProviderRateLimitWindow = z.infer<
  typeof providerRateLimitWindowSchema
>;

export const providerRateLimitStateSchema = z.object({
  providerId: z.string().min(1),
  status: providerRateLimitStatusSchema,
  kind: z.enum(["subscription-window", "credits", "spend-control", "unknown"]),
  windows: z.array(providerRateLimitWindowSchema),
  reachedReason: z.string().min(1).nullable(),
  overageStatus: z
    .enum(["allowed", "warning", "rejected", "unavailable"])
    .nullable(),
  overageReason: z.string().min(1).nullable(),
});
export type ProviderRateLimitState = z.infer<
  typeof providerRateLimitStateSchema
>;

const threadEventFileChangeKindSchema = z.enum(["add", "delete", "update"]);

const threadEventFileChangeSchema = z.object({
  path: z.string(),
  kind: threadEventFileChangeKindSchema,
  movePath: z.string().optional(),
  diff: z.string().optional(),
});
export type ThreadEventFileChange = z.infer<typeof threadEventFileChangeSchema>;

const threadEventPlanStepStatusSchema = z.enum([
  "pending",
  "active",
  "completed",
  "failed",
]);

export const threadEventPlanStepSchema = z.object({
  step: z.string(),
  status: threadEventPlanStepStatusSchema.optional(),
});
export type ThreadEventPlanStep = z.infer<typeof threadEventPlanStepSchema>;

const itemPresentationField = {
  presentation: threadEventItemPresentationSchema.optional(),
};

const threadEventWebSearchItemSchema = z.object({
  type: z.literal("webSearch"),
  id: z.string(),
  queries: z.array(z.string()).min(1),
  resultText: z.string().nullable(),
  ...itemPresentationField,
  parentToolCallId: z.string().optional(),
});
export type ThreadEventWebSearchItem = z.infer<
  typeof threadEventWebSearchItemSchema
>;

const threadEventWebFetchItemSchema = z.object({
  type: z.literal("webFetch"),
  id: z.string(),
  url: z.string(),
  prompt: z.string().nullable(),
  pattern: z.string().nullable(),
  resultText: z.string().nullable(),
  ...itemPresentationField,
  parentToolCallId: z.string().optional(),
});
export type ThreadEventWebFetchItem = z.infer<
  typeof threadEventWebFetchItemSchema
>;

const threadEventImageViewItemSchema = z.object({
  type: z.literal("imageView"),
  id: z.string(),
  path: z.string(),
  ...itemPresentationField,
  parentToolCallId: z.string().optional(),
});

export const threadEventFileReadItemSchema = z.object({
  type: z.literal("fileRead"),
  id: z.string(),
  path: z.string(),
  cmd: z.string().optional(),
  status: threadEventItemStatusSchema,
  ...itemPresentationField,
  parentToolCallId: z.string().optional(),
});
export type ThreadEventFileReadItem = z.infer<
  typeof threadEventFileReadItemSchema
>;

export const threadEventSearchModeSchema = z.enum(["content", "path", "list"]);
export type ThreadEventSearchMode = z.infer<typeof threadEventSearchModeSchema>;

export const threadEventSearchItemSchema = z.object({
  type: z.literal("search"),
  id: z.string(),
  mode: threadEventSearchModeSchema,
  query: z.string(),
  path: z.string().optional(),
  cmd: z.string().optional(),
  status: threadEventItemStatusSchema,
  ...itemPresentationField,
  parentToolCallId: z.string().optional(),
});
export type ThreadEventSearchItem = z.infer<typeof threadEventSearchItemSchema>;

export const threadEventDelegationItemSchema = z.object({
  type: z.literal("delegation"),
  id: z.string(),
  childRef: z.string().min(1),
  label: z.string(),
  status: threadEventItemStatusSchema,
  background: z.boolean(),
  summary: z.string().optional(),
  ...itemPresentationField,
  parentToolCallId: z.string().optional(),
});
export type ThreadEventDelegationItem = z.infer<
  typeof threadEventDelegationItemSchema
>;

export const threadEventPlanStepsItemSchema = z.object({
  type: z.literal("planSteps"),
  id: z.string(),
  steps: z.array(threadEventPlanStepSchema),
  explanation: z.string().optional(),
  status: threadEventItemStatusSchema,
  ...itemPresentationField,
  parentToolCallId: z.string().optional(),
});
export type ThreadEventPlanStepsItem = z.infer<
  typeof threadEventPlanStepsItemSchema
>;

export const threadEventExtensionItemSchema = z.object({
  type: z.literal("extension"),
  id: z.string(),
  kind: extensionKindSchema,
  payload: jsonValueSchema,
  status: threadEventItemStatusSchema,
  presentation: threadEventItemPresentationSchema,
  parentToolCallId: z.string().optional(),
});
export type ThreadEventExtensionItem = z.infer<
  typeof threadEventExtensionItemSchema
>;

const threadEventTextTruncationSchema = z.object({
  originalLength: z.number(),
  retainedHeadLength: z.number(),
  retainedTailLength: z.number(),
  truncatedAt: z.number(),
});

const threadEventItemTruncationSchema = z.object({
  aggregatedOutput: threadEventTextTruncationSchema.optional(),
  result: threadEventTextTruncationSchema.optional(),
  resultText: threadEventTextTruncationSchema.optional(),
});

const threadEventUserContentSchema = z.discriminatedUnion("type", [
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

const threadEventContextWindowUsageSchema = z.object({
  usedTokens: z.number().nullable(),
  modelContextWindow: z.number().nullable(),
  estimated: z.boolean(),
});
export type ThreadEventContextWindowUsage = z.infer<
  typeof threadEventContextWindowUsageSchema
>;

const threadEventTokenUsageSchema = z.object({
  total: threadEventTokenUsageBreakdownSchema,
  last: threadEventTokenUsageBreakdownSchema,
  modelContextWindow: z.number().nullable(),
});

export const threadEventWarningCategorySchema = z.enum([
  "deprecation",
  "config",
  "general",
  "compaction-skipped",
]);
export type ThreadEventWarningCategory = z.infer<
  typeof threadEventWarningCategorySchema
>;

export const providerRawEventSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: jsonValueSchema.optional(),
});
export type ProviderRawEvent = z.infer<typeof providerRawEventSchema>;

const providerUnhandledEventSchema = z.object({
  type: z.literal("provider/unhandled"),
  threadId: z.string(),
  providerThreadId: z.string(),
  providerId: z.string(),
  rawType: z.string(),
  rawEvent: providerRawEventSchema,
  parentToolCallId: z.string().optional(),
});

const toolCallProgressEventSchema = z.object({
  type: z.literal("item/toolCall/progress"),
  threadId: z.string(),
  providerThreadId: z.string(),
  itemId: z.string(),
  message: z.string().optional(),
  parentToolCallId: z.string().optional(),
});

export const threadEventBackgroundTaskItemSchema = z.object({
  type: z.literal("backgroundTask"),
  id: z.string(),
  familyId: z.string().optional(),
  taskType: z.string(),
  description: z.string(),
  status: threadEventItemStatusSchema,
  taskStatus: backgroundTaskStatusSchema,
  skipTranscript: z.boolean(),
  workflowName: z.string().optional(),
  workflow: workflowProgressSnapshotSchema.optional(),
  usage: backgroundTaskUsageSchema.optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  outputFile: z.string().optional(),
  ...itemPresentationField,
  parentToolCallId: z.string().optional(),
});
export type ThreadEventBackgroundTaskItem = z.infer<
  typeof threadEventBackgroundTaskItemSchema
>;

export const threadEventItemSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("userMessage"),
      id: z.string(),
      content: z.array(threadEventUserContentSchema),
      clientRequestId: clientTurnRequestIdSchema.optional(),
      parentToolCallId: z.string().optional(),
    })
    .strict(),
  z.object({
    type: z.literal("agentMessage"),
    id: z.string(),
    text: z.string(),
    ...itemPresentationField,
    parentToolCallId: z.string().optional(),
  }),
  z.object({
    type: z.literal("commandExecution"),
    id: z.string(),
    command: z.string(),
    cwd: z.string(),
    status: threadEventItemStatusSchema,
    approvalStatus: threadEventItemApprovalStatusSchema,
    aggregatedOutput: z.string().optional(),
    exitCode: z.number().optional(),
    durationMs: z.number().optional(),
    truncation: threadEventItemTruncationSchema.optional(),
    ...itemPresentationField,
    parentToolCallId: z.string().optional(),
  }),
  z.object({
    type: z.literal("fileChange"),
    id: z.string(),
    changes: z.array(threadEventFileChangeSchema),
    status: threadEventItemStatusSchema,
    approvalStatus: threadEventItemApprovalStatusSchema,
    ...itemPresentationField,
    parentToolCallId: z.string().optional(),
  }),
  threadEventWebSearchItemSchema,
  threadEventWebFetchItemSchema,
  threadEventImageViewItemSchema,
  threadEventFileReadItemSchema,
  threadEventSearchItemSchema,
  z.object({
    type: z.literal("toolCall"),
    id: z.string(),
    server: z.string().optional(),
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    status: threadEventItemStatusSchema,
    result: z.unknown().optional(),
    error: z.string().optional(),
    durationMs: z.number().optional(),
    truncation: threadEventItemTruncationSchema.optional(),
    ...itemPresentationField,
    parentToolCallId: z.string().optional(),
  }),
  z.object({
    type: z.literal("reasoning"),
    id: z.string(),
    summary: z.array(z.string()),
    content: z.array(z.string()),
    ...itemPresentationField,
    parentToolCallId: z.string().optional(),
  }),
  z.object({
    type: z.literal("plan"),
    id: z.string(),
    text: z.string(),
    ...itemPresentationField,
    parentToolCallId: z.string().optional(),
  }),
  threadEventPlanStepsItemSchema,
  z.object({
    type: z.literal("contextCompaction"),
    id: z.string(),
    ...itemPresentationField,
    parentToolCallId: z.string().optional(),
  }),
  threadEventBackgroundTaskItemSchema,
  threadEventDelegationItemSchema,
  threadEventExtensionItemSchema,
]);
export type ThreadEventItem = z.infer<typeof threadEventItemSchema>;
export type ThreadEventItemType = ThreadEventItem["type"];

export const CORE_ITEM_KINDS = [
  "userMessage",
  "agentMessage",
  "commandExecution",
  "fileChange",
  "fileRead",
  "search",
  "webSearch",
  "webFetch",
  "imageView",
  "toolCall",
  "reasoning",
  "plan",
  "planSteps",
  "contextCompaction",
  "backgroundTask",
  "delegation",
] as const satisfies readonly Exclude<ThreadEventItemType, "extension">[];
export type CoreItemKind = (typeof CORE_ITEM_KINDS)[number];

type CoreItemKindsAreExhaustive =
  Exclude<ThreadEventItemType, "extension"> extends CoreItemKind
    ? CoreItemKind extends Exclude<ThreadEventItemType, "extension">
      ? true
      : never
    : never;
const coreItemKindsAreExhaustive: CoreItemKindsAreExhaustive = true;
void coreItemKindsAreExhaustive;

export function isCoreItemKind(value: string): value is CoreItemKind {
  return (CORE_ITEM_KINDS as readonly string[]).includes(value);
}

const unscopedProviderEventSchema = z.discriminatedUnion("type", [
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
    parentToolCallId: z.string().optional(),
  }),
  z.object({
    type: z.literal("turn/completed"),
    threadId: z.string(),
    providerThreadId: z.string().nullable(),
    status: threadEventTurnStatusSchema,
    error: z.object({ message: z.string() }).optional(),
    providerCheckpointId: z.string().min(1).optional(),
  }),
  z
    .object({
      type: z.literal("turn/input/accepted"),
      threadId: z.string(),
      providerThreadId: z.string(),
      clientRequestId: clientTurnRequestIdSchema,
      scope: threadEventScopeSchema,
    })
    .strict(),
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
    type: z.literal("thread/context/cleared"),
    threadId: z.string(),
    providerThreadId: z.string(),
  }),
  z.object({
    type: z.literal("thread/goal/updated"),
    threadId: z.string(),
    providerThreadId: z.string(),
    objective: z.string(),
    status: threadTimelineGoalStatusSchema,
    tokenBudget: z.number().nullable(),
    tokensUsed: z.number(),
    timeUsedSeconds: z.number(),
  }),
  z.object({
    type: z.literal("thread/goal/cleared"),
    threadId: z.string(),
    providerThreadId: z.string(),
  }),
  z.object({
    type: z.literal("item/started"),
    threadId: z.string(),
    providerThreadId: z.string(),
    item: threadEventItemSchema,
  }),
  z.object({
    type: z.literal("item/completed"),
    threadId: z.string(),
    providerThreadId: z.string(),
    item: threadEventItemSchema,
  }),
  z.object({
    type: z.literal("item/agentMessage/delta"),
    threadId: z.string(),
    providerThreadId: z.string(),
    itemId: z.string(),
    delta: z.string(),
    parentToolCallId: z.string().optional(),
  }),
  z.object({
    type: z.literal("item/commandExecution/outputDelta"),
    threadId: z.string(),
    providerThreadId: z.string(),
    itemId: z.string(),
    delta: z.string(),
    reset: z.boolean().optional(),
    parentToolCallId: z.string().optional(),
  }),
  z.object({
    type: z.literal("item/fileChange/outputDelta"),
    threadId: z.string(),
    providerThreadId: z.string(),
    itemId: z.string(),
    delta: z.string(),
    parentToolCallId: z.string().optional(),
  }),
  z.object({
    type: z.literal("item/reasoning/summaryTextDelta"),
    threadId: z.string(),
    providerThreadId: z.string(),
    itemId: z.string(),
    delta: z.string(),
    parentToolCallId: z.string().optional(),
  }),
  z.object({
    type: z.literal("item/reasoning/textDelta"),
    threadId: z.string(),
    providerThreadId: z.string(),
    itemId: z.string(),
    delta: z.string(),
    parentToolCallId: z.string().optional(),
  }),
  z.object({
    type: z.literal("item/plan/delta"),
    threadId: z.string(),
    providerThreadId: z.string(),
    itemId: z.string(),
    delta: z.string(),
    parentToolCallId: z.string().optional(),
  }),
  z.object({
    type: z.literal("item/mcpToolCall/progress"),
    threadId: z.string(),
    providerThreadId: z.string(),
    itemId: z.string(),
    message: z.string().optional(),
    parentToolCallId: z.string().optional(),
  }),
  toolCallProgressEventSchema,
  z.object({
    type: z.literal("item/backgroundTask/progress"),
    threadId: z.string(),
    providerThreadId: z.string(),
    item: threadEventBackgroundTaskItemSchema,
  }),
  z.object({
    type: z.literal("item/backgroundTask/completed"),
    threadId: z.string(),
    providerThreadId: z.string(),
    item: threadEventBackgroundTaskItemSchema,
  }),
  z.object({
    type: z.literal("item/delegation/progress"),
    threadId: z.string(),
    providerThreadId: z.string(),
    item: threadEventDelegationItemSchema,
  }),
  z.object({
    type: z.literal("item/delegation/completed"),
    threadId: z.string(),
    providerThreadId: z.string(),
    item: threadEventDelegationItemSchema,
  }),
  z.object({
    type: z.literal("thread/tokenUsage/updated"),
    threadId: z.string(),
    providerThreadId: z.string(),
    tokenUsage: threadEventTokenUsageSchema,
  }),
  z.object({
    type: z.literal("thread/contextWindowUsage/updated"),
    threadId: z.string(),
    providerThreadId: z.string(),
    contextWindowUsage: threadEventContextWindowUsageSchema,
  }),
  z.object({
    type: z.literal("turn/plan/updated"),
    threadId: z.string(),
    providerThreadId: z.string(),
    plan: z.array(threadEventPlanStepSchema),
    explanation: z.string().optional(),
  }),
  z.object({
    type: z.literal("turn/diff/updated"),
    threadId: z.string(),
    providerThreadId: z.string(),
    diff: z.string().optional(),
  }),
  z.object({
    type: z.literal("provider/error"),
    threadId: z.string(),
    providerThreadId: z.string(),
    message: z.string(),
    detail: z.string().optional(),
    willRetry: z.boolean().optional(),
    errorInfo: providerErrorInfoSchema.optional(),
  }),
  z.object({
    type: z.literal("provider/rateLimits/updated"),
    threadId: z.string(),
    providerThreadId: z.string(),
    rateLimits: providerRateLimitStateSchema,
  }),
  z.object({
    type: z.literal("provider.env-resolved"),
    threadId: z.string(),
    providerThreadId: z.string(),
    entries: z.array(
      z
        .object({
          name: z.string(),
          source: z.union([
            z.literal("shell"),
            z.object({ plugin: z.string() }).strict(),
          ]),
          value: z.union([
            z.string(),
            z.object({ masked: z.literal(true) }).strict(),
          ]),
          reason: z.string().optional(),
        })
        .strict(),
    ),
  }),
  z.object({
    type: z.literal("thread/extensionState/updated"),
    threadId: z.string(),
    providerThreadId: z.string(),
    kind: extensionKindSchema,
    payload: jsonValueSchema,
  }),
  z.object({
    type: z.literal("provider/warning"),
    threadId: z.string(),
    providerThreadId: z.string(),
    category: threadEventWarningCategorySchema,
    summary: z.string().optional(),
    details: z.string().optional(),
  }),
  z.object({
    type: z.literal("provider/modelFallback"),
    threadId: z.string(),
    providerThreadId: z.string(),
    originalModel: z.string().min(1),
    fallbackModel: z.string().min(1),
    reason: z.enum(["refusal", "provider"]),
    message: z.string(),
  }),
  providerUnhandledEventSchema,
]);
const scopedEventDataSchema = z.object({
  scope: threadEventScopeSchema,
});
const providerEventSchema = unscopedProviderEventSchema.and(
  scopedEventDataSchema,
);
type ProviderEvent = z.infer<typeof providerEventSchema>;
export type ProviderUnhandledEvent = Extract<
  ProviderEvent,
  { type: "provider/unhandled" }
>;
const providerEventTypeValues = unscopedProviderEventSchema.options.map(
  (option) => option.shape.type.value,
);

const unscopedSystemEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("client/thread/start"),
      threadId: z.string(),
    })
    .merge(clientTurnLifecycleEventDataSchema),
  z
    .object({
      type: z.literal("client/turn/requested"),
      threadId: z.string(),
    })
    .merge(turnRequestEventDataSchema),
  z
    .object({
      type: z.literal("client/turn/rejected"),
      threadId: z.string(),
    })
    .merge(turnRequestRejectedEventDataSchema),
  z
    .object({
      type: z.literal("client/turn/start"),
      threadId: z.string(),
    })
    .merge(clientTurnLifecycleEventDataSchema),
  z
    .object({
      type: z.literal("system/error"),
      threadId: z.string(),
    })
    .merge(systemErrorEventDataSchema),
  z
    .object({
      type: z.literal("system/manager/user_message"),
      threadId: z.string(),
    })
    .merge(systemLegacyUserMessageEventDataSchema),
  z
    .object({
      type: z.literal("system/thread/interrupted"),
      threadId: z.string(),
    })
    .merge(systemThreadInterruptedEventDataSchema),
  z
    .object({
      type: z.literal("system/operation"),
      threadId: z.string(),
    })
    .merge(systemOperationEventDataSchema),
  z
    .object({
      type: z.literal("system/interaction/lifecycle"),
      threadId: z.string(),
    })
    .merge(systemInteractionLifecycleEventDataSchema),
  z
    .object({
      type: z.literal("system/permissionGrant/lifecycle"),
      threadId: z.string(),
    })
    .merge(systemPermissionGrantLifecycleEventDataSchema),
  z
    .object({
      type: z.literal("system/userQuestion/lifecycle"),
      threadId: z.string(),
    })
    .merge(systemUserQuestionLifecycleEventDataSchema),
  z
    .object({
      type: z.literal("system/thread-provisioning"),
      threadId: z.string(),
    })
    .merge(systemThreadProvisioningEventDataSchema),
  z
    .object({
      type: z.literal("system/provider-turn-watchdog"),
      threadId: z.string(),
    })
    .merge(systemProviderTurnWatchdogEventDataSchema),
]);
const systemEventSchema = unscopedSystemEventSchema.and(scopedEventDataSchema);

const legacyClientRequestKey = ["clientRequest", "Sequence"].join("");

function isEventPropertyBag(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const rejectLegacyClientRequestSequenceSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (!isEventPropertyBag(value)) {
      return;
    }

    if (Object.hasOwn(value, legacyClientRequestKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "legacy request sequence field is no longer accepted",
        path: [legacyClientRequestKey],
      });
    }

    const item = value.item;
    if (
      isEventPropertyBag(item) &&
      item.type === "userMessage" &&
      Object.hasOwn(item, legacyClientRequestKey)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "legacy user-message request sequence field is no longer accepted",
        path: ["item", legacyClientRequestKey],
      });
    }
  });

export const threadEventSchema = rejectLegacyClientRequestSequenceSchema.pipe(
  z
    .union([providerEventSchema, systemEventSchema])
    .superRefine((event, ctx) => {
      const result = validateThreadEventScope({
        type: event.type,
        scope: event.scope,
      });
      if (!result.valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: result.message ?? "Invalid thread event scope",
          path: ["scope"],
        });
        return;
      }
    }),
);
export type ThreadEvent = z.infer<typeof threadEventSchema>;
export type ThreadEventType = ThreadEvent["type"];

export type ThreadEventWithItem = Extract<
  ThreadEvent,
  {
    type:
      | "item/started"
      | "item/completed"
      | "item/delegation/progress"
      | "item/delegation/completed"
      | "item/backgroundTask/progress"
      | "item/backgroundTask/completed";
  }
>;

export function isThreadEventWithItem(
  event: ThreadEvent,
): event is ThreadEventWithItem {
  switch (event.type) {
    case "item/started":
    case "item/completed":
    case "item/delegation/progress":
    case "item/delegation/completed":
    case "item/backgroundTask/progress":
    case "item/backgroundTask/completed":
      return true;
    default:
      return false;
  }
}
export const threadEventTypeValues = [
  ...providerEventTypeValues,
  ...systemEventTypeValues,
] as const;
const threadEventTypeSet = new Set<string>(threadEventTypeValues);
export const threadEventTypeSchema = z
  .string()
  .refine(
    (value): value is ThreadEventType => threadEventTypeSet.has(value),
    "Invalid thread event type",
  );
