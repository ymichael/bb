import { z } from "zod";
import { cloudAuthProviderIdSchema } from "@bb/agent-providers";
import {
  availableModelSchema,
  getProjectPathValidationMessage,
  normalizeProjectPathInput,
  activeThinkingSchema,
  featureFlagsSchema,
  environmentSchema,
  hostSchema,
  pendingInteractionResolutionSchema,
  pendingInteractionSchema,
  promptHistoryEntrySchema,
  projectSchema,
  projectSourceSchema,
  promptInputSchema,
  permissionModeSchema,
  providerInfoSchema,
  reasoningLevelSchema,
  resolvedThreadExecutionOptionsSchema,
  sandboxBackendInfoSchema,
  serviceTierSchema,
  threadListEntrySchema,
  threadTimelinePendingTodosSchema,
  threadTypeSchema,
  threadWithRuntimeSchema,
  threadQueuedMessageSchema,
  workspaceStatusSchema,
} from "@bb/domain";
import { apiErrorSchema } from "./errors.js";
import { timelineRowSchema } from "./thread-timeline.js";

export const sendMessageModeSchema = z.enum(["auto", "start", "steer"]);
export type SendMessageMode = z.infer<typeof sendMessageModeSchema>;

export const AUTOMATION_NAME_MAX_LENGTH = 200;
export const FILE_LIST_QUERY_MAX_LENGTH = 256;
export const SCHEDULE_CRON_MAX_LENGTH = 100;
export const SCHEDULE_NAME_MAX_LENGTH = 200;
export const SCHEDULE_TIMEZONE_MAX_LENGTH = 100;

interface IncludeQueryValidationArgs {
  allowedValues: readonly string[];
  value: string;
}

function isCommaSeparatedIncludeQueryValue(
  args: IncludeQueryValidationArgs,
): boolean {
  const requestedValues = args.value.split(",");
  return requestedValues.every(
    (value) => value.length > 0 && args.allowedValues.includes(value),
  );
}

export const threadContextWindowUsageSchema = z.object({
  usedTokens: z.number(),
  modelContextWindow: z.number(),
  estimated: z.boolean(),
});
export type ThreadContextWindowUsage = z.infer<
  typeof threadContextWindowUsageSchema
>;

// --- Thread creation: environment + workspace discriminated unions ---

const gitBranchForbiddenCharacterPattern = /[\u0000-\u001f\u007f\\:~^?*\[]/u;
const gitBranchWhitespacePattern = /[ \t]/u;
const gitBranchReservedNames = new Set([
  "AUTO_MERGE",
  "BISECT_HEAD",
  "CHERRY_PICK_HEAD",
  "FETCH_HEAD",
  "HEAD",
  "MERGE_HEAD",
  "ORIG_HEAD",
  "REVERT_HEAD",
]);
type GitBranchNameCandidate = string;

// Pure contract-boundary mirror of git's branch/refname restrictions. Keep
// this close to `git check-ref-format --branch` without shelling out.
function isValidGitBranchName(name: GitBranchNameCandidate) {
  const components = name.split("/");
  return (
    name.length > 0 &&
    name.trim().length > 0 &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    name !== "@" &&
    !gitBranchReservedNames.has(name) &&
    !gitBranchForbiddenCharacterPattern.test(name) &&
    !gitBranchWhitespacePattern.test(name) &&
    !name.includes("..") &&
    !name.includes("@{") &&
    !name.includes("//") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    components.every(
      (component) =>
        component.length > 0 &&
        !component.startsWith(".") &&
        !component.endsWith(".lock"),
    )
  );
}

export const gitBranchNameSchema = z
  .string()
  .refine(isValidGitBranchName, { message: "Invalid git branch name" });
export type GitBranchName = z.infer<typeof gitBranchNameSchema>;

/**
 * Pre-thread checkout intent for an unmanaged workspace. Omitting this from
 * the workspace request means "don't touch HEAD"; including it asks the
 * daemon to switch to (or create) the named branch before the thread starts.
 */
export const unmanagedBranchSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), name: gitBranchNameSchema }),
  z.object({ kind: z.literal("new") }),
]);
export type UnmanagedBranchSpec = z.infer<typeof unmanagedBranchSpecSchema>;

