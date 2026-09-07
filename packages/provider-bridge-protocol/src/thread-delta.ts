import {
  backgroundTaskStatusSchema,
  backgroundTaskUsageSchema,
  clientTurnRequestIdSchema,
  extensionKindSchema,
  jsonValueSchema,
  providerErrorCategorySchema,
  providerErrorInfoSchema,
  providerRateLimitStateSchema,
  providerRawEventSchema,
  threadEventItemPresentationSchema,
  threadEventItemStatusSchema,
  threadEventPlanStepSchema,
  threadEventSearchModeSchema,
  threadEventTokenUsageBreakdownSchema,
  threadEventTurnStatusSchema,
  threadEventWarningCategorySchema,
  workflowProgressSnapshotSchema,
} from "@bb/domain";
import { z } from "zod";

export const THREAD_DELTA_NOTIFICATION_METHOD = "thread/delta";

export const deltaPresentationSchema = threadEventItemPresentationSchema;
export type DeltaPresentation = z.infer<typeof deltaPresentationSchema>;

export const THREAD_DELTA_KEY_SEPARATOR = "\u001f";

const deltaKeyPartSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes(THREAD_DELTA_KEY_SEPARATOR), {
    message:
      "provider keys must not contain the internal key separator (\\u001f)",
  });

export const deltaItemKeySchema = z.object({
  providerItemId: deltaKeyPartSchema.optional(),
  channel: deltaKeyPartSchema.optional(),
  parentRef: deltaKeyPartSchema.optional(),
});
export type DeltaItemKey = z.infer<typeof deltaItemKeySchema>;

const providerTurnIdSchema = deltaKeyPartSchema;

export const deltaFileChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(["add", "update", "delete"]),
  movePath: z.string().optional(),
  diff: z.string().optional(),
  oldText: z.string().optional(),
  newText: z.string().optional(),
});
export type DeltaFileChange = z.infer<typeof deltaFileChangeSchema>;

export const deltaBackgroundTaskShapeSchema = z.object({
  type: z.literal("backgroundTask"),
  familyId: z.string().min(1),
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
});
export type DeltaBackgroundTaskShape = z.infer<
  typeof deltaBackgroundTaskShapeSchema
>;

export const deltaFileReadShapeSchema = z.object({
  type: z.literal("fileRead"),
  path: z.string(),
  cmd: z.string().optional(),
});
export type DeltaFileReadShape = z.infer<typeof deltaFileReadShapeSchema>;

export const deltaSearchShapeSchema = z.object({
  type: z.literal("search"),
  mode: threadEventSearchModeSchema,
  query: z.string(),
  path: z.string().optional(),
  cmd: z.string().optional(),
});
export type DeltaSearchShape = z.infer<typeof deltaSearchShapeSchema>;

export const deltaDelegationShapeSchema = z.object({
  type: z.literal("delegation"),
  childRef: deltaKeyPartSchema,
  label: z.string(),
  background: z.boolean(),
  summary: z.string().optional(),
});
export type DeltaDelegationShape = z.infer<typeof deltaDelegationShapeSchema>;

export const deltaPlanStepsShapeSchema = z.object({
  type: z.literal("planSteps"),
  steps: z.array(threadEventPlanStepSchema),
  explanation: z.string().optional(),
});
export type DeltaPlanStepsShape = z.infer<typeof deltaPlanStepsShapeSchema>;

export const deltaExtensionShapeSchema = z.object({
  type: z.literal("extension"),
  kind: extensionKindSchema,
  payload: jsonValueSchema,
});
export type DeltaExtensionShape = z.infer<typeof deltaExtensionShapeSchema>;

