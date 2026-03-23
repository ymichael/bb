import { z } from "zod";
import {
  environmentCapabilitiesSchema,
  promptInputSchema,
  providerCapabilitiesSchema,
  reasoningLevelSchema,
  sandboxModeSchema,
  serviceTierSchema,
  timelineRowSchema,
  threadContextWindowUsageSchema,
  threadQueuedMessageSchema,
  threadStatusSchema,
  threadTypeSchema,
  viewMessageSchema,
} from "@bb/domain";
import { apiErrorSchema } from "./errors.js";

// --- Thread creation & messaging (renamed per architecture) ---

export const sendMessageModeSchema = z.enum(["auto", "start", "steer"]);
export type SendMessageMode = z.infer<typeof sendMessageModeSchema>;

export const createThreadRequestSchema = z.object({
  projectId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  type: threadTypeSchema.optional(),
  title: z.string().min(1).optional(),
  input: z.array(promptInputSchema).min(1).optional(),
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
  environmentId: z.string().min(1).optional(),
  hostId: z.string().min(1).optional(),
  path: z.string().optional(),
  provisionerId: z.enum(["worktree", "e2b"]).optional(),
  environmentDescriptor: z
    .object({
      type: z.string().min(1),
      path: z.string().min(1),
    })
    .optional(),
  environmentCreationArgs: z
    .object({
      kind: z.string().min(1),
    })
    .optional(),
  parentThreadId: z.string().optional(),
  spawnInitiator: z.enum(["user", "agent", "system"]).optional(),
});
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;
export const spawnThreadRequestSchema = createThreadRequestSchema;
export type SpawnThreadRequest = CreateThreadRequest;

export const sendMessageRequestSchema = z.object({
  input: z.array(promptInputSchema).min(1),
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
  mode: sendMessageModeSchema.optional(),
  demotePrimaryIfNeeded: z.boolean().optional(),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;
export const tellThreadRequestSchema = sendMessageRequestSchema;
export type TellThreadRequest = SendMessageRequest;

export const createDraftRequestSchema = z.object({
  input: z.array(promptInputSchema).min(1),
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
});
export type CreateDraftRequest = z.infer<typeof createDraftRequestSchema>;
export const enqueueThreadMessageRequestSchema = createDraftRequestSchema;
export type EnqueueThreadMessageRequest = CreateDraftRequest;

export const sendDraftRequestSchema = z.object({
  mode: z.enum(["auto", "steer-if-active", "steer"]).optional(),
});
export type SendDraftRequest = z.infer<typeof sendDraftRequestSchema>;
export const sendQueuedThreadMessageRequestSchema = sendDraftRequestSchema;
export type SendQueuedThreadMessageRequest = SendDraftRequest;

export const sendDraftResponseSchema = z.object({
  ok: z.literal(true),
  queuedMessage: threadQueuedMessageSchema,
});
export type SendDraftResponse = z.infer<typeof sendDraftResponseSchema>;
export const sendQueuedThreadMessageResponseSchema = sendDraftResponseSchema;
export type SendQueuedThreadMessageResponse = SendDraftResponse;

export const updateThreadRequestSchema = z
  .object({
    title: z.string().min(1).optional(),
    mergeBaseBranch: z.string().min(1).nullable().optional(),
    parentThreadId: z.string().nullable().optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.mergeBaseBranch !== undefined ||
      value.parentThreadId !== undefined,
    "At least one field must be provided",
  );
export type UpdateThreadRequest = z.infer<typeof updateThreadRequestSchema>;

// --- Projects ---

export const createProjectRequestSchema = z
  .object({
    name: z.string(),
    rootPath: z.string().optional(),
    sourcePath: z.string().optional(),
    hostId: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.rootPath) {
      return;
    }
    if (value.sourcePath && value.hostId) {
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide rootPath or both sourcePath and hostId",
      path: ["rootPath"],
    });
  });
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = z
  .object({
    name: z.string().optional(),
    rootPath: z.string().optional(),
    projectInstructions: z.string().optional(),
    defaultProviderId: z.string().min(1).nullable().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.rootPath !== undefined ||
      value.projectInstructions !== undefined ||
      value.defaultProviderId !== undefined,
    "At least one field must be provided",
  );
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

// --- Primary checkout ---

export const primaryCheckoutStatusSchema = z.object({
  projectId: z.string(),
  activeEnvironmentId: z.string().optional(),
  activeThreadId: z.string().optional(),
  promotedAt: z.number().optional(),
});
export type PrimaryCheckoutStatus = z.infer<typeof primaryCheckoutStatusSchema>;

// --- Environment actions (renamed from operations) ---

export const environmentActionTypeSchema = z.enum([
  "promote",
  "demote",
  "commit",
  "squash_merge",
]);
export type EnvironmentActionType = z.infer<typeof environmentActionTypeSchema>;

export const commitOptionsSchema = z.object({
  message: z.string().min(1).optional(),
  includeUnstaged: z.boolean().optional(),
  autoArchiveOnSuccess: z.boolean().optional(),
});
export type CommitOptions = z.infer<typeof commitOptionsSchema>;
export const commitOperationOptionsSchema = commitOptionsSchema;
export type CommitOperationOptions = CommitOptions;

export const squashMergeOptionsSchema = z.object({
  commitIfNeeded: z.boolean().optional(),
  includeUnstaged: z.boolean().optional(),
  commitMessage: z.string().min(1).optional(),
  squashMessage: z.string().min(1).optional(),
  mergeBaseBranch: z.string().min(1).optional(),
  autoArchiveOnSuccess: z.boolean().optional(),
});
export type SquashMergeOptions = z.infer<typeof squashMergeOptionsSchema>;
export const squashMergeOperationOptionsSchema = squashMergeOptionsSchema;
export type SquashMergeOperationOptions = SquashMergeOptions;

export const threadOperationRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("commit"),
    options: commitOperationOptionsSchema.optional(),
  }),
  z.object({
    operation: z.literal("squash_merge"),
    options: squashMergeOperationOptionsSchema.optional(),
  }),
]);
export type ThreadOperationRequest = z.infer<typeof threadOperationRequestSchema>;