export const unmanagedWorkspaceSchema = z.object({
  type: z.literal("unmanaged"),
  path: z.string().min(1).nullable(),
  /**
   * If set, the daemon checks out this branch in the unmanaged workspace
   * before the thread starts. `existing` switches to a named branch; `new`
   * asks the server to mint a thread-scoped branch name and create it.
   */
  branch: unmanagedBranchSpecSchema.optional(),
});

/**
 * Identifies the base branch a managed worktree/clone should be created from.
 * `named` carries an explicit branch name; `default` defers to the source's
 * default branch (resolved server-side so the daemon always receives a real
 * branch name).
 */
export const baseBranchSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("named"), name: gitBranchNameSchema }),
  z.object({ kind: z.literal("default") }),
]);
export type BaseBranchSpec = z.infer<typeof baseBranchSpecSchema>;

export const managedWorktreeWorkspaceSchema = z.object({
  type: z.literal("managed-worktree"),
  /** Branch the new worktree should be based on. */
  baseBranch: baseBranchSpecSchema,
});

export const managedCloneWorkspaceSchema = z.object({
  type: z.literal("managed-clone"),
  /** Branch the new clone should check out from. */
  baseBranch: baseBranchSpecSchema,
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
  /** Branch the new sandbox clone should be checked out at. */
  baseBranch: baseBranchSpecSchema,
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
  origin: threadCreateOriginSchema,
  title: z.string().min(1).optional(),
  input: z.array(promptInputSchema).min(1),
  model: z.string().min(1).optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  environment: environmentArgsSchema,
  parentThreadId: z.string().min(1).optional(),
});
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;

const automationThreadRequestSchema = z.object({
  // Automations must choose provider/model explicitly; omitted execution
  // options may still inherit scheduled-thread defaults.
  providerId: z.string().min(1),
  title: z.string().min(1).optional(),
  input: z.array(promptInputSchema).min(1),
  model: z.string().min(1),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  environment: environmentArgsSchema,
  parentThreadId: z.string().min(1).optional(),
});
export type AutomationThreadRequest = z.infer<
  typeof automationThreadRequestSchema
>;

export const automationNameSchema = z
  .string()
  .min(1)
  .max(AUTOMATION_NAME_MAX_LENGTH);
export const scheduleCronSchema = z
  .string()
  .min(1)
  .max(SCHEDULE_CRON_MAX_LENGTH);
export const scheduleNameSchema = z
  .string()
  .min(1)
  .max(SCHEDULE_NAME_MAX_LENGTH);
export const scheduleTimezoneSchema = z
  .string()
  .min(1)
  .max(SCHEDULE_TIMEZONE_MAX_LENGTH);
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
export type CreateAutomationRequest = z.infer<
  typeof createAutomationRequestSchema
>;

export const updateAutomationEnabledRequestSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();
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
export type UpdateAutomationRequest = z.infer<
  typeof updateAutomationRequestSchema
>;

