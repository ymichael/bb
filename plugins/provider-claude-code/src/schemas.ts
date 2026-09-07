import { z } from "zod";

export const claudeFileEditArgsSchema = z
  .object({
    file_path: z.string().optional(),
    path: z.string().optional(),
    old_string: z.string().optional(),
    new_string: z.string().optional(),
    content: z.string().optional(),
  })
  .passthrough();
export type ClaudeFileEditArgs = z.infer<typeof claudeFileEditArgsSchema>;

export const claudeWebSearchArgsSchema = z
  .object({
    query: z.string().optional(),
  })
  .passthrough();
export type ClaudeWebSearchArgs = z.infer<typeof claudeWebSearchArgsSchema>;

export const claudeWebFetchArgsSchema = z
  .object({
    url: z.string().optional(),
    prompt: z.string().optional(),
  })
  .passthrough();
export type ClaudeWebFetchArgs = z.infer<typeof claudeWebFetchArgsSchema>;

export const toolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

const claudeToolUseProcessResultSchema = z
  .object({
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  })
  .passthrough();

const claudeToolUseResultSchema = z.union([
  claudeToolUseProcessResultSchema,
  z.string(),
]);
export type ClaudeToolUseResult = z.infer<typeof claudeToolUseResultSchema>;

export const toolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  tool_name: z.string().optional(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
  tool_use_result: claudeToolUseResultSchema.nullish(),
});

export const thinkingBlockSchema = z
  .object({
    type: z.literal("thinking"),
    thinking: z.string(),
  })
  .passthrough();

export const messageContentSchema = z
  .object({
    content: z.array(z.object({ type: z.string() }).passthrough()).optional(),
  })
  .passthrough();
export type ClaudeMessageContentBlock = NonNullable<
  z.infer<typeof messageContentSchema>["content"]
>[number];

export const sdkUsageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
  })
  .passthrough();
export type ClaudeSdkUsage = z.infer<typeof sdkUsageSchema>;

export const claudeModelUsageSchema = z.record(
  z.string(),
  z
    .object({
      contextWindow: z.number(),
    })
    .passthrough(),
);

const contentBlockDeltaSchema = z
  .object({
    type: z.literal("content_block_delta"),
    index: z.number(),
    delta: z.union([
      z
        .object({ type: z.literal("text_delta"), text: z.string() })
        .passthrough(),
      z
        .object({ type: z.literal("thinking_delta"), thinking: z.string() })
        .passthrough(),
    ]),
  })
  .passthrough();

const contentBlockStartSchema = z
  .object({
    type: z.literal("content_block_start"),
    index: z.number(),
    content_block: z.union([
      z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
      z
        .object({ type: z.literal("thinking"), thinking: z.string() })
        .passthrough(),
    ]),
  })
  .passthrough();

export const streamEventSchema = z.union([
  contentBlockDeltaSchema,
  contentBlockStartSchema,
]);

const claudeAssistantMessageErrorSchema = z.enum([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "rate_limit",
  "invalid_request",
  "model_not_found",
  "server_error",
  "unknown",
  "max_output_tokens",
]);
export type ClaudeAssistantMessageError = z.infer<
  typeof claudeAssistantMessageErrorSchema
>;

export const claudeSdkMessageTypeSchema = z
  .object({
    type: z.enum([
      "assistant",
      "conversation_reset",
      "rate_limit_event",
      "result",
      "stream_event",
      "system",
      "user",
    ]),
  })
  .passthrough();

export const claudeConversationResetMessageSchema = z
  .object({
    type: z.literal("conversation_reset"),
  })
  .passthrough();

export const claudeSystemMessageSchema = z
  .object({
    type: z.literal("system"),
  })
  .passthrough();

export const claudeApiRetryMessageSchema = claudeSystemMessageSchema
  .extend({
    subtype: z.literal("api_retry"),
    attempt: z.number(),
    max_retries: z.number(),
    retry_delay_ms: z.number(),
    error_status: z.number().nullable(),
    error: claudeAssistantMessageErrorSchema,
  })
  .passthrough();
export type ClaudeApiRetryMessage = z.infer<typeof claudeApiRetryMessageSchema>;

export const claudeStatusSystemMessageSchema = claudeSystemMessageSchema
  .extend({
    subtype: z.literal("status"),
    status: z.string().nullable().optional(),
  })
  .passthrough();

export const claudePermissionDeniedSystemMessageSchema =
  claudeSystemMessageSchema
    .extend({
      subtype: z.literal("permission_denied"),
      tool_name: z.string(),
      tool_use_id: z.string(),
      decision_reason_type: z.string().optional(),
      decision_reason: z.string().optional(),
      message: z.string(),
    })
    .passthrough();

export const claudeCompactBoundarySystemMessageSchema =
  claudeSystemMessageSchema
    .extend({
      subtype: z.literal("compact_boundary"),
    })
    .passthrough();

export const claudeModelFallbackSystemMessageSchema = claudeSystemMessageSchema
  .extend({
    subtype: z.enum(["model_fallback", "model_refusal_fallback"]),
    original_model: z.string().min(1),
    fallback_model: z.string().min(1),
    content: z.string().optional(),
  })
  .passthrough();

export const claudeModelRefusalNoFallbackSystemMessageSchema =
  claudeSystemMessageSchema
    .extend({
      subtype: z.literal("model_refusal_no_fallback"),
      content: z.string().optional(),
    })
    .passthrough();

const claudeTaskUsageSchema = z
  .object({
    total_tokens: z.number(),
    tool_uses: z.number(),
    duration_ms: z.number(),
  })
  .passthrough();
export type ClaudeTaskUsage = z.infer<typeof claudeTaskUsageSchema>;

