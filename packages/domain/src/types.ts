import { z } from "zod";
import {
  promptInputSchema,
  reasoningLevelSchema,
  sandboxModeSchema,
  serviceTierSchema,
  threadExecutionOptionsSchema,
  type PromptInput,
  type ReasoningLevel,
  type SandboxMode,
  type ServiceTier,
} from "./shared-types.js";

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

export const environmentLocationValues = [
  "localhost",
  "docker",
  "remote",
] as const;
export const environmentLocationSchema = z.enum(environmentLocationValues);
export type EnvironmentLocation = z.infer<typeof environmentLocationSchema>;

export const environmentWorkspaceKindValues = [
  "primary_checkout",
  "worktree",
  "arbitrary_path",
] as const;
export const environmentWorkspaceKindSchema = z.enum(
  environmentWorkspaceKindValues,
);
export type EnvironmentWorkspaceKind = z.infer<
  typeof environmentWorkspaceKindSchema
>;

export const environmentCapabilityValues = [
  "host_filesystem",
  "isolated_workspace",
  "promote_primary_checkout",
  "demote_primary_checkout",
  "squash_merge",
] as const;
export const environmentCapabilitySchema = z.enum(
  environmentCapabilityValues,
);
export type EnvironmentCapability = z.infer<
  typeof environmentCapabilitySchema
>;

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

export const threadWorkStateValues = [
  "clean",
  "untracked",
  "deleted",
  "dirty_uncommitted",
  "committed_unmerged",
  "dirty_and_committed_unmerged",
] as const;
export const threadWorkStateSchema = z.enum(threadWorkStateValues);
export type ThreadWorkState = z.infer<typeof threadWorkStateSchema>;

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

export const appThreadEventTypeValues = [
  "client/thread/start",
  "client/turn/requested",
  "client/turn/start",
  "system/error",
  "system/manager/user_message",
  "system/thread/interrupted",
  "system/thread-title/updated",
  "system/operation",
  "system/worktree/commit",
  "system/worktree/squash_merge",
  "system/provisioning/started",
  "system/provisioning/progress",
  "system/provisioning/env_setup",
  "system/provisioning/fallback",
  "system/provisioning/completed",
  "system/provisioning/cleanup_failed",
] as const;
export const appThreadEventTypeSchema = z.enum(appThreadEventTypeValues);
export type AppThreadEventType = z.infer<typeof appThreadEventTypeSchema>;

export const threadTurnInitiatorValues = ["user", "agent", "system"] as const;
export const threadTurnInitiatorSchema = z.enum(threadTurnInitiatorValues);
export type ThreadTurnInitiator = z.infer<typeof threadTurnInitiatorSchema>;

export const threadProvisioningReasonValues = [
  "thread-created",
  "boot-created-thread",
  "tell-after-provisioning-failure",
  "tell-after-missing-environment-attachment",
  "resume-missing-provider-thread",
] as const;
export const threadProvisioningReasonSchema = z.enum(
  threadProvisioningReasonValues,
);
export type ThreadProvisioningReason = z.infer<
  typeof threadProvisioningReasonSchema
>;

export const threadEnvironmentStartReasonValues = [
  ...threadProvisioningReasonValues,
  "boot-active-resume",
  "resume-existing-provider-session",
] as const;
export const threadEnvironmentStartReasonSchema = z.enum(
  threadEnvironmentStartReasonValues,
);
export type ThreadEnvironmentStartReason = z.infer<
  typeof threadEnvironmentStartReasonSchema
>;

export const threadProvisioningProgressPhaseValues = [
  "prepare_environment",
  "start_provider_session",
] as const;
export const threadProvisioningProgressPhaseSchema = z.enum(
  threadProvisioningProgressPhaseValues,
);
export type ThreadProvisioningProgressPhase = z.infer<
  typeof threadProvisioningProgressPhaseSchema
>;

export const threadProvisioningProgressStatusValues = [
  "started",
  "completed",
  "failed",
] as const;
export const threadProvisioningProgressStatusSchema = z.enum(
  threadProvisioningProgressStatusValues,
);
export type ThreadProvisioningProgressStatus = z.infer<
  typeof threadProvisioningProgressStatusSchema
>;

