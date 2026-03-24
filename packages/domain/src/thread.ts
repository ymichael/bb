import { z } from "zod";
import {
  promptInputSchema,
  reasoningLevelSchema,
  sandboxModeSchema,
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
  "deleted",
  "dirty_uncommitted",
  "committed_unmerged",
  "dirty_and_committed_unmerged",
] as const;
export const workspaceStateSchema = z.enum(workspaceStateValues);
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;

export const workspaceFileChangeSchema = z.object({
  path: z.string(),
  status: z.string(),
});
export type WorkspaceFileChange = z.infer<typeof workspaceFileChangeSchema>;

export const workspaceStatusSchema = z.object({
  state: workspaceStateSchema,
  changedFiles: z.number(),
  insertions: z.number(),
  deletions: z.number(),
  workspaceChangedFiles: z.number(),
  workspaceInsertions: z.number(),
  workspaceDeletions: z.number(),
  hasUncommittedChanges: z.boolean(),
  hasCommittedUnmergedChanges: z.boolean(),
  aheadCount: z.number(),
  behindCount: z.number(),
  currentBranch: z.string().optional(),
  defaultBranch: z.string().optional(),
  mergeBaseBranch: z.string().optional(),
  mergeBaseBranches: z.array(z.string()).optional(),
  baseRef: z.string().optional(),
  files: z.array(workspaceFileChangeSchema).optional(),
});
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;

export const threadQueuedMessageSchema = z.object({
  id: z.string(),
  content: z.array(promptInputSchema),
  mode: z.enum(["auto", "start", "steer"]),
  reasoningLevel: reasoningLevelSchema,
  sandboxMode: sandboxModeSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ThreadQueuedMessage = z.infer<typeof threadQueuedMessageSchema>;

export const threadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  providerId: z.string(),
  type: threadTypeSchema,
  title: z.string().nullable(),
  status: threadStatusSchema,
  mergeBaseBranch: z.string().nullable(),
  parentThreadId: z.string().nullable(),
  archivedAt: z.number().nullable(),
  lastReadAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Thread = z.infer<typeof threadSchema>;
