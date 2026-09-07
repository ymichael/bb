import { z } from "zod";
import {
  BRANCH_LIST_QUERY_MAX_LENGTH,
  changedMessageLenientSchema,
  changedMessageSchema,
  gitBranchNameSchema,
} from "@bb/domain";
import type { GitBranchName } from "@bb/domain";

export {
  BRANCH_LIST_LIMIT_MAX,
  BRANCH_LIST_QUERY_MAX_LENGTH,
  FILE_LIST_LIMIT_MAX,
  FILE_LIST_QUERY_MAX_LENGTH,
} from "@bb/domain";

interface IncludeQueryValidationArgs {
  allowedValues: readonly string[];
  value: string;
}

export function isCommaSeparatedIncludeQueryValue(
  args: IncludeQueryValidationArgs,
): boolean {
  const requestedValues = args.value.split(",");
  return requestedValues.every(
    (value) => value.length > 0 && args.allowedValues.includes(value),
  );
}

export const threadContextWindowUsageSchema = z.object({
  usedTokens: z.number(),
  modelContextWindow: z.number(),
  estimated: z.boolean(),
});
export type ThreadContextWindowUsage = z.infer<
  typeof threadContextWindowUsageSchema
>;

export { gitBranchNameSchema };
export type { GitBranchName };

export const unmanagedBranchSpecSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("existing"),
      name: gitBranchNameSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("new"), baseBranch: gitBranchNameSchema })
    .strict(),
]);
export type UnmanagedBranchSpec = z.infer<typeof unmanagedBranchSpecSchema>;

export const unmanagedWorkspaceSchema = z.object({
  type: z.literal("unmanaged"),
  path: z.string().min(1).nullable(),
  branch: unmanagedBranchSpecSchema.optional(),
});

export const baseBranchSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("named"), name: gitBranchNameSchema }),
  z.object({ kind: z.literal("default") }),
]);
export type BaseBranchSpec = z.infer<typeof baseBranchSpecSchema>;

export const managedWorktreeWorkspaceSchema = z.object({
  type: z.literal("managed-worktree"),
  baseBranch: baseBranchSpecSchema,
});

export const personalWorkspaceSchema = z.object({
  type: z.literal("personal"),
});

export const workspaceArgsSchema = z.discriminatedUnion("type", [
  unmanagedWorkspaceSchema,
  managedWorktreeWorkspaceSchema,
  personalWorkspaceSchema,
]);
export type WorkspaceArgs = z.infer<typeof workspaceArgsSchema>;

export const reuseEnvironmentSchema = z.object({
  type: z.literal("reuse"),
  environmentId: z.string().min(1),
});

export const hostEnvironmentSchema = z
  .object({
    type: z.literal("host"),
    hostId: z.string().min(1).optional(),
    workspace: workspaceArgsSchema,
  })
  .superRefine((value, ctx) => {
    if (value.workspace.type !== "personal" && value.hostId === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "hostId is required unless workspace.type is personal",
        path: ["hostId"],
      });
    }
  });

export const environmentArgsSchema = z.discriminatedUnion("type", [
  reuseEnvironmentSchema,
  hostEnvironmentSchema,
]);
export type EnvironmentArgs = z.infer<typeof environmentArgsSchema>;

export const projectDefaultEnvironmentSchema = z.object({
  type: z.literal("project-default"),
});

export const createThreadEnvironmentArgsSchema = z.discriminatedUnion("type", [
  reuseEnvironmentSchema,
  hostEnvironmentSchema,
  projectDefaultEnvironmentSchema,
]);
export type CreateThreadEnvironmentArgs = z.infer<
  typeof createThreadEnvironmentArgsSchema
>;

export const pathListIncludeQueryValueSchema = z.enum(["true", "false"]);
export type PathListIncludeQueryValue = z.infer<
  typeof pathListIncludeQueryValueSchema
>;

export const branchListQuerySchema = z.object({
  query: z.string().min(1).max(BRANCH_LIST_QUERY_MAX_LENGTH).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
});

export const serverMessageSchema = changedMessageSchema;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export const serverMessageLenientSchema = changedMessageLenientSchema;

export const pluginSignalSchema = z
  .object({
    type: z.literal("plugin-signal"),
    pluginId: z.string().min(1),
    channel: z.string().min(1),
    payload: z.unknown(),
  })
  .strict();
export type PluginSignal = z.infer<typeof pluginSignalSchema>;

export const pluginSignalLenientSchema = z.object({
  type: z.literal("plugin-signal"),
  pluginId: z.string().min(1),
  channel: z.string().min(1),
  payload: z.unknown(),
});

export const workspaceFileSchema = z.object({
  path: z.string(),
  name: z.string(),
});
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

export const workspacePathEntryKindSchema = z.enum(["file", "directory"]);

export const workspacePathEntrySchema = z.object({
  kind: workspacePathEntryKindSchema,
  path: z.string(),
  name: z.string(),
  score: z.number(),
  positions: z.array(z.number().int().nonnegative()),
});
export type WorkspacePathEntry = z.infer<typeof workspacePathEntrySchema>;

export const workspaceFileListResponseSchema = z.object({
  files: z.array(workspaceFileSchema),
  truncated: z.boolean(),
});
export type WorkspaceFileListResponse = z.infer<
  typeof workspaceFileListResponseSchema
>;

export const workspacePathListResponseSchema = z.object({
  paths: z.array(workspacePathEntrySchema),
  truncated: z.boolean(),
});
export type WorkspacePathListResponse = z.infer<
  typeof workspacePathListResponseSchema
>;

export function rejectMultipleWorkspaceSelectors(
  query: { environmentId?: string; hostId?: string },
  context: z.RefinementCtx,
): void {
  if (query.environmentId !== undefined && query.hostId !== undefined) {
    context.addIssue({
      code: "custom",
      message: "hostId and environmentId are mutually exclusive",
    });
  }
}
