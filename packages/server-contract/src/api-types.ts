import { z } from "zod";
import {
  isAbsoluteProjectPath,
  hostTypeSchema,
  normalizeProjectPathInput,
  projectSchema,
  projectSourceSchema,
  promptInputSchema,
  reasoningLevelSchema,
  sandboxBackendInfoSchema,
  sandboxModeSchema,
  serviceTierSchema,
  threadTypeSchema,
  timelineRowSchema,
  threadQueuedMessageSchema,
  viewMessageSchema,
  workspaceStatusSchema,
} from "@bb/domain";
import { apiErrorSchema } from "./errors.js";

export const sendMessageModeSchema = z.enum(["auto", "start", "steer"]);
export type SendMessageMode = z.infer<typeof sendMessageModeSchema>;

export const AUTOMATION_NAME_MAX_LENGTH = 200;
export const SCHEDULE_CRON_MAX_LENGTH = 100;
export const SCHEDULE_NAME_MAX_LENGTH = 200;
export const SCHEDULE_TIMEZONE_MAX_LENGTH = 100;

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

export const threadCreateOriginSchema = z.enum(["app", "cli"]);
export type ThreadCreateOrigin = z.infer<typeof threadCreateOriginSchema>;

export const createThreadRequestSchema = z.object({
  projectId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  origin: threadCreateOriginSchema.optional(),
  title: z.string().min(1).optional(),
  input: z.array(promptInputSchema).min(1),
  model: z.string().min(1).optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
  environment: environmentArgsSchema,
  parentThreadId: z.string().min(1).optional(),
});
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;

const automationThreadRequestSchema = z.object({
  // Automations stay self-contained instead of inheriting project defaults.
  providerId: z.string().min(1),
  title: z.string().min(1).optional(),
  input: z.array(promptInputSchema).min(1),
  model: z.string().min(1),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
  environment: environmentArgsSchema,
  parentThreadId: z.string().min(1).optional(),
});
export type AutomationThreadRequest = z.infer<
  typeof automationThreadRequestSchema
>;

export const automationNameSchema = z.string().min(1).max(AUTOMATION_NAME_MAX_LENGTH);
export const scheduleCronSchema = z.string().min(1).max(SCHEDULE_CRON_MAX_LENGTH);
export const scheduleNameSchema = z.string().min(1).max(SCHEDULE_NAME_MAX_LENGTH);
export const scheduleTimezoneSchema = z.string().min(1).max(SCHEDULE_TIMEZONE_MAX_LENGTH);
export const automationScheduleTriggerSchema = z.object({
  triggerType: z.literal("schedule"),
  cron: scheduleCronSchema,
  timezone: scheduleTimezoneSchema,
});
export type AutomationScheduleTrigger = z.infer<
  typeof automationScheduleTriggerSchema
>;

export const scheduledThreadAutomationActionSchema = z.object({
  actionType: z.literal("scheduled-thread"),
  threadRequest: automationThreadRequestSchema,
});
export type ScheduledThreadAutomationAction = z.infer<
  typeof scheduledThreadAutomationActionSchema
>;

export const automationTriggerSchema = z.discriminatedUnion("triggerType", [
  automationScheduleTriggerSchema,
]);
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;

