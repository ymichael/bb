import { z } from "zod";

export const environmentLocationValues = [
  "localhost",
  "docker",
  "remote",
] as const;
export const environmentLocationSchema = z.enum(environmentLocationValues);
export type EnvironmentLocation = z.infer<typeof environmentLocationSchema>;

export const environmentWorkspaceKindValues = [
  "primary_checkout",
  "worktree",
  "arbitrary_path",
] as const;
export const environmentWorkspaceKindSchema = z.enum(
  environmentWorkspaceKindValues,
);
export type EnvironmentWorkspaceKind = z.infer<
  typeof environmentWorkspaceKindSchema
>;

export const environmentCapabilityValues = [
  "host_filesystem",
  "isolated_workspace",
  "promote_primary_checkout",
  "demote_primary_checkout",
  "squash_merge",
] as const;
export const environmentCapabilitySchema = z.enum(
  environmentCapabilityValues,
);
export type EnvironmentCapability = z.infer<
  typeof environmentCapabilitySchema
>;

export const environmentDescriptorSchema = z.object({
  type: z.literal("path"),
  path: z.string(),
});
export type EnvironmentDescriptor = z.infer<
  typeof environmentDescriptorSchema
>;

export const environmentPropertiesSchema = z.object({
  provisioningSystemKind: z.string(),
  location: environmentLocationSchema,
  workspaceKind: environmentWorkspaceKindSchema,
});
export type EnvironmentProperties = z.infer<
  typeof environmentPropertiesSchema
>;

export const persistedEnvironmentRecordSchema = z.object({
  kind: z.string(),
  state: z.unknown(),
});
export type PersistedEnvironmentRecord = z.infer<
  typeof persistedEnvironmentRecordSchema
>;

export const environmentStatusValues = [
  "provisioning",
  "ready",
  "error",
  "destroying",
] as const;
export const environmentStatusSchema = z.enum(environmentStatusValues);
export type EnvironmentStatus = z.infer<typeof environmentStatusSchema>;

export const environmentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  hostId: z.string().optional(),
  path: z.string().optional(),
  descriptor: environmentDescriptorSchema.optional(),
  managed: z.boolean(),
  isGitRepo: z.boolean().optional(),
  branchName: z.string().optional(),
  provisionerId: z.string().optional(),
  provisionerState: z.unknown().optional(),
  status: environmentStatusSchema.optional(),
  properties: environmentPropertiesSchema.optional(),
  runtimeState: persistedEnvironmentRecordSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Environment = z.infer<typeof environmentSchema>;

// Compatibility alias while apps/cli still consume the old name.
export const environmentRecordSchema = environmentSchema;
export type EnvironmentRecord = Environment;

export const environmentCapabilitiesSchema = z.object({
  host_filesystem: z.boolean(),
  isolated_workspace: z.boolean(),
  promote_primary_checkout: z.boolean(),
  demote_primary_checkout: z.boolean(),
  squash_merge: z.boolean(),
});
export type EnvironmentCapabilities = z.infer<
  typeof environmentCapabilitiesSchema
>;