export const deltaItemShapeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("command"),
    command: z.string(),
    cwd: z.string(),
    aggregatedOutput: z.string().optional(),
    exitCode: z.number().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({
    type: z.literal("fileChange"),
    changes: z.array(deltaFileChangeSchema),
  }),
  z.object({
    type: z.literal("tool"),
    tool: z.string(),
    server: z.string().optional(),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.string().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({ type: z.literal("compaction") }),
  z.object({ type: z.literal("agentMessage"), text: z.string() }),
  z.object({
    type: z.literal("reasoning"),
    summary: z.array(z.string()),
    content: z.array(z.string()),
  }),
  z.object({ type: z.literal("plan"), text: z.string() }),
  z.object({
    type: z.literal("webSearch"),
    queries: z.array(z.string()).min(1),
  }),
  z.object({
    type: z.literal("webFetch"),
    url: z.string(),
    prompt: z.string().nullable().optional(),
    pattern: z.string().nullable(),
  }),
  z.object({ type: z.literal("imageView"), path: z.string() }),
  deltaBackgroundTaskShapeSchema,
  deltaFileReadShapeSchema,
  deltaSearchShapeSchema,
  deltaDelegationShapeSchema,
  deltaPlanStepsShapeSchema,
  deltaExtensionShapeSchema,
]);
export type DeltaItemShape = z.infer<typeof deltaItemShapeSchema>;
export type DeltaItemShapeType = DeltaItemShape["type"];

export const deltaProgressSnapshotSchema = z.discriminatedUnion("type", [
  deltaBackgroundTaskShapeSchema,
  deltaDelegationShapeSchema,
]);
export type DeltaProgressSnapshot = z.infer<typeof deltaProgressSnapshotSchema>;

export const deltaTextChannelSchema = z.enum([
  "agentMessage",
  "reasoningSummary",
  "reasoningText",
  "plan",
]);
export type DeltaTextChannel = z.infer<typeof deltaTextChannelSchema>;

export const deltaOutputChannelSchema = z.enum(["command", "fileChange"]);
export type DeltaOutputChannel = z.infer<typeof deltaOutputChannelSchema>;

const deltaErrorSchema = z.object({ message: z.string() });

const deltaAttachSchema = z.enum(["open", "currentOrLast"]);

export const deltaNoTurnFallbackSchema = z.object({
  raw: providerRawEventSchema,
  rawType: z.string(),
});
export type DeltaNoTurnFallback = z.infer<typeof deltaNoTurnFallbackSchema>;

function requireExtensionPresentation(
  delta: { item: DeltaItemShape; presentation?: DeltaPresentation },
  ctx: z.RefinementCtx,
): void {
  if (delta.item.type === "extension" && delta.presentation === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "extension items require a presentation on item.open/item.close",
      path: ["presentation"],
    });
  }
}

