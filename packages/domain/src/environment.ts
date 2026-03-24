import { z } from "zod";

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
  hostId: z.string(),
  path: z.string().nullable(),
  managed: z.boolean(),
  isGitRepo: z.boolean(),
  isWorktree: z.boolean(),
  workspaceProvisionType: z.enum(["unmanaged", "managed-worktree", "managed-clone"]).nullable(),
  branchName: z.string().nullable(),
  status: environmentStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Environment = z.infer<typeof environmentSchema>;