export const automationActionSchema = z.discriminatedUnion("actionType", [
  scheduledThreadAutomationActionSchema,
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;

export const automationValidationIssueSchema = z.string().min(1);
export const automationValidationSchema = z.object({
  isValid: z.boolean(),
  validationIssues: z.array(automationValidationIssueSchema),
});
export type AutomationValidation = z.infer<typeof automationValidationSchema>;

export const automationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: automationNameSchema,
  enabled: z.boolean(),
  trigger: automationTriggerSchema,
  action: automationActionSchema,
  autoArchive: z.boolean(),
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  runCount: z.number().int().nonnegative(),
  isValid: z.boolean(),
  validationIssues: z.array(automationValidationIssueSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Automation = z.infer<typeof automationSchema>;

export const createAutomationRequestSchema = z.object({
  name: automationNameSchema,
  enabled: z.boolean().optional(),
  trigger: automationTriggerSchema,
  action: automationActionSchema,
  autoArchive: z.boolean().optional(),
});
export type CreateAutomationRequest = z.infer<typeof createAutomationRequestSchema>;

export const updateAutomationEnabledRequestSchema = z.object({
  enabled: z.boolean(),
}).strict();
export type UpdateAutomationEnabledRequest = z.infer<
  typeof updateAutomationEnabledRequestSchema
>;

export const updateAutomationConfigRequestSchema = z
  .object({
    name: automationNameSchema,
    trigger: automationTriggerSchema,
    action: automationActionSchema,
    autoArchive: z.boolean(),
  })
  .partial()
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.trigger !== undefined ||
      value.action !== undefined ||
      value.autoArchive !== undefined,
    "At least one field must be provided",
  );
export type UpdateAutomationConfigRequest = z.infer<
  typeof updateAutomationConfigRequestSchema
>;

export const updateAutomationRequestSchema = z.union([
  updateAutomationEnabledRequestSchema,
  updateAutomationConfigRequestSchema,
]);
export type UpdateAutomationRequest = z.infer<typeof updateAutomationRequestSchema>;

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

export const threadDraftListResponseSchema = z.array(threadQueuedMessageSchema);
export type ThreadDraftListResponse = z.infer<typeof threadDraftListResponseSchema>;

export const archiveThreadRequestSchema = z.object({
  force: z.boolean(),
});
export type ArchiveThreadRequest = z.infer<typeof archiveThreadRequestSchema>;

export const updateThreadRequestSchema = z
  .object({
    title: z.string().min(1).nullable(),
    parentThreadId: z.string().min(1).nullable(),
  })
  .partial()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.parentThreadId !== undefined,
    "At least one field must be provided",
  );
export type UpdateThreadRequest = z.infer<typeof updateThreadRequestSchema>;

export const updateEnvironmentRequestSchema = z.object({
  mergeBaseBranch: z.string().min(1).nullable(),
});
export type UpdateEnvironmentRequest = z.infer<typeof updateEnvironmentRequestSchema>;

const localProjectPathRequestSchema = z
  .string()
  .trim()
  .min(1)
  .transform(normalizeProjectPathInput)
  .refine(
    (path) => isAbsoluteProjectPath(path),
    "Project path must be an absolute path",
  );

const createLocalPathProjectSourceRequestSchema = z.object({
  hostId: z.string().min(1),
  type: z.literal("local_path"),
  path: localProjectPathRequestSchema,
}).strict();

const createGitHubRepoProjectSourceRequestSchema = z.object({
  type: z.literal("github_repo"),
  repoUrl: z.string().url(),
}).strict();

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

export const createHostJoinRequestSchema = z.object({
  hostId: z.string().min(1).optional(),
  hostType: hostTypeSchema,
}).strict();
export type CreateHostJoinRequest = z.infer<typeof createHostJoinRequestSchema>;

export const createHostJoinResponseSchema = z.object({
  expiresAt: z.number().int().positive(),
  hostId: z.string().min(1),
  joinCode: z.string().min(1),
  joinCommand: z.string().min(1),
});
export type CreateHostJoinResponse = z.infer<typeof createHostJoinResponseSchema>;

export const updateHostRequestSchema = z
  .object({
    name: z.string().min(1),
  })
  .partial()
  .refine(
    (value) => value.name !== undefined,
    "At least one field must be provided",
  );
export type UpdateHostRequest = z.infer<typeof updateHostRequestSchema>;

export const managerHostEnvironmentSchema = z.object({
  type: z.literal("host"),
  hostId: z.string().min(1),
});

export const managerEnvironmentArgsSchema = z.discriminatedUnion("type", [
  managerHostEnvironmentSchema,
]);
export type ManagerEnvironmentArgs = z.infer<typeof managerEnvironmentArgsSchema>;

export const createManagerThreadRequestSchema = z.object({
  name: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  origin: threadCreateOriginSchema.optional(),
  model: z.string().min(1).optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
  environment: managerEnvironmentArgsSchema,
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

export const projectDefaultExecutionOptionsQuerySchema = z.object({
  threadType: threadTypeSchema,
});
export type ProjectDefaultExecutionOptionsQuery = z.infer<
  typeof projectDefaultExecutionOptionsQuerySchema
>;

const mergeBaseBranchQuerySchema = z
  .string({ required_error: "A merge base branch is required" })
  .min(1, "A merge base branch is required");

export const environmentStatusQuerySchema = z.object({
  mergeBaseBranch: mergeBaseBranchQuerySchema.optional(),
});
export type EnvironmentStatusQuery = z.infer<typeof environmentStatusQuerySchema>;

export const environmentDiffQuerySchema = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("uncommitted"),
  }),
  z.object({
    target: z.literal("branch_committed"),
    mergeBaseBranch: mergeBaseBranchQuerySchema,
  }),
  z.object({
    target: z.literal("all"),
    mergeBaseBranch: mergeBaseBranchQuerySchema,
  }),
  z.object({
    target: z.literal("commit"),
    sha: z.string().regex(/^[0-9a-f]{4,40}$/iu),
  }),
]);
export type EnvironmentDiffQuery = z.infer<typeof environmentDiffQuerySchema>;

export const threadListQuerySchema = z.object({
  projectId: z.string().min(1),
  type: threadTypeSchema.optional(),
  parentThreadId: z.string().min(1).optional(),
  archived: z.enum(["true", "false"]).optional(),
});
export type ThreadListQuery = z.infer<typeof threadListQuerySchema>;

