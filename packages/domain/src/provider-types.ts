import { z } from "zod";
import {
  promptInputSchema,
  reasoningLevelSchema,
  sandboxModeSchema,
} from "./shared-types.js";
import { threadTypeSchema } from "./thread.js";

export const modelReasoningEffortSchema = z.object({
  reasoningEffort: reasoningLevelSchema,
  description: z.string(),
});
export type ModelReasoningEffort = z.infer<
  typeof modelReasoningEffortSchema
>;

export const availableModelSchema = z.object({
  id: z.string(),
  model: z.string(),
  displayName: z.string(),
  description: z.string(),
  supportedReasoningEfforts: z.array(modelReasoningEffortSchema),
  defaultReasoningEffort: reasoningLevelSchema,
  isDefault: z.boolean(),
});
export type AvailableModel = z.infer<typeof availableModelSchema>;

export const providerCapabilitiesSchema = z.object({
  supportsRename: z.boolean(),
  supportsServiceTier: z.boolean(),
});
export type ProviderCapabilities = z.infer<
  typeof providerCapabilitiesSchema
>;

export const providerInfoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  capabilities: providerCapabilitiesSchema,
  available: z.boolean(),
});
export type ProviderInfo = z.infer<typeof providerInfoSchema>;

export const toolCallOutputItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inputText"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("inputImage"),
    imageUrl: z.string(),
  }),
]);
export type ToolCallOutputItem = z.infer<typeof toolCallOutputItemSchema>;

export const toolCallRequestSchema = z.object({
  requestId: z.union([z.string(), z.number()]),
  threadId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  tool: z.string(),
  arguments: z.unknown().optional(),
});
export type ToolCallRequest = z.infer<typeof toolCallRequestSchema>;

export const toolCallResponseSchema = z.object({
  contentItems: z.array(toolCallOutputItemSchema),
  success: z.boolean(),
});
export type ToolCallResponse = z.infer<typeof toolCallResponseSchema>;

export const messageUserToolArgumentsSchema = z
  .object({
    text: z.string().trim().min(1).optional(),
    message: z.string().trim().min(1).optional(),
  })
  .refine(
    (value) => value.text !== undefined || value.message !== undefined,
    "message_user requires text",
  )
  .transform((value) => ({
    text: value.text ?? value.message ?? "",
  }));
export type MessageUserToolArguments = z.infer<
  typeof messageUserToolArgumentsSchema
>;

export const spawnThreadToolArgumentsSchema = z
  .object({
    prompt: z.string().trim().min(1).optional(),
    input: z.array(promptInputSchema).min(1).optional(),
    environmentId: z.string().min(1).optional(),
    hostId: z.string().min(1).optional(),
    providerId: z.string().min(1).optional(),
    type: threadTypeSchema.optional(),
    title: z.string().trim().min(1).optional(),
    model: z.string().min(1).optional(),
    reasoningLevel: reasoningLevelSchema.optional(),
    sandboxMode: sandboxModeSchema.optional(),
  })
  .transform((value) => ({
    ...value,
    input: value.prompt
      ? [{ type: "text" as const, text: value.prompt }]
      : value.input,
  }));
export type SpawnThreadToolArguments = z.infer<
  typeof spawnThreadToolArgumentsSchema
>;

export const dynamicToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.unknown(),
});
export type DynamicTool = z.infer<typeof dynamicToolSchema>;