export const environmentActionRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("promote"),
    initiatingThreadId: z.string().min(1),
  }),
  z.object({
    action: z.literal("demote"),
    initiatingThreadId: z.string().min(1),
  }),
  z.object({
    action: z.literal("commit"),
    initiatingThreadId: z.string().min(1),
    options: commitOptionsSchema.optional(),
  }),
  z.object({
    action: z.literal("squash_merge"),
    initiatingThreadId: z.string().min(1),
    options: squashMergeOptionsSchema.optional(),
  }),
]);
export type EnvironmentActionRequest = z.infer<typeof environmentActionRequestSchema>;

const promotePrimaryEnvironmentOperationRequestSchema = z.object({
  operation: z.literal("promote_primary"),
  initiatingThreadId: z.string().min(1),
});

const demotePrimaryEnvironmentOperationRequestSchema = z.object({
  operation: z.literal("demote_primary"),
  initiatingThreadId: z.string().min(1),
});

const commitEnvironmentOperationRequestSchema = z.object({
  operation: z.literal("commit"),
  initiatingThreadId: z.string().min(1),
  options: commitOperationOptionsSchema.optional(),
});

const squashMergeEnvironmentOperationRequestSchema = z.object({
  operation: z.literal("squash_merge"),
  initiatingThreadId: z.string().min(1),
  options: squashMergeOperationOptionsSchema.optional(),
});

export const environmentOperationRequestSchema = z.discriminatedUnion("operation", [
  promotePrimaryEnvironmentOperationRequestSchema,
  demotePrimaryEnvironmentOperationRequestSchema,
  commitEnvironmentOperationRequestSchema,
  squashMergeEnvironmentOperationRequestSchema,
]);
export type EnvironmentOperationRequest = z.infer<typeof environmentOperationRequestSchema>;

export const commitActionResponseSchema = z.object({
  ok: z.literal(true),
  action: z.literal("commit"),
  commitCreated: z.boolean(),
  message: z.string(),
  autoArchived: z.boolean(),
  commitSha: z.string().optional(),
  commitSubject: z.string().optional(),
});
export type CommitActionResponse = z.infer<typeof commitActionResponseSchema>;
export const commitEnvironmentOperationResponseSchema =
  commitActionResponseSchema.extend({
    operation: z.literal("commit"),
  });
export type CommitEnvironmentOperationResponse = z.infer<
  typeof commitEnvironmentOperationResponseSchema
>;

