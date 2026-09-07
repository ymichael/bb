import { z } from "zod";
import { environmentWorkspaceDisplayKindSchema } from "./environment.js";
import { gitCheckoutRefSchema } from "./git-checkout.js";
import {
  queuedMessageFailureReasonSchema,
  queuedMessagePayloadSchema,
  queuedMessageWaitingOnSchema,
} from "./queued-message.js";
import {
  promptInputSchema,
  permissionModeSchema,
  reasoningLevelSchema,
  serviceTierSchema,
} from "./shared-types.js";
import { threadStatusSchema, threadStatusValues } from "./thread-status.js";
import { threadOriginKindSchema } from "./thread-origin-kind.js";
import { threadVisibilitySchema } from "./thread-visibility.js";
export { threadStatusSchema, threadStatusValues } from "./thread-status.js";
export type { ThreadStatus } from "./thread-status.js";
export {
  threadOriginKindSchema,
  threadOriginKindValues,
} from "./thread-origin-kind.js";
export type { ThreadOriginKind } from "./thread-origin-kind.js";

/**
 * The three additions to {@link threadStatusValues} are display-only: they
 * refine `active`/`idle` with host and workspace facts the durable status does
 * not record.
 *
 * A never-started thread needs no such refinement — `pending` is a real thread
 * status now, so it travels to the client as itself. It used to arrive as a
 * separate `held` display status, derived from an `idle` thread holding a live
 * dispatch hold; that derivation and the holds behind it are both gone.
 */
const threadRuntimeDisplayStatusValues = [
  ...threadStatusValues,
  "provisioning",
  "host-reconnecting",
  "waiting-for-host",
] as const;
const threadRuntimeDisplayStatusSchema = z.enum(
  threadRuntimeDisplayStatusValues,
);
export type ThreadRuntimeDisplayStatus = z.infer<
  typeof threadRuntimeDisplayStatusSchema
>;

export const threadRuntimeStateSchema = z.object({
  displayStatus: threadRuntimeDisplayStatusSchema,
  hostReconnectGraceExpiresAt: z.number().nullable(),
});
export type ThreadRuntimeState = z.infer<typeof threadRuntimeStateSchema>;

export const threadActivityStateSchema = z.object({
  activeWorkflowCount: z.number().int().nonnegative(),
  activeBackgroundAgentCount: z.number().int().nonnegative(),
  activeBackgroundCommandCount: z.number().int().nonnegative(),
  activePlanModeCount: z.number().int().nonnegative(),
  activeGoalCount: z.number().int().nonnegative(),
});
export type ThreadActivityState = z.infer<typeof threadActivityStateSchema>;

const workspaceStateValues = [
  "clean",
  "untracked",
  "dirty_uncommitted",
  "committed_unmerged",
  "dirty_and_committed_unmerged",
] as const;
const workspaceStateSchema = z.enum(workspaceStateValues);

const workspaceFileStatusKindSchema = z.enum([
  "M",
  "A",
  "D",
  "R",
  "C",
  "U",
  "??",
  "?",
]);
export type WorkspaceFileStatusKind = z.infer<
  typeof workspaceFileStatusKindSchema
>;

const workspaceFileStatusSchema = z.object({
  path: z.string(),
  status: workspaceFileStatusKindSchema,
  insertions: z.number().nullable(),
  deletions: z.number().nullable(),
});
export type WorkspaceFileStatus = z.infer<typeof workspaceFileStatusSchema>;

const workspaceCommitSummarySchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  authorName: z.string(),
  authoredAt: z.number(),
});
export type WorkspaceCommitSummary = z.infer<
  typeof workspaceCommitSummarySchema
>;

const workspaceChangeStatsSchema = z.object({
  insertions: z.number(),
  deletions: z.number(),
  lineStatsComplete: z.boolean(),
  files: z.array(workspaceFileStatusSchema),
});
export type WorkspaceChangeStats = z.infer<typeof workspaceChangeStatsSchema>;

const workspaceWorkingTreeSchema = workspaceChangeStatsSchema.extend({
  hasUncommittedChanges: z.boolean(),
  state: workspaceStateSchema,
});
export type WorkspaceWorkingTree = z.infer<typeof workspaceWorkingTreeSchema>;

const workspaceBranchSchema = z.object({
  currentBranch: z.string().nullable(),
  defaultBranch: z.string(),
});

const workspaceMergeBaseSchema = workspaceChangeStatsSchema.extend({
  mergeBaseBranch: z.string(),
  baseRef: z.string().nullable(),
  aheadCount: z.number(),
  behindCount: z.number(),
  hasCommittedUnmergedChanges: z.boolean(),
  commits: z.array(workspaceCommitSummarySchema),
});
export type WorkspaceMergeBase = z.infer<typeof workspaceMergeBaseSchema>;

