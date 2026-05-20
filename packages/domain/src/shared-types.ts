import { z } from "zod";

export const reasoningLevelValues = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const reasoningLevelSchema = z.enum(reasoningLevelValues);
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

export const permissionModeValues = [
  "full",
  "workspace-write",
  "readonly",
] as const;
export const permissionModeSchema = z.enum(permissionModeValues);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const permissionEscalationValues = ["ask", "deny"] as const;
export const permissionEscalationSchema = z.enum(permissionEscalationValues);
export type PermissionEscalation = z.infer<typeof permissionEscalationSchema>;

export const promptInputVisibilityValues = ["agent-only"] as const;
export const promptInputVisibilitySchema = z.enum(promptInputVisibilityValues);
export type PromptInputVisibility = z.infer<
  typeof promptInputVisibilitySchema
>;

const promptInputVisibilityFields = {
  visibility: promptInputVisibilitySchema.optional(),
};

export const promptInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    ...promptInputVisibilityFields,
  }),
  z.object({
    type: z.literal("image"),
    url: z.string().url(),
    ...promptInputVisibilityFields,
  }),
  z.object({
    type: z.literal("localImage"),
    path: z.string(),
    ...promptInputVisibilityFields,
  }),
  z.object({
    type: z.literal("localFile"),
    path: z.string(),
    name: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    mimeType: z.string().optional(),
    ...promptInputVisibilityFields,
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
  permissionMode: permissionModeSchema.optional(),
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
    permissionMode: permissionModeSchema,
    source: threadExecutionSourceSchema,
  });
export type ResolvedThreadExecutionOptions = z.infer<
  typeof resolvedThreadExecutionOptionsSchema
>;

export const runtimePermissionPolicySchema = z.discriminatedUnion(
  "permissionMode",
  [
    z.object({
      permissionMode: z.literal("full"),
      permissionEscalation: z.null(),
    }),
    z.object({
      permissionMode: z.literal("workspace-write"),
      permissionEscalation: permissionEscalationSchema,
    }),
    z.object({
      permissionMode: z.literal("readonly"),
      permissionEscalation: permissionEscalationSchema,
    }),
  ],
);
export type RuntimePermissionPolicy = z.infer<
  typeof runtimePermissionPolicySchema
>;

const runtimeThreadExecutionBaseOptionsSchema = z.object({
  model: z.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
});

export const runtimeThreadExecutionOptionsSchema =
  runtimeThreadExecutionBaseOptionsSchema.and(runtimePermissionPolicySchema);
export type RuntimeThreadExecutionOptions = z.infer<
  typeof runtimeThreadExecutionOptionsSchema
>;

export const projectExecutionDefaultsSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  permissionMode: permissionModeSchema,
});
export type ProjectExecutionDefaults = z.infer<
  typeof projectExecutionDefaultsSchema
>;