export const squashMergeActionResponseSchema = z.object({
  ok: z.literal(true),
  action: z.literal("squash_merge"),
  merged: z.boolean(),
  message: z.string(),
  autoArchived: z.boolean(),
  commitSha: z.string().optional(),
  commitSubject: z.string().optional(),
});
export type SquashMergeActionResponse = z.infer<typeof squashMergeActionResponseSchema>;
export const squashMergeEnvironmentOperationResponseSchema =
  squashMergeActionResponseSchema.extend({
    operation: z.literal("squash_merge"),
  });
export type SquashMergeEnvironmentOperationResponse = z.infer<
  typeof squashMergeEnvironmentOperationResponseSchema
>;

export const environmentActionResponseSchema = z.discriminatedUnion("action", [
  commitActionResponseSchema,
  squashMergeActionResponseSchema,
  z.object({
    action: z.literal("promote"),
    ok: z.literal(true),
    message: z.string(),
  }),
  z.object({
    action: z.literal("demote"),
    ok: z.literal(true),
    message: z.string(),
  }),
]);
export type EnvironmentActionResponse = z.infer<typeof environmentActionResponseSchema>;

export const promotePrimaryCheckoutResponseSchema = z.object({
  ok: z.literal(true),
  operation: z.literal("promote_primary"),
  promoted: z.boolean(),
  message: z.string(),
  primaryStatus: primaryCheckoutStatusSchema,
});
export type PromotePrimaryCheckoutResponse = z.infer<
  typeof promotePrimaryCheckoutResponseSchema
>;

export const demotePrimaryCheckoutResponseSchema = z.object({
  ok: z.literal(true),
  operation: z.literal("demote_primary"),
  demoted: z.boolean(),
  message: z.string(),
  primaryStatus: primaryCheckoutStatusSchema,
});
export type DemotePrimaryCheckoutResponse = z.infer<
  typeof demotePrimaryCheckoutResponseSchema
>;

export const environmentOperationResponseSchema = z.discriminatedUnion(
  "operation",
  [
    commitEnvironmentOperationResponseSchema,
    squashMergeEnvironmentOperationResponseSchema,
    promotePrimaryCheckoutResponseSchema,
    demotePrimaryCheckoutResponseSchema,
  ],
);
export type EnvironmentOperationResponse = z.infer<
  typeof environmentOperationResponseSchema
>;

export const environmentActionFailureDetailsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("commit_failed"),
    errorMessage: z.string(),
  }),
  z.object({
    kind: z.literal("squash_merge_conflict"),
    conflictFiles: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("squash_merge_commit_failed"),
    stage: z.enum(["prep_commit", "squash_commit"]),
    errorMessage: z.string(),
  }),
]);
export type EnvironmentActionFailureDetails = z.infer<typeof environmentActionFailureDetailsSchema>;

export const environmentActionApiErrorSchema = apiErrorSchema.extend({
  details: environmentActionFailureDetailsSchema.optional(),
});
export type EnvironmentActionApiError = z.infer<typeof environmentActionApiErrorSchema>;

export const commitFailureEnvironmentOperationDetailsSchema = z.object({
  operation: z.literal("commit"),
  kind: z.literal("commit_failed"),
  request: commitEnvironmentOperationRequestSchema,
  errorMessage: z.string(),
});
export type CommitFailureEnvironmentOperationDetails = z.infer<
  typeof commitFailureEnvironmentOperationDetailsSchema
>;

export const squashMergeConflictEnvironmentOperationDetailsSchema = z.object({
  operation: z.literal("squash_merge"),
  kind: z.literal("squash_merge_conflict"),
  request: squashMergeEnvironmentOperationRequestSchema,
  conflictFiles: z.array(z.string()),
});
export type SquashMergeConflictEnvironmentOperationDetails = z.infer<
  typeof squashMergeConflictEnvironmentOperationDetailsSchema
>;

export const squashMergeCommitFailureEnvironmentOperationDetailsSchema = z.object({
  operation: z.literal("squash_merge"),
  kind: z.literal("squash_merge_commit_failed"),
  request: squashMergeEnvironmentOperationRequestSchema,
  stage: z.enum(["prep_commit", "squash_commit"]),
  errorMessage: z.string(),
});
export type SquashMergeCommitFailureEnvironmentOperationDetails = z.infer<
  typeof squashMergeCommitFailureEnvironmentOperationDetailsSchema
>;

export const environmentOperationFailureDetailsSchema = z.discriminatedUnion(
  "kind",
  [
    commitFailureEnvironmentOperationDetailsSchema,
    squashMergeConflictEnvironmentOperationDetailsSchema,
    squashMergeCommitFailureEnvironmentOperationDetailsSchema,
  ],
);
export type EnvironmentOperationFailureDetails = z.infer<
  typeof environmentOperationFailureDetailsSchema