export const workspaceStatusSchema = z.object({
  workingTree: workspaceWorkingTreeSchema,
  checkout: gitCheckoutRefSchema,
  branch: workspaceBranchSchema,
  mergeBase: workspaceMergeBaseSchema.nullable(),
});
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;

const gitHostPullRequestCheckStatusSchema = z.enum([
  "queued",
  "in_progress",
  "completed",
  "unknown",
]);
export type GitHostPullRequestCheckStatus = z.infer<
  typeof gitHostPullRequestCheckStatusSchema
>;

const gitHostPullRequestCheckConclusionSchema = z.enum([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "neutral",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
  "unknown",
]);
export type GitHostPullRequestCheckConclusion = z.infer<
  typeof gitHostPullRequestCheckConclusionSchema
>;

const gitHostPullRequestCheckSchema = z
  .object({
    name: z.string().min(1),
    status: gitHostPullRequestCheckStatusSchema,
    conclusion: gitHostPullRequestCheckConclusionSchema.nullable(),
    url: z.string().url().nullable(),
    startedAt: z.string().datetime().nullable(),
  })
  .strict();
export type GitHostPullRequestCheck = z.infer<
  typeof gitHostPullRequestCheckSchema
>;

const gitHostPullRequestReviewDecisionSchema = z.enum([
  "APPROVED",
  "CHANGES_REQUESTED",
  "REVIEW_REQUIRED",
]);
export type GitHostPullRequestReviewDecision = z.infer<
  typeof gitHostPullRequestReviewDecisionSchema
>;

const gitHostPullRequestMergeStateStatusSchema = z.enum([
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
]);
export type GitHostPullRequestMergeStateStatus = z.infer<
  typeof gitHostPullRequestMergeStateStatusSchema
>;

const gitHostPullRequestMergeableSchema = z.enum([
  "CONFLICTING",
  "MERGEABLE",
  "UNKNOWN",
]);
export type GitHostPullRequestMergeable = z.infer<
  typeof gitHostPullRequestMergeableSchema
>;

export const gitHostPullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    url: z.string().url(),
    isDraft: z.boolean(),
    baseRefName: z.string(),
    headRefName: z.string(),
    updatedAt: z.string().datetime(),
    checks: z.array(gitHostPullRequestCheckSchema),
    reviewDecision: gitHostPullRequestReviewDecisionSchema.nullable(),
    reviewRequestCount: z.number().int().nonnegative(),
    mergeStateStatus: gitHostPullRequestMergeStateStatusSchema.nullable(),
    mergeable: gitHostPullRequestMergeableSchema.nullable(),
  })
  .strict();
export type GitHostPullRequest = z.infer<typeof gitHostPullRequestSchema>;

const pullRequestStateSchema = z.enum(["draft", "open", "merged", "closed"]);
export type PullRequestState = z.infer<typeof pullRequestStateSchema>;

const threadPullRequestChecksStateSchema = z.enum([
  "passing",
  "failing",
  "pending",
  "no_checks",
  "unknown",
]);
export type ThreadPullRequestChecksState = z.infer<
  typeof threadPullRequestChecksStateSchema
>;

const threadPullRequestChecksSchema = z
  .object({
    state: threadPullRequestChecksStateSchema,
    totalCount: z.number().int().nonnegative(),
    passedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    pendingCount: z.number().int().nonnegative(),
  })
  .strict();
export type ThreadPullRequestChecks = z.infer<
  typeof threadPullRequestChecksSchema
>;

const threadPullRequestReviewStateSchema = z.enum([
  "approved",
  "changes_requested",
  "review_required",
  "review_requested",
  "none",
]);
export type ThreadPullRequestReviewState = z.infer<
  typeof threadPullRequestReviewStateSchema
>;

const threadPullRequestReviewSchema = z
  .object({
    state: threadPullRequestReviewStateSchema,
    reviewRequestCount: z.number().int().nonnegative(),
  })
  .strict();
export type ThreadPullRequestReview = z.infer<
  typeof threadPullRequestReviewSchema
>;

const threadPullRequestMergeabilityStateSchema = z.enum([
  "mergeable",
  "conflicts",
  "blocked",
  "draft",
  "unknown",
]);
export type ThreadPullRequestMergeabilityState = z.infer<
  typeof threadPullRequestMergeabilityStateSchema
>;

const threadPullRequestMergeabilitySchema = z
  .object({
    state: threadPullRequestMergeabilityStateSchema,
    mergeStateStatus: gitHostPullRequestMergeStateStatusSchema.nullable(),
    mergeable: gitHostPullRequestMergeableSchema.nullable(),
  })
  .strict();
export type ThreadPullRequestMergeability = z.infer<
  typeof threadPullRequestMergeabilitySchema
>;

const threadPullRequestAttentionStateSchema = z.enum([
  "checks_failed",
  "checks_pending",
  "changes_requested",
  "review_requested",
  "conflicts",
  "blocked",
  "draft",
  "ready_to_merge",
  "merged",
  "closed",
  "none",
]);
export type ThreadPullRequestAttentionState = z.infer<
  typeof threadPullRequestAttentionStateSchema
