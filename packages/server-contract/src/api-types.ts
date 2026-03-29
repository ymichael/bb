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
  type: threadTypeSchema,
  title: z.string().min(1).optional(),
  input: z.array(promptInputSchema).min(1),
  model: z.string().min(1),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
  environment: environmentArgsSchema,
  parentThreadId: z.string().min(1).optional(),
});
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;

export const sendMessageRequestSchema = z.object({
  input: z.array(promptInputSchema).min(1),
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
  mode: sendMessageModeSchema,
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

export const sendDraftRequestSchema = z.object({});
export type SendDraftRequest = z.infer<typeof sendDraftRequestSchema>;

export const sendDraftResponseSchema = z.object({
  ok: z.literal(true),
  queuedMessage: threadQueuedMessageSchema,
});
export type SendDraftResponse = z.infer<typeof sendDraftResponseSchema>;

export const archiveThreadRequestSchema = z.object({
  force: z.boolean(),
});
export type ArchiveThreadRequest = z.infer<typeof archiveThreadRequestSchema>;

export const updateThreadRequestSchema = z
  .object({
    title: z.string().min(1).nullable(),
    mergeBaseBranch: z.string().min(1).nullable(),
    parentThreadId: z.string().min(1).nullable(),
  })
  .partial()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.mergeBaseBranch !== undefined ||
      value.parentThreadId !== undefined,
    "At least one field must be provided",
  );
export type UpdateThreadRequest = z.infer<typeof updateThreadRequestSchema>;

const createLocalPathProjectSourceRequestSchema = z.object({
  hostId: z.string().min(1),
  type: z.literal("local_path"),
  path: z.string().min(1),
});

const createGitHubRepoProjectSourceRequestSchema = z.object({
  hostId: z.string().min(1),
  type: z.literal("github_repo"),
  repoUrl: z.string().url(),
});

export const createProjectSourceRequestSchema = z.discriminatedUnion("type", [
  createLocalPathProjectSourceRequestSchema,
  createGitHubRepoProjectSourceRequestSchema,
]);
export type CreateProjectSourceRequest = z.infer<typeof createProjectSourceRequestSchema>;

export const createProjectRequestSchema = z.object({
  name: z.string().min(1),
  source: createProjectSourceRequestSchema,
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const createManagerThreadRequestSchema = z.object({
  name: z.string().min(1).optional(),
  providerId: z.string().min(1),
  model: z.string().min(1),
  reasoningLevel: reasoningLevelSchema,
});
export type CreateManagerThreadRequest = z.infer<
  typeof createManagerThreadRequestSchema
>;

export const projectFilesQuerySchema = z.object({
  query: z.string().min(1),
  limit: z.string().regex(/^\d+$/),
}).partial();
export type ProjectFilesQuery = z.infer<typeof projectFilesQuerySchema>;

export const projectAttachmentContentQuerySchema = z.object({
  path: z.string().min(1),
});
export type ProjectAttachmentContentQuery = z.infer<
  typeof projectAttachmentContentQuerySchema
>;

const mergeBaseBranchQuerySchema = z
  .string({ required_error: "A merge base branch is required" })
  .min(1, "A merge base branch is required");

export const environmentStatusQuerySchema = z.object({
  mergeBaseBranch: mergeBaseBranchQuerySchema,
});
export type EnvironmentStatusQuery = z.infer<typeof environmentStatusQuerySchema>;

export const environmentDiffQuerySchema = z.discriminatedUnion("selection", [
  z.object({
    selection: z.literal("combined"),
    mergeBaseBranch: mergeBaseBranchQuerySchema,
  }),
  z.object({
    selection: z.literal("commit"),
    commitSha: z.string().min(1),
    mergeBaseBranch: mergeBaseBranchQuerySchema,
  }),
]);
export type EnvironmentDiffQuery = z.infer<typeof environmentDiffQuerySchema>;

export const threadListQuerySchema = z.object({
  projectId: z.string().min(1),
  type: threadTypeSchema,
  parentThreadId: z.string().min(1),
  archived: z.enum(["true", "false"]),
}).partial();
export type ThreadListQuery = z.infer<typeof threadListQuerySchema>;

export const threadTimelineQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/),
  includeManagerDebugView: z.enum(["true", "false"]),
  includeToolGroupMessages: z.enum(["true", "false"]),
}).partial();
export type ThreadTimelineQuery = z.infer<typeof threadTimelineQuerySchema>;

