import { z } from "zod";
import {
  projectSchema,
  projectSourceSchema,
  promptInputSchema,
  reasoningLevelSchema,
  sandboxModeSchema,
  serviceTierSchema,
  timelineRowSchema,
  threadQueuedMessageSchema,
  threadTypeSchema,
  viewMessageSchema,
  workspaceStatusSchema,
} from "@bb/domain";
import { apiErrorSchema } from "./errors.js";

export const sendMessageModeSchema = z.enum(["auto", "start", "steer"]);
export type SendMessageMode = z.infer<typeof sendMessageModeSchema>;

export const threadContextWindowUsageSchema = z.object({
  totalTokens: z.number(),
  modelContextWindow: z.number(),
});
export type ThreadContextWindowUsage = z.infer<typeof threadContextWindowUsageSchema>;

// --- Thread creation: environment + workspace discriminated unions ---

export const unmanagedWorkspaceSchema = z.object({
  type: z.literal("unmanaged"),
  path: z.string().min(1).nullable(),
});

export const managedWorktreeWorkspaceSchema = z.object({
  type: z.literal("managed-worktree"),
});

export const managedCloneWorkspaceSchema = z.object({
  type: z.literal("managed-clone"),
});

export const workspaceArgsSchema = z.discriminatedUnion("type", [
  unmanagedWorkspaceSchema,
  managedWorktreeWorkspaceSchema,
  managedCloneWorkspaceSchema,
]);
export type WorkspaceArgs = z.infer<typeof workspaceArgsSchema>;

export const reuseEnvironmentSchema = z.object({
  type: z.literal("reuse"),
  environmentId: z.string().min(1),
});

export const hostEnvironmentSchema = z.object({
  type: z.literal("host"),
  hostId: z.string().min(1),
  workspace: workspaceArgsSchema,
});

export const sandboxHostEnvironmentSchema = z.object({
  type: z.literal("sandbox-host"),
  sandboxType: z.string().min(1),
});

export const environmentArgsSchema = z.discriminatedUnion("type", [
  reuseEnvironmentSchema,
  hostEnvironmentSchema,
  sandboxHostEnvironmentSchema,
]);
export type EnvironmentArgs = z.infer<typeof environmentArgsSchema>;

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
  environment: environmentArgsSchema,
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

export const createManagerThreadRequestSchema = z.object({
  title: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
});
export type CreateManagerThreadRequest = z.infer<
  typeof createManagerThreadRequestSchema
>;

export const updateProjectRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
  })
  .refine(
    (value) => value.name !== undefined,
    "At least one field must be provided",
  );
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export const createProjectSourceRequestSchema = z.object({
  hostId: z.string().min(1),
  type: z.enum(["local_path", "github_repo"]).optional(),
  path: z.string().min(1).optional(),
  repoUrl: z.string().url().optional(),
});
export type CreateProjectSourceRequest = z.infer<typeof createProjectSourceRequestSchema>;

export const updateProjectSourceRequestSchema = z
  .object({
    path: z.string().min(1).optional(),
    repoUrl: z.string().url().optional(),
  })
  .refine(
    (value) => value.path !== undefined || value.repoUrl !== undefined,
    "At least one field must be provided",
  );
export type UpdateProjectSourceRequest = z.infer<typeof updateProjectSourceRequestSchema>;

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

const environmentActionTargetSchema = z.object({
  threadId: z.string().min(1),
});

export const environmentActionRequestSchema = z.discriminatedUnion("action", [
  environmentActionTargetSchema.extend({
    action: z.literal("promote"),
  }),
  environmentActionTargetSchema.extend({
    action: z.literal("demote"),
  }),
  environmentActionTargetSchema.extend({
    action: z.literal("commit"),
    options: commitOptionsSchema.optional(),
  }),
  environmentActionTargetSchema.extend({
    action: z.literal("squash_merge"),
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
  contextWindowUsage: threadContextWindowUsageSchema.nullable().optional(),
});
export type ThreadTimelineResponse = z.infer<typeof threadTimelineResponseSchema>;

// SystemProviderInfo is the same shape as ProviderInfo from domain.
// Re-export with the API-facing name for backward compatibility.
export { providerInfoSchema as systemProviderInfoSchema } from "@bb/domain";
export type { ProviderInfo as SystemProviderInfo } from "@bb/domain";

export const systemVoiceTranscriptionResponseSchema = z.object({
  text: z.string(),
});
export type SystemVoiceTranscriptionResponse = z.infer<typeof systemVoiceTranscriptionResponseSchema>;

export const workspaceFileSchema = z.object({
  path: z.string(),
  name: z.string(),
});
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

export const projectResponseSchema = projectSchema.extend({
  sources: z.array(projectSourceSchema),
});
export type ProjectResponse = z.infer<typeof projectResponseSchema>;

export const systemConfigResponseSchema = z.object({
  hostDaemonPort: z.number().nullable(),
});
export type SystemConfigResponse = z.infer<typeof systemConfigResponseSchema>;

export const environmentStatusResponseSchema = z.object({
  workspace: workspaceStatusSchema.nullable(),  // null if daemon unreachable or non-git env
});

export const projectFileSuggestionSchema = z.object({
  path: z.string(),
});
export type ProjectFileSuggestion = z.infer<typeof projectFileSuggestionSchema>;


export const uploadedPromptAttachmentSchema = z.object({
  type: z.enum(["localImage", "localFile"]),
  path: z.string(),
  name: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number(),
});
export type UploadedPromptAttachment = z.infer<typeof uploadedPromptAttachmentSchema>;
export type EnvironmentStatusResponse = z.infer<typeof environmentStatusResponseSchema>;