export const sendMessageRequestSchema = z.object({
  input: z.array(promptInputSchema).min(1),
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  mode: sendMessageModeSchema,
  senderThreadId: z.string().min(1).optional(),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const createDraftRequestSchema = z.object({
  input: z.array(promptInputSchema).min(1),
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
});
export type CreateDraftRequest = z.infer<typeof createDraftRequestSchema>;

export const sendDraftRequestSchema = z.object({});
export type SendDraftRequest = z.infer<typeof sendDraftRequestSchema>;

export const sendDraftResponseSchema = z.object({
  ok: z.literal(true),
  queuedMessage: threadQueuedMessageSchema,
});
export type SendDraftResponse = z.infer<typeof sendDraftResponseSchema>;

export const threadListResponseSchema = z.array(threadListEntrySchema);
export type ThreadListResponse = z.infer<typeof threadListResponseSchema>;

export const threadResponseSchema = threadWithRuntimeSchema;
export type ThreadResponse = z.infer<typeof threadResponseSchema>;

export const threadIncludeOptionSchema = z.enum(["environment", "host"]);
export type ThreadIncludeOption = z.infer<typeof threadIncludeOptionSchema>;

export const threadGetQuerySchema = z.object({
  include: z
    .string()
    .min(1)
    .refine(
      (value) =>
        isCommaSeparatedIncludeQueryValue({
          allowedValues: threadIncludeOptionSchema.options,
          value,
        }),
      { message: "Invalid include" },
    )
    .optional(),
});
export type ThreadGetQuery = z.infer<typeof threadGetQuerySchema>;

export const threadWithIncludesResponseSchema = threadResponseSchema.extend({
  environment: environmentSchema.nullable().optional(),
  host: hostSchema.nullable().optional(),
});
export type ThreadWithIncludesResponse = z.infer<
  typeof threadWithIncludesResponseSchema
>;

export const threadPendingInteractionsResponseSchema = z.array(
  pendingInteractionSchema,
);
export type ThreadPendingInteractionsResponse = z.infer<
  typeof threadPendingInteractionsResponseSchema
>;

export const resolvePendingInteractionRequestSchema =
  pendingInteractionResolutionSchema;
export type ResolvePendingInteractionRequest = z.infer<
  typeof resolvePendingInteractionRequestSchema
>;

export const threadDraftListResponseSchema = z.array(threadQueuedMessageSchema);
export type ThreadDraftListResponse = z.infer<
  typeof threadDraftListResponseSchema
>;

export const threadAssignedChildSummaryResponseSchema = z.object({
  nonDeletedAssignedChildCount: z.number().int().nonnegative(),
});
export type ThreadAssignedChildSummaryResponse = z.infer<
  typeof threadAssignedChildSummaryResponseSchema
>;

export const archiveThreadRequestSchema = z.object({
  force: z.boolean(),
  managerChildThreadsConfirmed: z.boolean(),
});
export type ArchiveThreadRequest = z.infer<typeof archiveThreadRequestSchema>;

export const deleteThreadRequestSchema = z.object({
  managerChildThreadsConfirmed: z.boolean(),
});
export type DeleteThreadRequest = z.infer<typeof deleteThreadRequestSchema>;

export const updateThreadRequestSchema = z
  .object({
    title: z.string().min(1).nullable(),
    parentThreadId: z.string().min(1).nullable(),
  })
  .partial()
  .refine(
    (value) => value.title !== undefined || value.parentThreadId !== undefined,
    "At least one field must be provided",
  );
export type UpdateThreadRequest = z.infer<typeof updateThreadRequestSchema>;

export const updateEnvironmentRequestSchema = z.object({
  mergeBaseBranch: z.string().min(1).nullable(),
});
export type UpdateEnvironmentRequest = z.infer<
  typeof updateEnvironmentRequestSchema
>;

const localProjectPathRequestSchema = z
  .string()
  .trim()
  .min(1)
  .transform(normalizeProjectPathInput)
  .superRefine((path, ctx) => {
    const validationMessage = getProjectPathValidationMessage(path);
    if (!validationMessage) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: validationMessage,
    });
  });

const createLocalPathProjectSourceRequestSchema = z
  .object({
    hostId: z.string().min(1),
    type: z.literal("local_path"),
    path: localProjectPathRequestSchema,
  })
  .strict();

const createGitHubRepoProjectSourceRequestSchema = z
  .object({
    type: z.literal("github_repo"),
    repoUrl: z.string().url(),
  })
  .strict();

export const createProjectSourceRequestSchema = z.discriminatedUnion("type", [
  createLocalPathProjectSourceRequestSchema,
  createGitHubRepoProjectSourceRequestSchema,
]);
export type CreateProjectSourceRequest = z.infer<
  typeof createProjectSourceRequestSchema
>;

