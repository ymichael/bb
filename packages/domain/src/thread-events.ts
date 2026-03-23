import { z } from "zod";
import {
  promptInputSchema,
  reasoningLevelSchema,
  sandboxModeSchema,
  serviceTierSchema,
} from "./shared-types.js";

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

export const clientExecutionOptionsSnapshotSchema = z.object({
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
  approvalPolicy: z.string().optional(),
});
export type ClientExecutionOptionsSnapshot = z.infer<
  typeof clientExecutionOptionsSnapshotSchema
>;

export const clientOutboundStartEventDataSchema = z.object({
  direction: z.literal("outbound"),
  source: z.enum(["spawn", "tell"]),
  initiator: threadTurnInitiatorSchema.optional(),
  input: z.array(promptInputSchema).optional(),
  request: z.object({
    method: z.enum(["thread/start", "turn/start"]),
    params: z.record(z.string(), z.unknown()),
  }),
  execution: clientExecutionOptionsSnapshotSchema,
});
export type ClientOutboundStartEventData = z.infer<
  typeof clientOutboundStartEventDataSchema
>;

export const systemErrorEventDataSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  detail: z.string().optional(),
});
export type SystemErrorEventData = z.infer<typeof systemErrorEventDataSchema>;

export const systemThreadTitleUpdatedEventDataSchema = z.object({
  title: z.string(),
  previousTitle: z.string().optional(),
  source: z.literal("provider"),
  providerMethod: z.string().optional(),
});
export type SystemThreadTitleUpdatedEventData = z.infer<
  typeof systemThreadTitleUpdatedEventDataSchema
>;

export const systemOperationEventDataSchema = z.object({
  operation: z.string(),
  status: z.string(),
  message: z.string(),
  operationId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SystemOperationEventData = z.infer<
  typeof systemOperationEventDataSchema
>;

export const systemThreadInterruptedEventDataSchema = z.object({
  reason: z.literal("user"),
  message: z.string().optional(),
});
export type SystemThreadInterruptedEventData = z.infer<
  typeof systemThreadInterruptedEventDataSchema
>;

export const provisioningTranscriptEntrySchema = z.object({
  key: z.string(),
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  startedAt: z.number().optional(),
});
export type ProvisioningTranscriptEntry = z.infer<
  typeof provisioningTranscriptEntrySchema
>;

export const systemProvisioningStartedEventDataSchema = z.object({
  attachedEnvironmentId: z.string().optional(),
  reason: threadProvisioningReasonSchema.optional(),
  transcript: z.array(provisioningTranscriptEntrySchema),
});
export type SystemProvisioningStartedEventData = z.infer<
  typeof systemProvisioningStartedEventDataSchema
>;

export const systemProvisioningProgressEventDataSchema = z.object({
  phase: threadProvisioningProgressPhaseSchema,
  status: threadProvisioningProgressStatusSchema,
  durationMs: z.number().optional(),
  transcript: z.array(provisioningTranscriptEntrySchema),
});
export type SystemProvisioningProgressEventData = z.infer<
  typeof systemProvisioningProgressEventDataSchema
>;

export const systemProvisioningEnvSetupEventDataSchema = z.object({
  setup: z.object({
    status: z.enum(["started", "running", "completed", "failed"]),
    scriptPath: z.string(),
    timeoutMs: z.number().optional(),
    durationMs: z.number().optional(),
    output: z.string().optional(),
  }),
  workspaceRoot: z.string().optional(),
  reason: threadEnvironmentStartReasonSchema.optional(),
  transcript: z.array(provisioningTranscriptEntrySchema),
});
export type SystemProvisioningEnvSetupEventData = z.infer<
  typeof systemProvisioningEnvSetupEventDataSchema
>;

export const systemProvisioningFallbackEventDataSchema = z.object({
  requestedEnvironmentId: z.string(),
  fallbackEnvironmentId: z.string(),
  detail: z.string().optional(),
  transcript: z.array(provisioningTranscriptEntrySchema),
});
export type SystemProvisioningFallbackEventData = z.infer<
  typeof systemProvisioningFallbackEventDataSchema
>;

export const systemProvisioningCompletedEventDataSchema = z.object({
  attachedEnvironmentId: z.string().optional(),
  providerThreadId: z.string().optional(),
  workspaceRoot: z.string().optional(),
  reason: threadProvisioningReasonSchema.optional(),
  transcript: z.array(provisioningTranscriptEntrySchema),
});
export type SystemProvisioningCompletedEventData = z.infer<
  typeof systemProvisioningCompletedEventDataSchema
>;

export const systemProvisioningCleanupFailedEventDataSchema = z.object({
  message: z.string(),
  detail: z.string().optional(),
});
export type SystemProvisioningCleanupFailedEventData = z.infer<
  typeof systemProvisioningCleanupFailedEventDataSchema
>;

export const systemWorktreeCommitEventDataSchema = z.object({
  status: z.enum(["committed", "noop"]),
  message: z.string(),
  commitSha: z.string().optional(),
  commitSubject: z.string().optional(),
  includeUnstaged: z.boolean().optional(),
});
export type SystemWorktreeCommitEventData = z.infer<
  typeof systemWorktreeCommitEventDataSchema
>;

export const systemWorktreeSquashMergeEventDataSchema = z.object({
  status: z.enum(["merged", "noop", "conflict"]),
  message: z.string(),
  committed: z.boolean().optional(),
  commitSha: z.string().optional(),
  commitSubject: z.string().optional(),
  mergeBaseBranch: z.string().optional(),
  conflictFiles: z.array(z.string()).optional(),
});
export type SystemWorktreeSquashMergeEventData = z.infer<
  typeof systemWorktreeSquashMergeEventDataSchema
>;

export const systemManagerUserMessageEventDataSchema = z.object({
  text: z.string(),
  toolCallId: z.string().optional(),
  turnId: z.string().optional(),
});
export type SystemManagerUserMessageEventData = z.infer<
  typeof systemManagerUserMessageEventDataSchema
>;

export const turnLifecycleEventDataSchema = z.object({
  turnId: z.string().optional(),
  input: z.array(promptInputSchema).optional(),
});
export type TurnLifecycleEventData = z.infer<
  typeof turnLifecycleEventDataSchema
>;

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