>;

export const threadPullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    state: pullRequestStateSchema,
    url: z.string().url(),
    baseRefName: z.string(),
    headRefName: z.string(),
    updatedAt: z.string().datetime(),
    checks: threadPullRequestChecksSchema,
    review: threadPullRequestReviewSchema,
    mergeability: threadPullRequestMergeabilitySchema,
    attention: threadPullRequestAttentionStateSchema,
  })
  .strict();
export type ThreadPullRequest = z.infer<typeof threadPullRequestSchema>;

export const threadQueuedMessageSchema = z.object({
  id: z.string(),
  /**
   * The thread this row is waiting on. Redundant on the thread-scoped list
   * route that first served this DTO, and load-bearing everywhere else it is
   * now served: a `queue.*` plugin event and a cross-thread wait-holder query
   * both hand out rows with no surrounding thread to read it from.
   */
  threadId: z.string(),
  content: z.array(promptInputSchema).min(1),
  model: z.string().min(1),
  reasoningLevel: reasoningLevelSchema,
  permissionMode: permissionModeSchema,
  serviceTier: serviceTierSchema,
  groupWithNext: z.boolean(),
  /**
   * Epoch ms this row is scheduled to attempt dispatch, or null when it is
   * eligible as soon as its other waits clear.
   */
  sendAt: z.number().int().nonnegative().nullable(),
  /**
   * Why this row is queued, or null for a plain queued row that is simply
   * next in line behind the running turn. Null rather than a
   * `{ kind: "thread-busy" }` default because rows written before waits were
   * typed carry no reason at all, and inventing one for them would be a lie.
   */
  waitingOn: queuedMessageWaitingOnSchema.nullable(),
  /**
   * Why this row's last DRAIN attempt failed outright, or null when it has not
   * failed one — which is every row that has never been re-attempted, and
   * every row whose latest attempt merely queued again. An inline attempt
   * reports its failure to the sender that is still listening and never lands
   * here.
   *
   * Independent of `waitingOn`, not folded into it: the row is still waiting on
   * whatever it was waiting on, and writing a wait rewrites it wholesale, so a
   * failure stored there would not survive the next attempt.
   */
  failureReason: queuedMessageFailureReasonSchema.nullable(),
  payload: queuedMessagePayloadSchema,
  /**
   * Whether the sender may still rewrite this row's input. Not derivable from
   * `payload` alone: a `retry` row is never editable, and an `inline` row
   * stops being editable once the drain has claimed it — and the claim is
   * deliberately not part of this response, since it is drain bookkeeping and
   * not something a client should reason about. The server folds both into
   * this one answer.
   */
  editable: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ThreadQueuedMessage = z.infer<typeof threadQueuedMessageSchema>;

export const threadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  providerId: z.string(),
  title: z.string().nullable(),
  titleFallback: z.string().nullable(),
  sectionId: z.string().nullable(),
  status: threadStatusSchema,
  parentThreadId: z.string().nullable(),
  sourceThreadId: z.string().nullable(),
  originKind: threadOriginKindSchema.nullable(),
  originPluginId: z.string().nullable(),
  visibility: threadVisibilitySchema,
  archivedAt: z.number().nullable(),
  pinnedAt: z.number().nullable(),
  deletedAt: z.number().nullable(),
  lastReadAt: z.number().nullable(),
  latestAttentionAt: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Thread = z.infer<typeof threadSchema>;

export const threadWithRuntimeSchema = threadSchema.extend({
  runtime: threadRuntimeStateSchema,
});
export type ThreadWithRuntime = z.infer<typeof threadWithRuntimeSchema>;

/**
 * Whether a thread has work waiting on its queue, as a list row needs to know
 * it: not how many rows, but whether any are waiting and whether any of them
 * failed to go out.
 *
 * `failed` outranks `waiting` because a failure is the only one of the two a
 * reader has to act on — a waiting row will clear itself. Deliberately a
 * queue fact only: whether the thread is also running is the list row's
 * question, not the queue's, and the row's glyph precedence answers it.
 */
export const threadQueuedWorkValues = ["none", "waiting", "failed"] as const;
export const threadQueuedWorkSchema = z.enum(threadQueuedWorkValues);
export type ThreadQueuedWork = z.infer<typeof threadQueuedWorkSchema>;

export const threadListEntrySchema = threadWithRuntimeSchema.extend({
  activity: threadActivityStateSchema,
  queuedWork: threadQueuedWorkSchema,
  pinSortKey: z.string().nullable(),
  hasPendingInteraction: z.boolean(),
  environmentHostId: z.string().nullable(),
  environmentName: z.string().nullable(),
  environmentBranchName: z.string().nullable(),
  environmentWorkspaceDisplayKind: environmentWorkspaceDisplayKindSchema,
});
export type ThreadListEntry = z.infer<typeof threadListEntrySchema>;
