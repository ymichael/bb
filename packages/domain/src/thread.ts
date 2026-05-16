import { z } from "zod";
import { environmentWorkspaceDisplayKindSchema } from "./environment.js";
import {
  promptInputSchema,
  permissionModeSchema,
  reasoningLevelSchema,
  serviceTierSchema,
} from "./shared-types.js";
import { threadStatusSchema, threadStatusValues } from "./thread-status.js";
export { threadStatusSchema, threadStatusValues } from "./thread-status.js";
export type { ThreadStatus } from "./thread-status.js";

export const threadRuntimeDisplayStatusValues = [
  ...threadStatusValues,
  "host-reconnecting",
  "waiting-for-host",
] as const;
export const threadRuntimeDisplayStatusSchema = z.enum(
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

export const threadTypeValues = ["standard", "manager"] as const;
export const threadTypeSchema = z.enum(threadTypeValues);
export type ThreadType = z.infer<typeof threadTypeSchema>;

export const workspaceStateValues = [
  "clean",
  "untracked",
  "dirty_uncommitted",
  "committed_unmerged",
  "dirty_and_committed_unmerged",
] as const;
export const workspaceStateSchema = z.enum(workspaceStateValues);
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;

export const workspaceFileStatusKindSchema = z.enum([
  "M",
  "A",
  "D",
  "R",
  "C",
  "U",
  "??",
  /**
   * Fallback for git status letters we don't recognize. Kept distinct from
   * "M" so UI and consumers can surface the ambiguity rather than silently
   * mislabeling the change.
   */
  "?",
]);
export type WorkspaceFileStatusKind = z.infer<
  typeof workspaceFileStatusKindSchema
>;

export const workspaceFileStatusSchema = z.object({
  path: z.string(),
  status: workspaceFileStatusKindSchema,
  /**
   * Per-file line counts from `git diff --numstat`. Null when the count is
   * unknown — binary files (numstat reports `-`) and untracked files (numstat
   * does not include them).
   */
  insertions: z.number().nullable(),
  deletions: z.number().nullable(),
});
export type WorkspaceFileStatus = z.infer<typeof workspaceFileStatusSchema>;

export const workspaceCommitSummarySchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  authorName: z.string(),
  authoredAt: z.number(),
});
export type WorkspaceCommitSummary = z.infer<
  typeof workspaceCommitSummarySchema
>;

/**
 * Fields shared by any surface that reports a set of changed files plus the
 * line-level totals across them. Both `workspaceWorkingTreeSchema` and
 * `workspaceMergeBaseSchema` embed these so their file list and stats stay
 * in lockstep.
 */
export const workspaceChangeStatsSchema = z.object({
  insertions: z.number(),
  deletions: z.number(),
  files: z.array(workspaceFileStatusSchema),
});
export type WorkspaceChangeStats = z.infer<typeof workspaceChangeStatsSchema>;

export const workspaceWorkingTreeSchema = workspaceChangeStatsSchema.extend({
  hasUncommittedChanges: z.boolean(),
  state: workspaceStateSchema,
});
export type WorkspaceWorkingTree = z.infer<typeof workspaceWorkingTreeSchema>;

export const workspaceBranchSchema = z.object({
  currentBranch: z.string().nullable(),
  defaultBranch: z.string(),
});
export type WorkspaceBranch = z.infer<typeof workspaceBranchSchema>;

/**
 * Stats and file list are relative to the merge-base-to-HEAD range
 * (committed, unmerged) via `workspaceChangeStatsSchema`.
 */
export const workspaceMergeBaseSchema = workspaceChangeStatsSchema.extend({
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
  branch: workspaceBranchSchema,
  mergeBase: workspaceMergeBaseSchema.nullable(),
});
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;

export const threadQueuedMessageSchema = z.object({
  id: z.string(),
  content: z.array(promptInputSchema).min(1),
  model: z.string().min(1),
  reasoningLevel: reasoningLevelSchema,
  permissionMode: permissionModeSchema,
  serviceTier: serviceTierSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ThreadQueuedMessage = z.infer<typeof threadQueuedMessageSchema>;

export const threadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  automationId: z.string().nullable(),
  providerId: z.string(),
  type: threadTypeSchema,
  title: z.string().nullable(),
  titleFallback: z.string().nullable(),
  status: threadStatusSchema,
  parentThreadId: z.string().nullable(),
  archivedAt: z.number().nullable(),
  stopRequestedAt: z.number().nullable(),
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

export const threadListEntrySchema = threadWithRuntimeSchema.extend({
  hasPendingInteraction: z.boolean(),
  environmentHostId: z.string().nullable(),
  environmentBranchName: z.string().nullable(),
  environmentWorkspaceDisplayKind: environmentWorkspaceDisplayKindSchema,
});
export type ThreadListEntry = z.infer<typeof threadListEntrySchema>;