export const createProjectRequestSchema = z.object({
  name: z.string().min(1),
  source: createProjectSourceRequestSchema,
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

const persistentHostJoinRequestSchema = z
  .object({
    hostId: z.string().min(1).optional(),
    hostType: z.literal("persistent").optional(),
  })
  .strict();

const localHostJoinRequestSchema = z
  .object({
    hostId: z.string().min(1).optional(),
    hostType: z.literal("persistent"),
    joinMode: z.literal("local"),
  })
  .strict();

const ephemeralHostJoinRequestSchema = z
  .object({
    externalId: z.string().min(1),
    hostId: z.string().min(1).optional(),
    hostType: z.literal("ephemeral"),
    provider: z.string().min(1),
  })
  .strict();

export const createHostJoinRequestSchema = z.union([
  localHostJoinRequestSchema,
  persistentHostJoinRequestSchema,
  ephemeralHostJoinRequestSchema,
]);
export type CreateHostJoinRequest = z.infer<typeof createHostJoinRequestSchema>;

export const createHostJoinResponseSchema = z.object({
  expiresAt: z.number().int().positive(),
  hostId: z.string().min(1),
  joinCode: z.string().min(1),
  joinCommand: z.string().min(1),
});
export type CreateHostJoinResponse = z.infer<
  typeof createHostJoinResponseSchema
>;

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
export type ManagerEnvironmentArgs = z.infer<
  typeof managerEnvironmentArgsSchema
>;

export const createManagerThreadRequestSchema = z.object({
  name: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  origin: threadCreateOriginSchema,
  model: z.string().min(1).optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  environment: managerEnvironmentArgsSchema,
});
export type CreateManagerThreadRequest = z.infer<
  typeof createManagerThreadRequestSchema
>;

export const projectListIncludeOptionSchema = z.enum(["threads"]);
export type ProjectListIncludeOption = z.infer<
  typeof projectListIncludeOptionSchema
>;

export const projectListQuerySchema = z.object({
  include: z
    .string()
    .min(1)
    .refine(
      (value) =>
        isCommaSeparatedIncludeQueryValue({
          allowedValues: projectListIncludeOptionSchema.options,
          value,
        }),
      { message: "Invalid include" },
    )
    .optional(),
});
export type ProjectListQuery = z.infer<typeof projectListQuerySchema>;

export const projectFilesQuerySchema = z.object({
  query: z.string().min(1).max(FILE_LIST_QUERY_MAX_LENGTH).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  /**
   * Required + nullable. Pass an environment id to scope the file list to that
   * environment's workspace (e.g. a worktree); pass `null` to use the project's
   * default source. Encoded as the empty string on the wire because URL query
   * params can't represent JSON null directly.
   */
  environmentId: z.preprocess(
    (value) => (value === "" ? null : value),
    z.string().min(1).nullable(),
  ),
});
export type ProjectFilesQuery = z.infer<typeof projectFilesQuerySchema>;

export const projectBranchesQuerySchema = z.object({
  hostId: z.string().min(1),
});
export type ProjectBranchesQuery = z.infer<typeof projectBranchesQuerySchema>;

export const projectBranchesResponseSchema = z.object({
  branches: z.array(z.string()),
  /**
   * For host sources, the HEAD of the primary checkout. For GitHub sources,
   * null (no working tree). Use this when the env will operate on the
   * checkout in place (i.e., `host:local` threads).
   */
  current: z.string().nullable(),
  /**
   * The repo's tracked default branch. Use this when the env will create a
   * fresh workspace from the repo's default (host worktree or sandbox).
   */
  defaultBranch: z.string().nullable(),
});
export type ProjectBranchesResponse = z.infer<
  typeof projectBranchesResponseSchema
>;

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

export const promptHistoryQuerySchema = z
  .object({
    limit: z.string().regex(/^\d+$/),
  })
  .partial();
export type PromptHistoryQuery = z.infer<typeof promptHistoryQuerySchema>;

export const promptHistoryResponseSchema = z.array(promptHistoryEntrySchema);
export type PromptHistoryResponse = z.infer<typeof promptHistoryResponseSchema>;

export const systemExecutionOptionsResponseSchema = z.object({
  providers: z.array(providerInfoSchema),
  /** Active models offered as fresh picker choices. */
  models: z.array(availableModelSchema),
  /**
   * Retired/legacy models the picker no longer offers but that may still be
   * the user's stored selection. Clients prepend the matching entry when a
   * stored model isn't in `models`, so deprecation doesn't silently rewrite
   * the user's choice.
   */
  selectedOnlyModels: z.array(availableModelSchema),
});
export type SystemExecutionOptionsResponse = z.infer<
  typeof systemExecutionOptionsResponseSchema
>;

export const threadComposerBootstrapResponseSchema = z.object({
  defaultExecutionOptions: resolvedThreadExecutionOptionsSchema.nullable(),
  drafts: threadDraftListResponseSchema,
  executionOptions: systemExecutionOptionsResponseSchema,
  pendingInteractions: threadPendingInteractionsResponseSchema,
  promptHistory: promptHistoryResponseSchema,
});
export type ThreadComposerBootstrapResponse = z.infer<
  typeof threadComposerBootstrapResponseSchema
>;

const mergeBaseBranchQuerySchema = z
  .string("A merge base branch is required")
  .min(1, "A merge base branch is required");

export const environmentStatusQuerySchema = z.object({
  mergeBaseBranch: mergeBaseBranchQuerySchema.optional(),
});
export type EnvironmentStatusQuery = z.infer<
  typeof environmentStatusQuerySchema
>;

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

const diffFileSideSchema = z.enum(["old", "new"]);

const mergeBaseRefQuerySchema = z.string().regex(/^[0-9a-f]{4,40}$/iu);

/**
 * Query for fetching a single file's contents at one side of a diff target.
 * Used by the diff card to populate `<FileDiff>`'s `oldFile`/`newFile` props
 * so `@pierre/diffs` can render expand-context buttons between hunks.
 *
 * For `branch_committed` / `all`, callers pass the resolved merge-base SHA
 * (`mergeBaseRef`, surfaced by `workspace.diff`) rather than the branch name
 * — the diff itself was computed against that SHA, so reading the old side
 * from the same SHA keeps the file content aligned with the hunk line
 * numbers. Reading from the branch tip is wrong whenever the branch has
 * moved past the merge-base since the file existed there.
 */
export const environmentDiffFileQuerySchema = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("uncommitted"),
    path: z.string().min(1),
    side: diffFileSideSchema,
  }),
  z.object({
    target: z.literal("branch_committed"),
    mergeBaseRef: mergeBaseRefQuerySchema,
    path: z.string().min(1),
    side: diffFileSideSchema,
  }),
  z.object({
    target: z.literal("all"),
    mergeBaseRef: mergeBaseRefQuerySchema,
    path: z.string().min(1),
    side: diffFileSideSchema,
  }),
  z.object({
    target: z.literal("commit"),
    sha: z.string().regex(/^[0-9a-f]{4,40}$/iu),
    path: z.string().min(1),
    side: diffFileSideSchema,
  }),
]);
export type EnvironmentDiffFileQuery = z.infer<
  typeof environmentDiffFileQuerySchema
