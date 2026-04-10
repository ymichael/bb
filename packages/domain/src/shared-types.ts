import { z } from "zod";

export const reasoningLevelSchema = z.enum(["low", "medium", "high", "xhigh"]);
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;

export const serviceTierSchema = z.enum(["fast", "default"]);
export type ServiceTier = z.infer<typeof serviceTierSchema>;

/**
 * Controls how a provider should incorporate server-owned instructions into its
 * system prompt.
 *
 * - `append`: keep the provider's preset system prompt and append instructions.
 * - `replace`: use the provided instructions as the full system prompt.
 */
export const instructionModeValues = ["append", "replace"] as const;
export const instructionModeSchema = z.enum(instructionModeValues);
export type InstructionMode = z.infer<typeof instructionModeSchema>;

export const sandboxModeSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type SandboxMode = z.infer<typeof sandboxModeSchema>;

export const promptInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal("localImage"),
    path: z.string(),
  }),
  z.object({
    type: z.literal("localFile"),
    path: z.string(),
    name: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    mimeType: z.string().optional(),
  }),
]);
export type PromptInput = z.infer<typeof promptInputSchema>;

export const threadExecutionSourceSchema = z.enum([
  "client/thread/start",
  "client/turn/requested",
  "client/turn/start",
]);
export type ThreadExecutionSource = z.infer<typeof threadExecutionSourceSchema>;

export const threadExecutionOptionsSchema = z.object({
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
  approvalPolicy: z.string().optional(),
  source: threadExecutionSourceSchema.optional(),
  seq: z.number().int().optional(),
});
export type ThreadExecutionOptions = z.infer<
  typeof threadExecutionOptionsSchema
>;

export const resolvedThreadExecutionOptionsSchema =
  threadExecutionOptionsSchema.extend({
    model: z.string().min(1),
    serviceTier: serviceTierSchema,
    reasoningLevel: reasoningLevelSchema,
    sandboxMode: sandboxModeSchema,
    source: threadExecutionSourceSchema,
  });
export type ResolvedThreadExecutionOptions = z.infer<
  typeof resolvedThreadExecutionOptionsSchema
>;

export const projectExecutionDefaultsSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  sandboxMode: sandboxModeSchema,
});
export type ProjectExecutionDefaults = z.infer<
  typeof projectExecutionDefaultsSchema
>;
