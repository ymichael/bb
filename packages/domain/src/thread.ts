import { z } from "zod";
import {
  promptInputSchema,
  reasoningLevelSchema,
  sandboxModeSchema,
  serviceTierSchema,
  threadExecutionOptionsSchema,
} from "./shared-types.js";
import { environmentSchema } from "./environment.js";
import {
  workspaceFileChangeSchema,
  workspaceStateSchema,
  workspaceStatusSchema,
  workspaceStateValues,
  type WorkspaceFileChange,
  type WorkspaceState,
  type WorkspaceStatus,
} from "./workspace.js";

export const threadStatusValues = [
  "created",
  "provisioning",
  "provisioned",
  "provisioning_failed",
  "error",
  "idle",
  "active",
] as const;
export const threadStatusSchema = z.enum(threadStatusValues);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;

export const threadTypeValues = ["standard", "manager"] as const;
export const threadTypeSchema = z.enum(threadTypeValues);
export type ThreadType = z.infer<typeof threadTypeSchema>;

export const threadBuiltInActionIdValues = [
  "commit",
  "squash_merge",
  "promote",
  "demote",
] as const;
export const threadBuiltInActionIdSchema = z.enum(
  threadBuiltInActionIdValues,
);
export type ThreadBuiltInActionId = z.infer<
  typeof threadBuiltInActionIdSchema
>;

export const threadWorkStateValues = workspaceStateValues;
export const threadWorkStateSchema = workspaceStateSchema;
export type ThreadWorkState = WorkspaceState;

export const threadProvisioningReadinessValues = [
  "ready",
  "degraded",
  "failed",
] as const;
export const threadProvisioningReadinessSchema = z.enum(
  threadProvisioningReadinessValues,
);
export type ThreadProvisioningReadiness = z.infer<
  typeof threadProvisioningReadinessSchema
>;

export const threadBuiltInActionSchema = z.object({
  id: threadBuiltInActionIdSchema,
  label: z.string(),
  available: z.boolean(),
  disabledReason: z.string().optional(),
  queuesWhenActive: z.boolean(),
  requiresDemoteFirst: z.boolean(),
});
export type ThreadBuiltInAction = z.infer<typeof threadBuiltInActionSchema>;

export const threadQueuedMessageSchema = z.object({
  id: z.string(),
  input: z.array(promptInputSchema),
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema,
  sandboxMode: sandboxModeSchema,
  createdAt: z.number(),
});
export type ThreadQueuedMessage = z.infer<typeof threadQueuedMessageSchema>;

export const threadWorkFileChangeSchema = workspaceFileChangeSchema;
export type ThreadWorkFileChange = WorkspaceFileChange;

export const threadWorkStatusSchema = workspaceStatusSchema;
export type ThreadWorkStatus = WorkspaceStatus;

export const threadPrimaryCheckoutStateSchema = z.object({
  isActive: z.boolean(),
  promotedAt: z.number().optional(),
});
export type ThreadPrimaryCheckoutState = z.infer<
  typeof threadPrimaryCheckoutStateSchema
>;

export const threadProvisioningStateSchema = z.object({
  readiness: threadProvisioningReadinessSchema,
  message: z.string().optional(),
  fallbackReason: z.string().optional(),
});
export type ThreadProvisioningState = z.infer<
  typeof threadProvisioningStateSchema
>;

export const threadContextWindowUsageSchema = z.object({
  totalTokens: z.number(),
  modelContextWindow: z.number(),
});
export type ThreadContextWindowUsage = z.infer<
  typeof threadContextWindowUsageSchema
>;

export const threadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  providerId: z.string(),
  type: threadTypeSchema,
  title: z.string().optional(),
  mergeBaseBranch: z.string().optional(),
  titleFallback: z.string().optional(),
  status: threadStatusSchema,
  workStatus: workspaceStatusSchema.optional(),
  primaryCheckout: threadPrimaryCheckoutStateSchema.optional(),
  provisioningState: threadProvisioningStateSchema.optional(),
  queuedMessages: z.array(threadQueuedMessageSchema).optional(),
  environmentId: z.string().optional(),
  attachedEnvironment: environmentSchema.optional(),
  builtInActions: z.array(threadBuiltInActionSchema).optional(),
  defaultExecutionOptions: threadExecutionOptionsSchema.optional(),
  parentThreadId: z.string().optional(),
  archivedAt: z.number().optional(),
  lastReadAt: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Thread = z.infer<typeof threadSchema>;