>;

export const environmentDiffFileResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
  contentEncoding: z.enum(["base64", "utf8"]),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
});
export type EnvironmentDiffFileResponse = z.infer<
  typeof environmentDiffFileResponseSchema
>;

export const threadListQuerySchema = z.object({
  projectId: z.string().min(1),
  type: threadTypeSchema.optional(),
  parentThreadId: z.string().min(1).optional(),
  archived: z.enum(["true", "false"]).optional(),
  /** Filter by parent thread presence: "true" → managed (has parent), "false" → unmanaged. */
  managed: z.enum(["true", "false"]).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});
export type ThreadListQuery = z.infer<typeof threadListQuerySchema>;

export const managerTimelineViewSchema = z.enum(["conversation", "standard"]);
export type ManagerTimelineView = z.infer<typeof managerTimelineViewSchema>;

export const timelinePaginationCursorSchema = z
  .object({
    anchorSeq: z.number().int().positive(),
    anchorId: z.string().min(1),
  })
  .strict();
export type TimelinePaginationCursor = z.infer<
  typeof timelinePaginationCursorSchema
>;

export const timelinePageMetadataSchema = z
  .object({
    kind: z.enum(["latest", "older"]),
    segmentLimit: z.number().int().positive(),
    returnedSegmentCount: z.number().int().nonnegative(),
    hasOlderRows: z.boolean(),
    olderCursor: timelinePaginationCursorSchema.nullable(),
  })
  .strict();
export type TimelinePageMetadata = z.infer<typeof timelinePageMetadataSchema>;

