import { z } from "zod";

export const claudeFileEditArgsSchema = z.object({
  file_path: z.string().optional(),
  path: z.string().optional(),
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  content: z.string().optional(),
}).passthrough();
export type ClaudeFileEditArgs = z.infer<typeof claudeFileEditArgsSchema>;

export const claudeWebSearchArgsSchema = z.object({
  query: z.string().optional(),
  url: z.string().optional(),
}).passthrough();

export const messageIdSchema = z.object({
  id: z.string(),
});

export const toolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export const toolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  tool_name: z.string().optional(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
});

export const thinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
}).passthrough();

export const messageContentSchema = z.object({
  content: z.array(z.object({ type: z.string() }).passthrough()).optional(),
}).passthrough();
export type ClaudeMessageContentBlock = NonNullable<z.infer<
  typeof messageContentSchema
>["content"]>[number];

export const sdkUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
}).passthrough();
export type ClaudeSdkUsage = z.infer<typeof sdkUsageSchema>;

export const claudeModelUsageSchema = z.record(z.string(), z.object({
  contextWindow: z.number(),
}).passthrough());

const contentBlockDeltaSchema = z.object({
  type: z.literal("content_block_delta"),
  index: z.number(),
  delta: z.union([
    z.object({ type: z.literal("text_delta"), text: z.string() }).passthrough(),
    z.object({ type: z.literal("thinking_delta"), thinking: z.string() }).passthrough(),
  ]),
}).passthrough();

const contentBlockStartSchema = z.object({
  type: z.literal("content_block_start"),
  index: z.number(),
  content_block: z.union([
    z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
    z.object({ type: z.literal("thinking"), thinking: z.string() }).passthrough(),
  ]),
}).passthrough();

export const streamEventSchema = z.union([
  contentBlockDeltaSchema,
  contentBlockStartSchema,
]);

export const claudeSdkMessageTypeSchema = z.object({
  type: z.enum([
    "assistant",
    "rate_limit_event",
    "result",
    "stream_event",
    "system",
    "user",
  ]),
}).passthrough();

export const claudeSystemMessageSchema = z.object({
  type: z.literal("system"),
}).passthrough();

export const claudeStatusSystemMessageSchema = claudeSystemMessageSchema.extend({
  subtype: z.literal("status"),
  status: z.string().nullable().optional(),
}).passthrough();

export const claudeCompactBoundarySystemMessageSchema =
  claudeSystemMessageSchema.extend({
    subtype: z.literal("compact_boundary"),
  }).passthrough();

export const claudeAssistantMessageSchema = z.object({
  type: z.literal("assistant"),
  message: z.unknown(),
}).passthrough();
export type ClaudeAssistantMessage = z.infer<typeof claudeAssistantMessageSchema>;

export const claudeAssistantUsageMessageSchema = z.object({
  usage: sdkUsageSchema.optional(),
}).passthrough();

export const claudeStreamEventMessageSchema = z.object({
  type: z.literal("stream_event"),
  event: z.unknown(),
}).passthrough();
export type ClaudeStreamEventMessage = z.infer<
  typeof claudeStreamEventMessageSchema
>;

export const claudeUserMessageSchema = z.object({
  type: z.literal("user"),
  message: z.unknown(),
}).passthrough();
export type ClaudeUserMessage = z.infer<typeof claudeUserMessageSchema>;

export const claudeResultMessageSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.unknown().optional(),
  usage: z.unknown().optional(),
  modelUsage: z.unknown().optional(),
}).passthrough();
export type ClaudeResultMessage = z.infer<typeof claudeResultMessageSchema>;
