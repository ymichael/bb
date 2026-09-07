import { z } from "zod";
import {
  permissionModeSchema,
  promptMentionCommandTriggerSchema,
  reasoningLevelSchema,
} from "./shared-types.js";
import { extensionKindSchema } from "./provider-extension-kind.js";
import { threadEventItemPresentationSchema } from "./item-presentation.js";

export const modelReasoningEffortSchema = z.object({
  reasoningEffort: reasoningLevelSchema,
  description: z.string(),
});
export type ModelReasoningEffort = z.infer<typeof modelReasoningEffortSchema>;

export const availableModelSchema = z.object({
  id: z.string(),
  model: z.string(),
  displayName: z.string(),
  routeProviderId: z.string().min(1).optional(),
  description: z.string(),
  supportedReasoningEfforts: z.array(modelReasoningEffortSchema),
  defaultReasoningEffort: reasoningLevelSchema,
  isDefault: z.boolean(),
});
export type AvailableModel = z.infer<typeof availableModelSchema>;

export const providerModelCatalogScopeSchema = z.enum(["host", "workspace"]);
export type ProviderModelCatalogScope = z.infer<
  typeof providerModelCatalogScopeSchema
>;

const providerCapabilitiesSchema = z.object({
  supportsThreadArchive: z.boolean(),
  supportsThreadRename: z.boolean(),
  supportsServiceTier: z.boolean(),
  supportsNativeUserQuestion: z.boolean(),
  supportsFork: z.boolean(),
  supportsSessionRewind: z.boolean(),
  permissionModes: z.array(permissionModeSchema).min(1),
  modelCatalogScope: providerModelCatalogScopeSchema,
});
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

const providerComposerCommandSchema = z.object({
  trigger: promptMentionCommandTriggerSchema,
  name: z
    .string()
    .min(1)
    .regex(/^[^\s/$]+$/u),
  trailingText: z.string().regex(/^\s*$/u),
});
export type ProviderComposerCommand = z.infer<
  typeof providerComposerCommandSchema
>;

const providerComposerActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("skills"),
    trigger: promptMentionCommandTriggerSchema,
  }),
  z.object({
    kind: z.literal("plan"),
    command: providerComposerCommandSchema,
  }),
  z.object({
    kind: z.literal("goal"),
    command: providerComposerCommandSchema,
  }),
]);
export type ProviderComposerAction = z.infer<
  typeof providerComposerActionSchema
>;

export const providerStringsSchema = z.object({
  signInHint: z.string().min(1),
  expiredHint: z.string().min(1),
  installUrl: z.string().min(1),
  brandPrefix: z.string().min(1).optional(),
  planModeCopy: z.string().min(1).optional(),
  iconTint: z
    .object({ light: z.string().min(1), dark: z.string().min(1) })
    .optional(),
});
export type ProviderStrings = z.infer<typeof providerStringsSchema>;

export const providerOptionDescriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
});
export type ProviderOptionDescriptor = z.infer<
  typeof providerOptionDescriptorSchema
>;

export const providerExtensionKindInfoSchema = z.object({
  item: z.boolean(),
  state: z.boolean(),
});

export const providerExtensionKindsSchema = z.record(
  extensionKindSchema,
  providerExtensionKindInfoSchema,
);
export type ProviderExtensionKinds = z.infer<
  typeof providerExtensionKindsSchema
>;

export const providerInfoSchema = z.object({
  id: z.string(),
  pluginId: z.string().min(1),
  displayName: z.string(),
  family: z.string().min(1).optional(),
  icon: z.object({ glyph: z.string().min(1) }).optional(),
  logoUrl: z.string().min(1).nullable(),
  maintenance: z.object({
    health: z.boolean(),
    usage: z.boolean(),
    installation: z.boolean(),
  }),
  capabilities: providerCapabilitiesSchema,
  composerActions: z.array(providerComposerActionSchema),
  available: z.boolean(),
  strings: providerStringsSchema.optional(),
  serviceTiers: z.array(providerOptionDescriptorSchema).optional(),
  reasoningLevels: z.array(providerOptionDescriptorSchema).optional(),
  extensionKinds: providerExtensionKindsSchema.optional(),
});
export type ProviderInfo = z.infer<typeof providerInfoSchema>;

export const providerRecoveryKindValues = [
  "sessionArchived",
  "authRequired",
  "restartRecommended",
  "staleTurn",
  "rateLimited",
] as const;
export const providerRecoveryKindSchema = z.enum(providerRecoveryKindValues);
export type ProviderRecoveryKind = z.infer<typeof providerRecoveryKindSchema>;

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

export const toolCallRequestSchema = z.object({
  requestId: z.union([z.string().min(1), z.number()]),
  threadId: z.string().min(1),
  providerThreadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.unknown().optional(),
});
export type ToolCallRequest = z.infer<typeof toolCallRequestSchema>;

export const toolCallResponseSchema = z.object({
  contentItems: z.array(toolCallOutputItemSchema),
  success: z.boolean(),
});
export type ToolCallResponse = z.infer<typeof toolCallResponseSchema>;

export const dynamicToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.unknown(),
  presentation: threadEventItemPresentationSchema.optional(),
});
export type DynamicTool = z.infer<typeof dynamicToolSchema>;