export const threadTimelineQuerySchema = z
  .object({
    managerTimelineView: managerTimelineViewSchema,
    includeNestedRows: z.enum(["true", "false"]),
    segmentLimit: z.string().regex(/^\d+$/),
    beforeAnchorSeq: z.string().regex(/^[1-9]\d*$/),
    beforeAnchorId: z.string().min(1),
    /**
     * When `"true"`, the response omits row generation and returns
     * `rows: []` with the tail-only fields (`activeThinking`, `pendingTodos`,
     * `contextWindowUsage`) populated normally. Used by the CLI to read
     * tail state without paying for the full row payload on every
     * `bb status` invocation. Implies `latest` page semantics.
     */
    summaryOnly: z.enum(["true", "false"]),
  })
  .partial()
  .superRefine((query, context) => {
    const hasBeforeAnchorSeq = query.beforeAnchorSeq !== undefined;
    const hasBeforeAnchorId = query.beforeAnchorId !== undefined;

    if (hasBeforeAnchorSeq === hasBeforeAnchorId) {
      return;
    }

    context.addIssue({
      code: "custom",
      message: "beforeAnchorSeq and beforeAnchorId must be provided together",
      path: hasBeforeAnchorSeq ? ["beforeAnchorId"] : ["beforeAnchorSeq"],
    });
  });
export type ThreadTimelineQuery = z.infer<typeof threadTimelineQuerySchema>;

export const timelineTurnSummaryDetailsQuerySchema = z.object({
  turnId: z.string().min(1),
  sourceSeqStart: z.string().regex(/^\d+$/),
  sourceSeqEnd: z.string().regex(/^\d+$/),
  managerTimelineView: managerTimelineViewSchema.optional(),
});
export type TimelineTurnSummaryDetailsQuery = z.infer<
  typeof timelineTurnSummaryDetailsQuerySchema
>;

export const threadEventsQuerySchema = z
  .object({
    afterSeq: z.string().regex(/^\d+$/),
    limit: z.string().regex(/^\d+$/),
  })
  .partial();
export type ThreadEventsQuery = z.infer<typeof threadEventsQuerySchema>;

export const threadEventWaitQuerySchema = z.object({
  type: z.string().min(1),
  afterSeq: z.string().regex(/^\d+$/).optional(),
  waitMs: z.string().regex(/^\d+$/).optional(),
});
export type ThreadEventWaitQuery = z.infer<typeof threadEventWaitQuerySchema>;

export const threadStorageFilesQuerySchema = z
  .object({
    query: z.string().min(1).max(FILE_LIST_QUERY_MAX_LENGTH),
    limit: z.string().regex(/^\d+$/),
  })
  .partial();
export type ThreadStorageFilesQuery = z.infer<
  typeof threadStorageFilesQuerySchema
>;

export const threadStorageContentQuerySchema = z.object({
  path: z.string().min(1),
});
export type ThreadStorageContentQuery = z.infer<
  typeof threadStorageContentQuerySchema
>;

export const systemExecutionOptionsQuerySchema = z
  .object({
    providerId: z.string().min(1),
    hostId: z.string().min(1),
    environmentId: z.string().min(1),
  })
  .partial();
export type SystemExecutionOptionsQuery = z.infer<
  typeof systemExecutionOptionsQuerySchema
>;

export const systemProvidersQuerySchema = z
  .object({
    hostId: z.string().min(1),
    environmentId: z.string().min(1),
  })
  .partial();
export type SystemProvidersQuery = z.infer<typeof systemProvidersQuerySchema>;

export const cloudAuthConnectionStatusSchema = z.enum([
  "connected",
  "invalid",
  "missing",
]);
export type CloudAuthConnectionStatus = z.infer<
  typeof cloudAuthConnectionStatusSchema
>;

export const cloudAuthAttemptStatusSchema = z.enum([
  "completed",
  "expired",
  "failed",
  "pending",
]);
export type CloudAuthAttemptStatus = z.infer<
  typeof cloudAuthAttemptStatusSchema
>;

export const cloudAuthConnectionSchema = z
  .object({
    providerId: cloudAuthProviderIdSchema,
    displayName: z.string().min(1),
    status: cloudAuthConnectionStatusSchema,
    label: z.string().nullable(),
    connectedAt: z.number().nullable(),
    expiresAt: z.number().nullable(),
    lastRefreshedAt: z.number().nullable(),
    errorMessage: z.string().nullable(),
  })
  .strict();
export type CloudAuthConnection = z.infer<typeof cloudAuthConnectionSchema>;

export const cloudAuthSettingsResponseSchema = z
  .object({
    connections: z.array(cloudAuthConnectionSchema),
  })
  .strict();
export type CloudAuthSettingsResponse = z.infer<
  typeof cloudAuthSettingsResponseSchema
>;

