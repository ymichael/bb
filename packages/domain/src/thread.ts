import { z } from "zod";
import { environmentWorkspaceDisplayKindSchema } from "./environment.js";
import {
  promptInputSchema,
  permissionModeSchema,
  reasoningLevelSchema,
  serviceTierSchema,
} from "./shared-types.js";

export const threadStatusValues = [
  "created",
  "provisioning",
  "idle",
  "active",
  "error",
] as const;
export const threadStatusSchema = z.enum(threadStatusValues);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;

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
]);
export type WorkspaceFileStatusKind = z.infer<typeof workspaceFileStatusKindSchema>;

export const workspaceFileStatusSchema = z.object({
  path: z.string(),
  status: workspaceFileStatusKindSchema,
});
export type WorkspaceFileStatus = z.infer<typeof workspaceFileStatusSchema>;

export const workspaceCommitSummarySchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  authorName: z.string(),
  authoredAt: z.number(),
});
export type WorkspaceCommitSummary = z.infer<typeof workspaceCommitSummarySchema>;

export const workspaceWorkingTreeSchema = z.object({
  hasUncommittedChanges: z.boolean(),
  state: workspaceStateSchema,
  changedFiles: z.number(),
  insertions: z.number(),
  deletions: z.number(),
  files: z.array(workspaceFileStatusSchema),
});
export type WorkspaceWorkingTree = z.infer<typeof workspaceWorkingTreeSchema>;

export const workspaceBranchSchema = z.object({
  currentBranch: z.string().nullable(),
  defaultBranch: z.string(),
});
export type WorkspaceBranch = z.infer<typeof workspaceBranchSchema>;

export const workspaceMergeBaseSchema = z.object({
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
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Thread = z.infer<typeof threadSchema>;

export const threadListEntrySchema = threadSchema.extend({
  hasPendingInteraction: z.boolean(),
  environmentWorkspaceDisplayKind: environmentWorkspaceDisplayKindSchema,
});
export type ThreadListEntry = z.infer<typeof threadListEntrySchema>;