export const environmentDescriptorSchema = z.object({
  type: z.literal("path"),
  path: z.string(),
});
export type EnvironmentDescriptor = z.infer<
  typeof environmentDescriptorSchema
>;

export const environmentPropertiesSchema = z.object({
  provisioningSystemKind: z.string(),
  location: environmentLocationSchema,
  workspaceKind: environmentWorkspaceKindSchema,
});
export type EnvironmentProperties = z.infer<
  typeof environmentPropertiesSchema
>;

export const persistedEnvironmentRecordSchema = z.object({
  kind: z.string(),
  state: z.unknown(),
});
export type PersistedEnvironmentRecord = z.infer<
  typeof persistedEnvironmentRecordSchema
>;

export const environmentRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  descriptor: environmentDescriptorSchema.optional(),
  managed: z.boolean(),
  properties: environmentPropertiesSchema.optional(),
  runtimeState: persistedEnvironmentRecordSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type EnvironmentRecord = z.infer<typeof environmentRecordSchema>;

export const environmentCapabilitiesSchema = z.object({
  host_filesystem: z.boolean(),
  isolated_workspace: z.boolean(),
  promote_primary_checkout: z.boolean(),
  demote_primary_checkout: z.boolean(),
  squash_merge: z.boolean(),
});
export type EnvironmentCapabilities = z.infer<
  typeof environmentCapabilitiesSchema
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

export const threadWorkFileChangeSchema = z.object({
  path: z.string(),
  status: z.string(),
});
export type ThreadWorkFileChange = z.infer<
  typeof threadWorkFileChangeSchema
>;

export const threadWorkStatusSchema = z.object({
  state: threadWorkStateSchema,
  changedFiles: z.number(),
  insertions: z.number(),
  deletions: z.number(),
  workspaceChangedFiles: z.number(),
  workspaceInsertions: z.number(),
  workspaceDeletions: z.number(),
  hasUncommittedChanges: z.boolean(),
  hasCommittedUnmergedChanges: z.boolean(),
  aheadCount: z.number(),
  behindCount: z.number(),
  currentBranch: z.string().optional(),
  defaultBranch: z.string().optional(),
  mergeBaseBranch: z.string().optional(),
  mergeBaseBranches: z.array(z.string()).optional(),
  baseRef: z.string().optional(),
  files: z.array(threadWorkFileChangeSchema).optional(),
});
export type ThreadWorkStatus = z.infer<typeof threadWorkStatusSchema>;

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

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  projectInstructions: z.string().optional(),
  defaultProviderId: z.string().optional(),
  primaryCheckoutThreadId: z.string().optional(),
  rootPathExists: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Project = z.infer<typeof projectSchema>;

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
  workStatus: threadWorkStatusSchema.optional(),
  primaryCheckout: threadPrimaryCheckoutStateSchema.optional(),
  provisioningState: threadProvisioningStateSchema.optional(),
  queuedMessages: z.array(threadQueuedMessageSchema).optional(),
  environmentId: z.string().optional(),
  attachedEnvironment: environmentRecordSchema.optional(),
  builtInActions: z.array(threadBuiltInActionSchema).optional(),
  defaultExecutionOptions: threadExecutionOptionsSchema.optional(),
  parentThreadId: z.string().optional(),
  archivedAt: z.number().optional(),
  lastReadAt: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Thread = z.infer<typeof threadSchema>;

export interface ClientExecutionOptionsSnapshot {
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel?: ReasoningLevel;
  sandboxMode?: SandboxMode;
  approvalPolicy?: string;
}

export interface ClientOutboundStartEventData {
  direction: "outbound";
  source: "spawn" | "tell";
  initiator?: ThreadTurnInitiator;
  input?: PromptInput[];
  request: {
    method: "thread/start" | "turn/start";
    params: Record<string, unknown>;
  };
  execution: ClientExecutionOptionsSnapshot;
}

export interface SystemErrorEventData {
  code?: string;
  message: string;
  detail?: string;
}

export interface SystemThreadTitleUpdatedEventData {
  title: string;
  previousTitle?: string;
  source: "provider";
  providerMethod?: string;
}

export interface SystemOperationEventData {
  operation: string;
  status: string;
  message: string;
  operationId?: string;
  metadata?: Record<string, unknown>;
}