export const claudeTaskStartedMessageSchema = claudeSystemMessageSchema
  .extend({
    subtype: z.literal("task_started"),
    task_id: z.string(),
    tool_use_id: z.string().optional(),
    description: z.string(),
    subagent_type: z.string().optional(),
    task_type: z.string().optional(),
    workflow_name: z.string().optional(),
    prompt: z.string().optional(),
    skip_transcript: z.boolean().optional(),
  })
  .passthrough();

export const claudeTaskUpdatedMessageSchema = claudeSystemMessageSchema
  .extend({
    subtype: z.literal("task_updated"),
    task_id: z.string(),
    patch: z
      .object({
        status: z
          .enum([
            "pending",
            "running",
            "completed",
            "failed",
            "killed",
            "paused",
          ])
          .optional(),
        description: z.string().optional(),
        end_time: z.number().optional(),
        total_paused_ms: z.number().optional(),
        error: z.string().optional(),
        is_backgrounded: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const claudeTaskProgressMessageSchema = claudeSystemMessageSchema
  .extend({
    subtype: z.literal("task_progress"),
    task_id: z.string(),
    tool_use_id: z.string().optional(),
    description: z.string(),
    subagent_type: z.string().optional(),
    usage: claudeTaskUsageSchema,
    last_tool_name: z.string().optional(),
    summary: z.string().optional(),
    workflow_progress: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const claudeTaskNotificationMessageSchema = claudeSystemMessageSchema
  .extend({
    subtype: z.literal("task_notification"),
    task_id: z.string(),
    tool_use_id: z.string().optional(),
    status: z.enum(["completed", "failed", "stopped"]),
    output_file: z.string(),
    summary: z.string(),
    usage: claudeTaskUsageSchema.optional(),
    skip_transcript: z.boolean().optional(),
  })
  .passthrough();

export const claudeBackgroundTasksChangedMessageSchema =
  claudeSystemMessageSchema
    .extend({
      subtype: z.literal("background_tasks_changed"),
      tasks: z.array(z.object({ task_id: z.string() }).passthrough()),
    })
    .passthrough();

export const claudeWorkflowAgentRecordSchema = z
  .object({
    type: z.literal("workflow_agent"),
    index: z.number(),
    label: z.string(),
    state: z.string(),
    model: z.string().optional(),
    phaseIndex: z.number().optional(),
    phaseTitle: z.string().optional(),
    agentId: z.string().optional(),
    agentType: z.string().optional(),
    isolation: z.string().optional(),
    queuedAt: z.number().optional(),
    startedAt: z.number().optional(),
    lastProgressAt: z.number().optional(),
    attempt: z.number().optional(),
    lastAttemptReason: z.string().optional(),
    lastToolName: z.string().optional(),
    lastToolSummary: z.string().optional(),
    promptPreview: z.string().optional(),
    resultPreview: z.string().optional(),
    error: z.string().optional(),
    skipped: z.boolean().optional(),
    cached: z.boolean().optional(),
    tokens: z.number().optional(),
    toolCalls: z.number().optional(),
    durationMs: z.number().optional(),
  })
  .passthrough();
export type ClaudeWorkflowAgentRecord = z.infer<
  typeof claudeWorkflowAgentRecordSchema
>;

export const claudeWorkflowPhaseRecordSchema = z
  .object({
    type: z.literal("workflow_phase"),
    index: z.number(),
    title: z.string(),
    kind: z.string().optional(),
  })
  .passthrough();

export const claudeAssistantMessageSchema = z
  .object({
    type: z.literal("assistant"),
    message: z.unknown(),
    uuid: z.string().min(1).optional(),
  })
  .passthrough();
export type ClaudeAssistantMessage = z.infer<
  typeof claudeAssistantMessageSchema
>;

export const claudeAssistantUsageMessageSchema = z
  .object({
    usage: sdkUsageSchema.optional(),
  })
  .passthrough();

export const claudeStreamEventMessageSchema = z
  .object({
    type: z.literal("stream_event"),
    event: z.unknown(),
  })
  .passthrough();
export type ClaudeStreamEventMessage = z.infer<
  typeof claudeStreamEventMessageSchema
>;

export const claudeUserMessageSchema = z
  .object({
    type: z.literal("user"),
    message: z.unknown(),
  })
  .passthrough();
export type ClaudeUserMessage = z.infer<typeof claudeUserMessageSchema>;

const claudeResultSubtypeSchema = z.enum([
  "success",
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
]);
export type ClaudeResultSubtype = z.infer<typeof claudeResultSubtypeSchema>;

const claudeMessageOriginSchema = z
  .object({
    kind: z.string().min(1),
  })
  .passthrough();

export const claudeResultMessageSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.string(),
    is_error: z.boolean().optional(),
    api_error_status: z.number().nullable().optional(),
    errors: z.array(z.string()).optional(),
    result: z.unknown().optional(),
    usage: z.unknown().optional(),
    modelUsage: z.unknown().optional(),
    origin: claudeMessageOriginSchema.optional(),
  })
  .passthrough();
export type ClaudeResultMessage = z.infer<typeof claudeResultMessageSchema>;

const claudeRateLimitInfoSchema = z
  .object({
    status: z.string().min(1),
    resetsAt: z.number().optional(),
    rateLimitType: z.string().min(1).optional(),
    overageStatus: z.string().min(1).optional(),
    overageDisabledReason: z.string().min(1).optional(),
  })
  .passthrough();

export const claudeRateLimitEventSchema = z
  .object({
    type: z.literal("rate_limit_event"),
    rate_limit_info: claudeRateLimitInfoSchema,
  })
  .passthrough();
export type ClaudeRateLimitEvent = z.infer<typeof claudeRateLimitEventSchema>;