export const cloudAuthConnectRequestSchema = z
  .object({
    appOrigin: z.string().url(),
  })
  .strict();
export type CloudAuthConnectRequest = z.infer<
  typeof cloudAuthConnectRequestSchema
>;

export const cloudAuthConnectResponseSchema = z
  .object({
    attemptId: z.string().min(1),
    authorizationUrl: z.string().url(),
  })
  .strict();
export type CloudAuthConnectResponse = z.infer<
  typeof cloudAuthConnectResponseSchema
>;

export const cloudAuthAttemptResponseSchema = z
  .object({
    attemptId: z.string().min(1),
    providerId: cloudAuthProviderIdSchema,
    status: cloudAuthAttemptStatusSchema,
    errorMessage: z.string().nullable(),
  })
  .strict();
export type CloudAuthAttemptResponse = z.infer<
  typeof cloudAuthAttemptResponseSchema
>;

export const sandboxEnvVarNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export type SandboxEnvVarName = z.infer<typeof sandboxEnvVarNameSchema>;

export const sandboxEnvVarSchema = z
  .object({
    name: sandboxEnvVarNameSchema,
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type SandboxEnvVar = z.infer<typeof sandboxEnvVarSchema>;

export const sandboxEnvVarsResponseSchema = z
  .object({
    envVars: z.array(sandboxEnvVarSchema),
  })
  .strict();
export type SandboxEnvVarsResponse = z.infer<
  typeof sandboxEnvVarsResponseSchema
>;

export const upsertSandboxEnvVarRequestSchema = z
  .object({
    name: sandboxEnvVarNameSchema,
    value: z.string().max(16_384),
  })
  .strict();
export type UpsertSandboxEnvVarRequest = z.infer<
  typeof upsertSandboxEnvVarRequestSchema
>;

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

const updateLocalPathProjectSourceRequestSchema = z
  .object({
    type: z.literal("local_path"),
    path: localProjectPathRequestSchema.optional(),
    isDefault: z.literal(true).optional(),
  })
  .strict();

const updateGitHubRepoProjectSourceRequestSchema = z
  .object({
    type: z.literal("github_repo"),
    repoUrl: z.string().url().optional(),
    isDefault: z.literal(true).optional(),
  })
  .strict();

export const updateProjectSourceRequestSchema = z
  .discriminatedUnion("type", [
    updateLocalPathProjectSourceRequestSchema,
    updateGitHubRepoProjectSourceRequestSchema,
  ])
  .refine(
    (value) =>
      ("path" in value && value.path !== undefined) ||
      ("repoUrl" in value && value.repoUrl !== undefined) ||
      value.isDefault !== undefined,
    "At least one field besides type must be provided",
  );
export type UpdateProjectSourceRequest = z.infer<
  typeof updateProjectSourceRequestSchema
>;

export const environmentActionTypeSchema = z.enum(["commit", "squash_merge"]);
export type EnvironmentActionType = z.infer<typeof environmentActionTypeSchema>;

export const squashMergeOptionsSchema = z
  .object({
    mergeBaseBranch: z.string().min(1),
  })
  .strict();
export type SquashMergeOptions = z.infer<typeof squashMergeOptionsSchema>;

export const environmentActionRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("commit"),
    })
    .strict(),
  z
    .object({
      action: z.literal("squash_merge"),
      options: squashMergeOptionsSchema,
    })
    .strict(),
]);
export type EnvironmentActionRequest = z.infer<
  typeof environmentActionRequestSchema
>;

export const commitActionResponseSchema = z.object({
  ok: z.literal(true),
  action: z.literal("commit"),
  message: z.string().min(1),
  commitSha: z.string().min(1),
  commitSubject: z.string().min(1),
});
export type CommitActionResponse = z.infer<typeof commitActionResponseSchema>;

export const squashMergeActionResponseSchema = z.object({
  ok: z.literal(true),
  action: z.literal("squash_merge"),
  merged: z.boolean(),
  message: z.string().min(1),
  commitSha: z.string().min(1),
  commitSubject: z.string().min(1),
});
export type SquashMergeActionResponse = z.infer<
  typeof squashMergeActionResponseSchema
>;

export const environmentActionResponseSchema = z.discriminatedUnion("action", [
  commitActionResponseSchema,
  squashMergeActionResponseSchema,
]);
export type EnvironmentActionResponse = z.infer<
  typeof environmentActionResponseSchema
