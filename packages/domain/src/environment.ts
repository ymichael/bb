import { jsonValueSchema } from "./json-value.js";
import { z } from "zod";

export const environmentMachineSelectionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("existing"), hostId: z.string().min(1) }),
  z.object({
    type: z.literal("new"),
    machineProviderId: z.string().min(1),
    inputs: jsonValueSchema.nullable(),
  }),
]);
export type EnvironmentMachineSelection = z.infer<
  typeof environmentMachineSelectionSchema
>;

export const environmentProviderSelectionSchema = z.object({
  machine: environmentMachineSelectionSchema,
  inputs: jsonValueSchema.nullable(),
});
export type EnvironmentProviderSelection = z.infer<
  typeof environmentProviderSelectionSchema
>;
export const environmentStatusValues = [
  "provisioning",
  "ready",
  "error",
  "destroyed",
] as const;
export const environmentStatusSchema = z.enum(environmentStatusValues);
export type EnvironmentStatus = z.infer<typeof environmentStatusSchema>;

const WORKSPACE_PROVISION_TYPES = [
  "unmanaged",
  "managed-worktree",
  "personal",
] as const;
export const workspaceProvisionTypeSchema = z.enum(WORKSPACE_PROVISION_TYPES);
export type WorkspaceProvisionType = z.infer<
  typeof workspaceProvisionTypeSchema
>;

const environmentWorkspaceDisplayKindValues = [
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

export const environmentLifecycleSchema = z.object({
  phase: z.enum(["active", "retiring", "teardown", "destroyed"]),
  retireAt: z.number().nullable(),
  teardown: z
    .object({
      status: z.enum(["running", "failed", "removed"]),
      attempt: z.number().int().nonnegative(),
      message: z.string().optional(),
    })
    .nullable(),
});
export type EnvironmentLifecycle = z.infer<typeof environmentLifecycleSchema>;

export const environmentSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  projectId: z.string(),
  hostId: z.string(),
  path: z.string().nullable(),
  isGitRepo: z.boolean(),
  isWorktree: z.boolean(),
  branchName: z.string().nullable(),
  baseBranch: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  mergeBaseBranch: z.string().nullable(),
  status: environmentStatusSchema,
  environmentProviderId: z.string().nullable(),
  lifecycle: environmentLifecycleSchema,
  environmentProviderSelection: environmentProviderSelectionSchema.nullable(),
  environmentProviderInstanceKey: z.string().nullable(),
  managed: z.boolean(),
  workspaceProvisionType: workspaceProvisionTypeSchema.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Environment = z.infer<typeof environmentSchema>;

type EnvironmentMergeBaseBranchSource = Pick<
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
