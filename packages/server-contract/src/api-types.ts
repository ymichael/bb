import { z } from "zod";
import {
  promptInputSchema,
  providerCapabilitiesSchema,
  reasoningLevelSchema,
  sandboxModeSchema,
  serviceTierSchema,
  timelineRowSchema,
  threadQueuedMessageSchema,
  threadStatusSchema,
  threadTypeSchema,
  viewMessageSchema,
} from "@bb/domain";
import { apiErrorSchema } from "./errors.js";

export const sendMessageModeSchema = z.enum(["auto", "start", "steer"]);
export type SendMessageMode = z.infer<typeof sendMessageModeSchema>;

const threadTimelineContextWindowUsageSchema = z.object({
  totalTokens: z.number(),
  modelContextWindow: z.number(),
});

export const createThreadRequestSchema = z.object({
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  type: threadTypeSchema.optional(),
  title: z.string().min(1).optional(),
  input: z.array(promptInputSchema).min(1).optional(),
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
  environmentId: z.string().min(1).optional(),
  hostId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  provisionerId: z.enum(["worktree", "e2b"]).optional(),
  parentThreadId: z.string().min(1).optional(),
  spawnInitiator: z.enum(["user", "agent", "system"]).optional(),
});
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;

export const sendMessageRequestSchema = z.object({
  input: z.array(promptInputSchema).min(1),
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
  mode: sendMessageModeSchema.optional(),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const createDraftRequestSchema = z.object({
  input: z.array(promptInputSchema).min(1),
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
});
export type CreateDraftRequest = z.infer<typeof createDraftRequestSchema>;

export const sendDraftRequestSchema = z.object({
  mode: sendMessageModeSchema.optional(),
});
export type SendDraftRequest = z.infer<typeof sendDraftRequestSchema>;

export const sendDraftResponseSchema = z.object({
  ok: z.literal(true),
  queuedMessage: threadQueuedMessageSchema,
});
export type SendDraftResponse = z.infer<typeof sendDraftResponseSchema>;

export const updateThreadRequestSchema = z
  .object({
    title: z.string().min(1).nullable().optional(),
    mergeBaseBranch: z.string().min(1).nullable().optional(),
    parentThreadId: z.string().min(1).nullable().optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.mergeBaseBranch !== undefined ||
      value.parentThreadId !== undefined,
    "At least one field must be provided",
  );
export type UpdateThreadRequest = z.infer<typeof updateThreadRequestSchema>;

export const createProjectRequestSchema = z.object({
  name: z.string().min(1),
  hostId: z.string().min(1),
  sourcePath: z.string().min(1),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
  })
  .refine(
    (value) => value.name !== undefined,
    "At least one field must be provided",
  );
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

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

export const squashMergeOptionsSchema = z.object({
  commitIfNeeded: z.boolean().optional(),
  includeUnstaged: z.boolean().optional(),
  commitMessage: z.string().min(1).optional(),
  squashMessage: z.string().min(1).optional(),
  mergeBaseBranch: z.string().min(1).optional(),
  autoArchiveOnSuccess: z.boolean().optional(),
});
export type SquashMergeOptions = z.infer<typeof squashMergeOptionsSchema>;

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

const promoteActionResponseSchema = z.object({
  ok: z.literal(true),
  action: z.literal("promote"),
  message: z.string(),
});

const demoteActionResponseSchema = z.object({
  ok: z.literal(true),
  action: z.literal("demote"),
  message: z.string(),
});

export const environmentActionResponseSchema = z.discriminatedUnion("action", [
  promoteActionResponseSchema,
  demoteActionResponseSchema,
  commitActionResponseSchema,
  squashMergeActionResponseSchema,
]);
export type EnvironmentActionResponse = z.infer<typeof environmentActionResponseSchema>;

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

export const threadTimelineResponseSchema = z.object({
  rows: z.array(timelineRowSchema),
  contextWindowUsage: threadTimelineContextWindowUsageSchema.nullable().optional(),
});
export type ThreadTimelineResponse = z.infer<typeof threadTimelineResponseSchema>;

export const systemProviderInfoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  capabilities: providerCapabilitiesSchema,
});
export type SystemProviderInfo = z.infer<typeof systemProviderInfoSchema>;

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

export const systemVoiceTranscriptionResponseSchema = z.object({
  text: z.string(),
});
export type SystemVoiceTranscriptionResponse = z.infer<typeof systemVoiceTranscriptionResponseSchema>;
