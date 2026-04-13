import { z } from "zod";
import type { HostType } from "./host.js";

export const environmentStatusValues = [
  "provisioning",
  "ready",
  "error",
  "destroying",
  "destroyed",
] as const;
export const environmentStatusSchema = z.enum(environmentStatusValues);
export type EnvironmentStatus = z.infer<typeof environmentStatusSchema>;

export const environmentCleanupModeValues = [
  "force",
  "safe",
] as const;
export const environmentCleanupModeSchema = z.enum(environmentCleanupModeValues);
export type EnvironmentCleanupMode = z.infer<
  typeof environmentCleanupModeSchema
>;

export const WORKSPACE_PROVISION_TYPES = [
  "unmanaged",
  "managed-worktree",
  "managed-clone",
] as const;
export const workspaceProvisionTypeSchema = z.enum(WORKSPACE_PROVISION_TYPES);
export type WorkspaceProvisionType = z.infer<typeof workspaceProvisionTypeSchema>;

export const environmentWorkspaceDisplayKindValues = [
  "sandbox",
  "git-worktree",
  "primary-checkout",
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
    isGitRepo: boolean | null;
    isWorktree: boolean | null;
  };
  hostType: HostType | null;
}

export function resolveEnvironmentWorkspaceDisplayKind({
  environment,
  hostType,
}: ResolveEnvironmentWorkspaceDisplayKindArgs): EnvironmentWorkspaceDisplayKind {
  if (hostType === "ephemeral") {
    return "sandbox";
  }

  if (environment.isWorktree === true) {
    return "git-worktree";
  }

  if (environment.isGitRepo === true) {
    return "primary-checkout";
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
  cleanupRequestedAt: z.number().nullable(),
  cleanupMode: environmentCleanupModeSchema.nullable(),
  status: environmentStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Environment = z.infer<typeof environmentSchema>;