>;

export const environmentOperationApiErrorSchema = apiErrorSchema.extend({
  details: environmentOperationFailureDetailsSchema.optional(),
});
export type EnvironmentOperationApiError = z.infer<
  typeof environmentOperationApiErrorSchema
>;

// --- Timeline (renamed from tool-group-messages) ---

export const timelineToolDetailsRequestSchema = z.object({
  turnId: z.string(),
  sourceSeqStart: z.number(),
  sourceSeqEnd: z.number(),
  includeManagerDebugView: z.boolean().optional(),
});
export type TimelineToolDetailsRequest = z.infer<typeof timelineToolDetailsRequestSchema>;

export const timelineToolDetailsResponseSchema = z.object({
  messages: z.array(viewMessageSchema),
});
export type TimelineToolDetailsResponse = z.infer<typeof timelineToolDetailsResponseSchema>;
export const threadToolGroupMessagesResponseSchema =
  timelineToolDetailsResponseSchema;
export type ThreadToolGroupMessagesResponse = TimelineToolDetailsResponse;

export const threadTimelineResponseSchema = z.object({
  rows: z.array(timelineRowSchema),
  contextWindowUsage: threadContextWindowUsageSchema.nullable().optional(),
});
export type ThreadTimelineResponse = z.infer<typeof threadTimelineResponseSchema>;

// --- File suggestions ---

export const projectFileSuggestionSchema = z.object({
  path: z.string(),
});
export type ProjectFileSuggestion = z.infer<typeof projectFileSuggestionSchema>;

export const promptMentionSuggestionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    path: z.string(),
    replacement: z.string(),
  }),
  z.object({
    kind: z.literal("thread"),
    path: z.string(),
    replacement: z.string(),
    threadId: z.string(),
    title: z.string().optional(),
    threadType: threadTypeSchema,
  }),
]);
export type PromptMentionSuggestion = z.infer<typeof promptMentionSuggestionSchema>;

// --- Upload ---

export const uploadedPromptAttachmentSchema = z.object({
  type: z.enum(["localImage", "localFile"]),
  path: z.string(),
  name: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number(),
});
export type UploadedPromptAttachment = z.infer<typeof uploadedPromptAttachmentSchema>;

// --- Open path ---

export const openPathTargetSchema = z.enum(["file", "directory"]);
export type OpenPathTarget = z.infer<typeof openPathTargetSchema>;

export const openPathEditorSchema = z.enum([
  "system_default",
  "vscode",
  "cursor",
  "zed",
  "windsurf",
]);
export type OpenPathEditor = z.infer<typeof openPathEditorSchema>;

export const openPathRequestSchema = z.object({
  path: z.string(),
  target: openPathTargetSchema.optional(),
  editor: openPathEditorSchema.optional(),
  command: z.string().optional(),
});
export type OpenPathRequest = z.infer<typeof openPathRequestSchema>;

export const openThreadPathRequestSchema = z.object({
  relativePath: z.string(),
  target: openPathTargetSchema.optional(),
  editor: openPathEditorSchema.optional(),
  command: z.string().optional(),
});
export type OpenThreadPathRequest = z.infer<typeof openThreadPathRequestSchema>;

// --- System ---

export const systemVoiceTranscriptionResponseSchema = z.object({
  text: z.string(),
});
export type SystemVoiceTranscriptionResponse = z.infer<typeof systemVoiceTranscriptionResponseSchema>;

export const systemStatusSchema = z.object({
  runningThreads: z.number(),
  totalThreads: z.number(),
  uptime: z.number(),
});
export type SystemStatus = z.infer<typeof systemStatusSchema>;

export const systemHealthThreadCountsSchema = z.object({
  total: z.number(),
  archived: z.number(),
  created: z.number(),
  provisioning: z.number(),
  provisioned: z.number(),
  provisioningFailed: z.number(),
  error: z.number(),
  active: z.number(),
  idle: z.number(),
});
export type SystemHealthThreadCounts = z.infer<typeof systemHealthThreadCountsSchema>;

export const systemHealthStorageBucketKeySchema = z.enum([
  "database",
  "database_wal",
  "database_shm",
  "logs",
  "hosts",
  "projects",
  "worktrees",
  "archives",
  "backups",
]);
export type SystemHealthStorageBucketKey = z.infer<
  typeof systemHealthStorageBucketKeySchema