export const threadDeltaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("input.accepted"),
    clientRequestId: clientTurnRequestIdSchema,
    providerTurnId: providerTurnIdSchema.optional(),
  }),

  z.object({
    kind: z.literal("input.provider"),
    text: z.string().min(1),
    parentRef: deltaKeyPartSchema.optional(),
  }),

  z.object({
    kind: z.literal("turn.open"),
    providerTurnId: providerTurnIdSchema.optional(),
    parentRef: deltaKeyPartSchema.optional(),
  }),

  z.object({
    kind: z.literal("turn.boundary"),
    status: threadEventTurnStatusSchema,
    error: deltaErrorSchema.optional(),
    providerCheckpointId: z.string().min(1).optional(),
    claimIfIdle: z.boolean().optional(),
    providerTurnId: providerTurnIdSchema.optional(),
  }),

  z
    .object({
      kind: z.literal("item.open"),
      key: deltaItemKeySchema,
      item: deltaItemShapeSchema,
      presentation: deltaPresentationSchema.optional(),
      attach: deltaAttachSchema.optional(),
      providerTurnId: providerTurnIdSchema.optional(),
      noTurnFallback: deltaNoTurnFallbackSchema.optional(),
    })
    .superRefine(requireExtensionPresentation),

  z
    .object({
      kind: z.literal("item.close"),
      key: deltaItemKeySchema,
      status: threadEventItemStatusSchema,
      resultText: z.string().optional(),
      exitCode: z.number().optional(),
      aggregatedOutput: z.string().optional(),
      approvalStatus: z.literal("denied").optional(),
      item: deltaItemShapeSchema,
      presentation: deltaPresentationSchema.optional(),
      providerTurnId: providerTurnIdSchema.optional(),
      noTurnFallback: deltaNoTurnFallbackSchema.optional(),
    })
    .superRefine(requireExtensionPresentation),

  z.object({
    kind: z.literal("item.progress"),
    key: deltaItemKeySchema,
    message: z.string().optional(),
    snapshot: deltaProgressSnapshotSchema.optional(),
    flush: z.boolean().optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional(),
  }),

  z.object({
    kind: z.literal("item.textDelta"),
    key: deltaItemKeySchema,
    channel: deltaTextChannelSchema,
    text: z.string(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional(),
  }),

  z.object({
    kind: z.literal("item.textClose"),
    key: deltaItemKeySchema,
    channel: deltaTextChannelSchema,
    text: z.string().optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional(),
  }),

  z.object({
    kind: z.literal("item.outputDelta"),
    key: deltaItemKeySchema,
    channel: deltaOutputChannelSchema,
    text: z.string(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional(),
  }),

  z.object({
    kind: z.literal("command.outputSnapshot"),
    key: deltaItemKeySchema,
    text: z.string(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional(),
  }),

  z.object({
    kind: z.literal("usage"),
    total: threadEventTokenUsageBreakdownSchema,
    last: threadEventTokenUsageBreakdownSchema,
    modelContextWindow: z.number().nullable(),
    providerTurnId: providerTurnIdSchema.optional(),
  }),

  z.object({
    kind: z.literal("contextWindow"),
    used: z.number().nullable(),
    size: z.number().nullable().optional(),
    estimated: z.boolean(),
    attach: deltaAttachSchema,
    providerTurnId: providerTurnIdSchema.optional(),
  }),

  z.object({
    kind: z.literal("context.compacted"),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional(),
  }),
  z.object({ kind: z.literal("context.cleared") }),

  z.object({
    kind: z.literal("turn.diff"),
    diff: z.string(),
    providerTurnId: providerTurnIdSchema.optional(),
  }),

  z.object({ kind: z.literal("thread.started") }),
  z.object({
    kind: z.literal("thread.identity"),
    providerThreadId: z.string().min(1),
  }),
  z.object({ kind: z.literal("thread.name"), name: z.string().min(1) }),

  z.object({
    kind: z.literal("extension.state"),
    extensionKind: extensionKindSchema,
    payload: jsonValueSchema,
  }),

  z.object({
    kind: z.literal("provider.rateLimits"),
    rateLimits: providerRateLimitStateSchema,
  }),

  z.object({
    kind: z.literal("provider.error"),
    message: z.string(),
    detail: z.string().optional(),
    willRetry: z.boolean().optional(),
    category: providerErrorCategorySchema.optional(),
    errorInfo: providerErrorInfoSchema.optional(),
    settlesTurn: z.boolean().optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    threadScoped: z.boolean().optional(),
  }),

  z.object({
    kind: z.literal("provider.modelFallback"),
    originalModel: z.string().min(1),
    fallbackModel: z.string().min(1),
    reason: z.enum(["refusal", "provider"]),
    message: z.string(),
  }),

  z.object({
    kind: z.literal("provider.warning"),
    summary: z.string().optional(),
    details: z.string().optional(),
    category: threadEventWarningCategorySchema.optional(),
    vouchedTurn: z.boolean().optional(),
  }),

  z.object({
    kind: z.literal("unhandled"),
    raw: providerRawEventSchema,
    rawType: z.string(),
    vouchedTurn: z.boolean(),
    onlyIfNoTurn: z.boolean().optional(),
    parentRef: deltaKeyPartSchema.optional(),
    providerTurnId: providerTurnIdSchema.optional(),
  }),

  z.object({ kind: z.literal("session.ended") }),

  z.object({ kind: z.literal("session.reset") }),
]);
export type ThreadDelta = z.infer<typeof threadDeltaSchema>;
export type ThreadDeltaKind = ThreadDelta["kind"];

export const threadDeltaNotificationParamsSchema = z
  .object({
    threadId: z.string().min(1),
    deltas: z.array(threadDeltaSchema),
  })
  .passthrough();
export type ThreadDeltaNotificationParams = z.infer<
  typeof threadDeltaNotificationParamsSchema
>;