export const threadTimelineQuerySchema = z.object({
  includeManagerDebugView: z.enum(["true", "false"]),
  includeToolGroupMessages: z.enum(["true", "false"]),
}).partial();
export type ThreadTimelineQuery = z.infer<typeof threadTimelineQuerySchema>;

export const timelineToolDetailsQuerySchema = z.object({
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

export const threadEventWaitQuerySchema = z.object({
  type: z.string().min(1),
  afterSeq: z.string().regex(/^\d+$/).optional(),
  waitMs: z.string().regex(/^\d+$/).optional(),
});
export type ThreadEventWaitQuery = z.infer<typeof threadEventWaitQuerySchema>;

export const threadStorageFilesQuerySchema = z.object({
  query: z.string().min(1),
  limit: z.string().regex(/^\d+$/),
}).partial();
export type ThreadStorageFilesQuery = z.infer<
  typeof threadStorageFilesQuerySchema
>;

export const threadStorageContentQuerySchema = z.object({
  path: z.string().min(1),
});
export type ThreadStorageContentQuery = z.infer<
  typeof threadStorageContentQuerySchema
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
  path: localProjectPathRequestSchema.optional(),
  isDefault: z.literal(true).optional(),
}).strict();

const updateGitHubRepoProjectSourceRequestSchema = z.object({
  type: z.literal("github_repo"),
  repoUrl: z.string().url().optional(),
  isDefault: z.literal(true).optional(),
}).strict();

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

export const squashMergeOptionsSchema = z.object({
  mergeBaseBranch: z.string().min(1),
}).strict();
export type SquashMergeOptions = z.infer<typeof squashMergeOptionsSchema>;

export const environmentActionRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("promote"),
  }).strict(),
  z.object({
    action: z.literal("demote"),
  }).strict(),
  z.object({
    action: z.literal("commit"),
  }).strict(),
  z.object({
    action: z.literal("squash_merge"),
    options: squashMergeOptionsSchema,
  }).strict(),
]);
export type EnvironmentActionRequest = z.infer<typeof environmentActionRequestSchema>;

export const commitActionResponseSchema = z.object({
  ok: z.literal(true),
  action: z.literal("commit"),
  message: z.string(),
  commitSha: z.string().min(1),
  commitSubject: z.string().min(1),
});
export type CommitActionResponse = z.infer<typeof commitActionResponseSchema>;

export const squashMergeActionResponseSchema = z.object({
  ok: z.literal(true),
  action: z.literal("squash_merge"),
  merged: z.boolean(),
  message: z.string(),
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

// SystemSandboxBackendInfo is the same shape as SandboxBackendInfo from domain.
// Re-export with the API-facing name to match API naming conventions.
export { sandboxBackendInfoSchema as systemSandboxBackendInfoSchema } from "@bb/domain";
export type { SandboxBackendInfo as SystemSandboxBackendInfo } from "@bb/domain";

export const systemVoiceTranscriptionResponseSchema = z.object({
  text: z.string(),
});
export type SystemVoiceTranscriptionResponse = z.infer<typeof systemVoiceTranscriptionResponseSchema>;

export const workspaceFileSchema = z.object({
  path: z.string(),
  name: z.string(),
});
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

export const workspaceFileListResponseSchema = z.object({
  files: z.array(workspaceFileSchema),
  truncated: z.boolean(),
});
export type WorkspaceFileListResponse = z.infer<typeof workspaceFileListResponseSchema>;

export const projectResponseSchema = projectSchema.extend({
  sources: z.array(projectSourceSchema),
});
export type ProjectResponse = z.infer<typeof projectResponseSchema>;

export const systemConfigResponseSchema = z.object({
  githubConnected: z.boolean(),
  hostDaemonPort: z.number().nullable(),
  sandboxHostSupported: z.boolean(),
  voiceTranscriptionEnabled: z.boolean(),
});
export type SystemConfigResponse = z.infer<typeof systemConfigResponseSchema>;

export const systemSandboxBackendsResponseSchema = z.array(
  sandboxBackendInfoSchema,
);
export type SystemSandboxBackendsResponse = z.infer<
  typeof systemSandboxBackendsResponseSchema
>;

export const githubRepoInfoSchema = z.object({
  fullName: z.string(),
  htmlUrl: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
});
export type GithubRepoInfo = z.infer<typeof githubRepoInfoSchema>;

export const githubReposQuerySchema = z.object({
  q: z.string().max(256).optional(),
});
export type GithubReposQuery = z.infer<typeof githubReposQuerySchema>;

export const environmentStatusResponseSchema = z.object({
  workspace: workspaceStatusSchema.nullable(),  // null if daemon unreachable or non-git env
});

export const uploadedPromptAttachmentSchema = z.object({
  type: z.enum(["localImage", "localFile"]),
  path: z.string(),
  name: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number(),
});
export type UploadedPromptAttachment = z.infer<typeof uploadedPromptAttachmentSchema>;
export type EnvironmentStatusResponse = z.infer<typeof environmentStatusResponseSchema>;