>;

export const systemHealthStorageBucketSchema = z.object({
  key: systemHealthStorageBucketKeySchema,
  label: z.string(),
  bytes: z.number(),
  paths: z.array(z.string()),
});
export type SystemHealthStorageBucket = z.infer<
  typeof systemHealthStorageBucketSchema
>;

export const systemHealthDiskSummarySchema = z.object({
  path: z.string(),
  availableBytes: z.number(),
  totalBytes: z.number(),
  usedBytes: z.number(),
});
export type SystemHealthDiskSummary = z.infer<
  typeof systemHealthDiskSummarySchema
>;

export const systemHealthDaemonSessionSchema = z.object({
  sessionId: z.string(),
  hostId: z.string(),
  instanceId: z.string(),
  protocolVersion: z.number(),
  leaseExpiresAt: z.number(),
  lastHeartbeatAt: z.number().optional(),
  createdAt: z.number(),
});
export type SystemHealthDaemonSession = z.infer<typeof systemHealthDaemonSessionSchema>;

export const systemHealthReportSchema = z.object({
  generatedAt: z.number(),
  uptime: z.number(),
  projectCount: z.number(),
  runningThreads: z.number(),
  threadCounts: systemHealthThreadCountsSchema,
  daemon: z.object({
    activeSessionCount: z.number(),
    activeSessions: z.array(systemHealthDaemonSessionSchema),
  }),
  storage: z.object({
    totalBytes: z.number(),
    disk: systemHealthDiskSummarySchema.optional(),
    buckets: z.array(systemHealthStorageBucketSchema),
  }),
});
export type SystemHealthReport = z.infer<typeof systemHealthReportSchema>;

export const systemProviderInfoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  capabilities: providerCapabilitiesSchema,
});
export type SystemProviderInfo = z.infer<typeof systemProviderInfoSchema>;

export const systemEnvironmentInfoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  capabilities: environmentCapabilitiesSchema,
});
export type SystemEnvironmentInfo = z.infer<typeof systemEnvironmentInfoSchema>;

export const systemRestartActionSchema = z.enum(["noop"]);
export type SystemRestartAction = z.infer<typeof systemRestartActionSchema>;

export const serverRuntimeModeSchema = z.enum(["development", "production"]);
export type ServerRuntimeMode = z.infer<typeof serverRuntimeModeSchema>;

export const systemRestartPolicySchema = z.object({
  runtimeMode: serverRuntimeModeSchema,
  restartPolicyByStatus: z.object({
    created: systemRestartActionSchema,
    provisioning: systemRestartActionSchema,
    provisioned: systemRestartActionSchema,
    provisioning_failed: systemRestartActionSchema,
    error: systemRestartActionSchema,
    idle: systemRestartActionSchema,
    active: systemRestartActionSchema,
  }),
  shutdownBlockingStatuses: z.array(threadStatusSchema),
  shouldRestart: z.boolean(),
});
export type SystemRestartPolicy = z.infer<typeof systemRestartPolicySchema>;

export const systemRestartRequestSchema = z.object({
  force: z.boolean().optional(),
});
export type SystemRestartRequest = z.infer<typeof systemRestartRequestSchema>;

export const systemShutdownRequestSchema = z.object({
  force: z.boolean().optional(),
});
export type SystemShutdownRequest = z.infer<typeof systemShutdownRequestSchema>;

export const systemShutdownAcceptedResponseSchema = z.object({
  ok: z.literal(true),
  forced: z.boolean(),
  blockingThreadsCount: z.number(),
});
export type SystemShutdownAcceptedResponse = z.infer<typeof systemShutdownAcceptedResponseSchema>;

export const systemRestartAcceptedResponseSchema =
  systemShutdownAcceptedResponseSchema.extend({
    restarting: z.literal(true),
  });
export type SystemRestartAcceptedResponse = z.infer<
  typeof systemRestartAcceptedResponseSchema
>;

export const systemShutdownBlockingThreadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: threadStatusSchema,
});
export type SystemShutdownBlockingThread = z.infer<typeof systemShutdownBlockingThreadSchema>;

export const systemShutdownBlockedResponseSchema = z.object({
  code: z.literal("shutdown_blocked"),
  message: z.string(),
  blockingThreads: z.array(systemShutdownBlockingThreadSchema),
});
export type SystemShutdownBlockedResponse = z.infer<typeof systemShutdownBlockedResponseSchema>;
