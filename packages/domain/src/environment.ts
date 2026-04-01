import { z } from "zod";

export const environmentStatusValues = [
  "provisioning",
  "ready",
  "error",
  "destroying",
  "destroyed",
] as const;
export const environmentStatusSchema = z.enum(environmentStatusValues);
export type EnvironmentStatus = z.infer<typeof environmentStatusSchema>;

export const WORKSPACE_PROVISION_TYPES = [
  "unmanaged",
  "managed-worktree",
  "managed-clone",
] as const;
export const workspaceProvisionTypeSchema = z.enum(WORKSPACE_PROVISION_TYPES);
export type WorkspaceProvisionType = z.infer<typeof workspaceProvisionTypeSchema>;

/**
 * Properties discovered about a workspace during provisioning.
 * Used by the provision command result and to populate the environment record.
 */
export const discoveredWorkspacePropertiesSchema = z.object({
  path: z.string().min(1),
  isGitRepo: z.boolean(),
  isWorktree: z.boolean(),
  branchName: z.string().nullable(),
  defaultBranch: z.string().nullable(),
});
export type DiscoveredWorkspaceProperties = z.infer<typeof discoveredWorkspacePropertiesSchema>;

export const environmentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  hostId: z.string(),
  path: z.string().nullable(),
  managed: z.boolean(),
  isGitRepo: z.boolean(),
  isWorktree: z.boolean(),
  workspaceProvisionType: workspaceProvisionTypeSchema,
  branchName: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  mergeBaseBranch: z.string().nullable(),
  status: environmentStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Environment = z.infer<typeof environmentSchema>;
