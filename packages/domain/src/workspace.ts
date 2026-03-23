import { z } from "zod";

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
