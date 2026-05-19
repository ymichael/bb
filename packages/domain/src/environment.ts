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

export const environmentCleanupModeValues = ["safe"] as const;
export const environmentCleanupModeSchema = z.enum(
  environmentCleanupModeValues,
);
export type EnvironmentCleanupMode = z.infer<
  typeof environmentCleanupModeSchema
>;

export const WORKSPACE_PROVISION_TYPES = [
  "unmanaged",
  "managed-worktree",
] as const;
export const workspaceProvisionTypeSchema = z.enum(WORKSPACE_PROVISION_TYPES);
export type WorkspaceProvisionType = z.infer<
  typeof workspaceProvisionTypeSchema
>;

export const environmentWorkspaceDisplayKindValues = [
  "managed-worktree",
  "unmanaged-worktree",
  "other",
] as const;
export const environmentWorkspaceDisplayKindSchema = z.enum(
  environmentWorkspaceDisplayKindValues,
);
export type EnvironmentWorkspaceDisplayKind = z.infer<
  typeof environmentWorkspaceDisplayKindSchema
>;

export interface ResolveEnvironmentWorkspaceDisplayKindArgs {
  environment: {
    isWorktree: boolean | null;
    workspaceProvisionType: WorkspaceProvisionType | null;
  };
}

export function resolveEnvironmentWorkspaceDisplayKind({
  environment,
}: ResolveEnvironmentWorkspaceDisplayKindArgs): EnvironmentWorkspaceDisplayKind {
  if (environment.workspaceProvisionType === "managed-worktree") {
    return "managed-worktree";
  }

  if (environment.isWorktree === true) {
    return "unmanaged-worktree";
  }

  return "other";
}

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
export type DiscoveredWorkspaceProperties = z.infer<
  typeof discoveredWorkspacePropertiesSchema
>;

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
  baseBranch: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  mergeBaseBranch: z.string().nullable(),
  cleanupRequestedAt: z.number().nullable(),
  cleanupMode: environmentCleanupModeSchema.nullable(),
  status: environmentStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Environment = z.infer<typeof environmentSchema>;

export type EnvironmentMergeBaseBranchSource = Pick<
  Environment,
  "baseBranch" | "defaultBranch" | "mergeBaseBranch"
>;

export function resolveEnvironmentMergeBaseBranch(
  environment: EnvironmentMergeBaseBranchSource | null | undefined,
): string | undefined {
  return (
    environment?.mergeBaseBranch ??
    environment?.baseBranch ??
    environment?.defaultBranch ??
    undefined
  );
}