>;

export const environmentActionFailureDetailsSchema = z.discriminatedUnion(
  "kind",
  [
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
  ],
);
export type EnvironmentActionFailureDetails = z.infer<
  typeof environmentActionFailureDetailsSchema
>;

export const environmentActionApiErrorSchema = apiErrorSchema.extend({
  details: environmentActionFailureDetailsSchema.optional(),
});
export type EnvironmentActionApiError = z.infer<
  typeof environmentActionApiErrorSchema
>;

export const timelineTurnSummaryDetailsRequestSchema = z.object({
  turnId: z.string().min(1),
  sourceSeqStart: z.number().int().nonnegative(),
  sourceSeqEnd: z.number().int().nonnegative(),
  managerTimelineView: managerTimelineViewSchema.optional(),
});
export type TimelineTurnSummaryDetailsRequest = z.infer<
  typeof timelineTurnSummaryDetailsRequestSchema
>;

export const timelineTurnSummaryDetailsResponseSchema = z.object({
  rows: z.array(timelineRowSchema),
});
export type TimelineTurnSummaryDetailsResponse = z.infer<
  typeof timelineTurnSummaryDetailsResponseSchema
>;

export const threadTimelineResponseSchema = z.object({
  rows: z.array(timelineRowSchema),
  activeThinking: activeThinkingSchema.nullable(),
  pendingTodos: threadTimelinePendingTodosSchema.nullable(),
  contextWindowUsage: threadContextWindowUsageSchema.optional(),
  timelinePage: timelinePageMetadataSchema,
});
export type ThreadTimelineResponse = z.infer<
  typeof threadTimelineResponseSchema
>;

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
export type SystemVoiceTranscriptionResponse = z.infer<
  typeof systemVoiceTranscriptionResponseSchema
>;

export const workspaceFileSchema = z.object({
  path: z.string(),
  name: z.string(),
});
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

export const workspaceFileListResponseSchema = z.object({
  files: z.array(workspaceFileSchema),
  truncated: z.boolean(),
});
export type WorkspaceFileListResponse = z.infer<
  typeof workspaceFileListResponseSchema
>;

export const threadStorageFileListResponseSchema =
  workspaceFileListResponseSchema.extend({
    /**
     * Absolute on-host path to the thread's storage directory. Useful for
     * clients that need to construct a full path for filesystem operations
     * (e.g. opening a storage file in the user's editor). The path is on
     * the thread's host machine, so it is only usable when that host is the
     * user's local machine.
     */
    storageRootPath: z.string(),
  });
export type ThreadStorageFileListResponse = z.infer<
  typeof threadStorageFileListResponseSchema
>;

export const projectResponseSchema = projectSchema.extend({
  sources: z.array(projectSourceSchema),
});
export type ProjectResponse = z.infer<typeof projectResponseSchema>;

export const projectWithThreadsResponseSchema = projectResponseSchema.extend({
  threads: z.array(threadListEntrySchema),
});
export type ProjectWithThreadsResponse = z.infer<
  typeof projectWithThreadsResponseSchema
>;

export const systemConfigResponseSchema = z.object({
  featureFlags: featureFlagsSchema,
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
  workspace: workspaceStatusSchema.nullable(), // null for non-git environments
});

export const uploadedPromptAttachmentSchema = z.object({
  type: z.enum(["localImage", "localFile"]),
  path: z.string(),
  name: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number(),
});
export type UploadedPromptAttachment = z.infer<
  typeof uploadedPromptAttachmentSchema
>;
export type EnvironmentStatusResponse = z.infer<
  typeof environmentStatusResponseSchema
>;

export {
  replayCaptureDetailSchema,
  replayCaptureListResponseSchema,
  replayCaptureHostSummarySchema,
  replayCaptureSummarySchema,
  replayRunRequestSchema,
  replayRunResponseSchema,
  replaySpeedSchema,
} from "@bb/replay-capture/schema";
export type {
  ReplayCaptureDetail,
  ReplayCaptureHostSummary,
  ReplayCaptureListResponse,
  ReplayCaptureSummary,
  ReplayRunRequest,
  ReplayRunResponse,
  ReplayRunSpeed,
} from "@bb/replay-capture/schema";