export interface SystemThreadInterruptedEventData {
  reason: "user";
  message?: string;
}

export interface ProvisioningTranscriptEntry {
  key: string;
  text: string;
  metadata?: Record<string, unknown>;
  startedAt?: number;
}

export interface SystemProvisioningStartedEventData {
  attachedEnvironmentId?: string;
  reason?: ThreadProvisioningReason;
  transcript: ProvisioningTranscriptEntry[];
}

export interface SystemProvisioningProgressEventData {
  phase: ThreadProvisioningProgressPhase;
  status: ThreadProvisioningProgressStatus;
  durationMs?: number;
  transcript: ProvisioningTranscriptEntry[];
}

export interface SystemProvisioningEnvSetupEventData {
  setup: {
    status: "started" | "running" | "completed" | "failed";
    scriptPath: string;
    timeoutMs?: number;
    durationMs?: number;
    output?: string;
  };
  workspaceRoot?: string;
  reason?: ThreadEnvironmentStartReason;
  transcript: ProvisioningTranscriptEntry[];
}

export interface SystemProvisioningFallbackEventData {
  requestedEnvironmentId: string;
  fallbackEnvironmentId: string;
  detail?: string;
  transcript: ProvisioningTranscriptEntry[];
}

export interface SystemProvisioningCompletedEventData {
  attachedEnvironmentId?: string;
  providerThreadId?: string;
  workspaceRoot?: string;
  reason?: ThreadProvisioningReason;
  transcript: ProvisioningTranscriptEntry[];
}

export interface SystemProvisioningCleanupFailedEventData {
  message: string;
  detail?: string;
}

export interface SystemWorktreeCommitEventData {
  status: "committed" | "noop";
  message: string;
  commitSha?: string;
  commitSubject?: string;
  includeUnstaged?: boolean;
}

export interface SystemWorktreeSquashMergeEventData {
  status: "merged" | "noop" | "conflict";
  message: string;
  committed?: boolean;
  commitSha?: string;
  commitSubject?: string;
  mergeBaseBranch?: string;
  conflictFiles?: string[];
}

export interface SystemManagerUserMessageEventData {
  text: string;
  toolCallId?: string;
  turnId?: string;
}

export interface TurnLifecycleEventData {
  turnId?: string;
  input?: PromptInput[];
}

export type ThreadEventDataByAppType = {
  "client/thread/start": ClientOutboundStartEventData;
  "client/turn/requested": ClientOutboundStartEventData;
  "client/turn/start": ClientOutboundStartEventData;
  "system/error": SystemErrorEventData;
  "system/manager/user_message": SystemManagerUserMessageEventData;
  "system/thread/interrupted": SystemThreadInterruptedEventData;
  "system/thread-title/updated": SystemThreadTitleUpdatedEventData;
  "system/operation": SystemOperationEventData;
  "system/worktree/commit": SystemWorktreeCommitEventData;
  "system/worktree/squash_merge": SystemWorktreeSquashMergeEventData;
  "system/provisioning/started": SystemProvisioningStartedEventData;
  "system/provisioning/progress": SystemProvisioningProgressEventData;
  "system/provisioning/env_setup": SystemProvisioningEnvSetupEventData;
  "system/provisioning/fallback": SystemProvisioningFallbackEventData;
  "system/provisioning/completed": SystemProvisioningCompletedEventData;
  "system/provisioning/cleanup_failed": SystemProvisioningCleanupFailedEventData;
};

export type ThreadEventData =
  | ThreadEventDataByAppType[AppThreadEventType]
  | Record<string, unknown>;

export type ThreadEventDataForType<TType extends string> =
  TType extends AppThreadEventType
    ? ThreadEventDataByAppType[TType]
    : Record<string, unknown>;

export const threadEventRowSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  seq: z.number(),
  type: z.string(),
  data: z.record(z.unknown()),
  createdAt: z.number(),
});

export interface ThreadEventRow<TType extends string = string> {
  id: string;
  threadId: string;
  seq: number;
  type: TType;
  data: ThreadEventDataForType<TType>;
  createdAt: number;
}

export type ThreadEventOfType<TType extends string> = ThreadEventRow<TType>;