export const timelineToolDetailsQuerySchema = z.object({
  turnId: z.string().min(1),
  sourceSeqStart: z.string().regex(/^\d+$/),
  sourceSeqEnd: z.string().regex(/^\d+$/),
  includeManagerDebugView: z.enum(["true", "false"]).optional(),
});
export type TimelineToolDetailsQuery = z.infer<
  typeof timelineToolDetailsQuerySchema
>;

export const threadEventsQuerySchema = z.object({
  afterSeq: z.string().regex(/^\d+$/),
  limit: z.string().regex(/^\d+$/),
}).partial();
export type ThreadEventsQuery = z.infer<typeof threadEventsQuerySchema>;

export const threadWorkspaceFilesQuerySchema = z.object({
  query: z.string().min(1),
  limit: z.string().regex(/^\d+$/),
}).partial();
export type ThreadWorkspaceFilesQuery = z.infer<
  typeof threadWorkspaceFilesQuerySchema
>;

export const threadWorkspaceFileQuerySchema = z.object({
  path: z.string().min(1),
});
export type ThreadWorkspaceFileQuery = z.infer<
  typeof threadWorkspaceFileQuerySchema
>;

export const systemModelsQuerySchema = z.object({
  providerId: z.string().min(1),
  hostId: z.string().min(1),
  environmentId: z.string().min(1),
}).partial();
export type SystemModelsQuery = z.infer<typeof systemModelsQuerySchema>;

export const systemProvidersQuerySchema = z.object({
  hostId: z.string().min(1),
  environmentId: z.string().min(1),
}).partial();
export type SystemProvidersQuery = z.infer<typeof systemProvidersQuerySchema>;

export interface ProjectAttachmentUploadForm {
  [key: string]: string | Blob;
}

export interface SystemVoiceTranscriptionForm {
  [key: string]: string | Blob;
}

export const updateProjectRequestSchema = z
  .object({
    name: z.string().min(1),
  })
  .partial()
  .refine(
    (value) => value.name !== undefined,
    "At least one field must be provided",
  );
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

const updateLocalPathProjectSourceRequestSchema = z.object({
  type: z.literal("local_path"),
  path: z.string().min(1).optional(),
  isDefault: z.literal(true).optional(),
});

const updateGitHubRepoProjectSourceRequestSchema = z.object({
  type: z.literal("github_repo"),
  repoUrl: z.string().url().optional(),
  isDefault: z.literal(true).optional(),
});

export const updateProjectSourceRequestSchema = z.discriminatedUnion("type", [
  updateLocalPathProjectSourceRequestSchema,
  updateGitHubRepoProjectSourceRequestSchema,
]).refine(
  (value) =>
    ("path" in value && value.path !== undefined) ||
    ("repoUrl" in value && value.repoUrl !== undefined) ||
    value.isDefault !== undefined,
  "At least one field besides type must be provided",
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
  message: z.string().min(1),
  autoArchiveOnSuccess: z.boolean(),
});
export type CommitOptions = z.infer<typeof commitOptionsSchema>;

export const squashMergeOptionsSchema = z.object({
  mergeBaseBranch: z.string().min(1),
  autoArchiveOnSuccess: z.boolean(),
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
    options: commitOptionsSchema,
  }),
  environmentActionTargetSchema.extend({
    action: z.literal("squash_merge"),
    options: squashMergeOptionsSchema,
  }),
]);
export type EnvironmentActionRequest = z.infer<typeof environmentActionRequestSchema>;

export const commitActionResponseSchema = z.object({
  ok: z.literal(true),
  action: z.literal("commit"),
  message: z.string(),
  autoArchived: z.boolean(),
  commitSha: z.string().min(1),
  commitSubject: z.string().min(1),
});
export type CommitActionResponse = z.infer<typeof commitActionResponseSchema>;

export const squashMergeActionResponseSchema = z.object({
  ok: z.literal(true),
  action: z.literal("squash_merge"),
  merged: z.boolean(),
  message: z.string(),
  autoArchived: z.boolean(),
  commitSha: z.string().min(1),
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
  contextWindowUsage: threadContextWindowUsageSchema.optional(),
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
  voiceTranscriptionEnabled: z.boolean(),
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
