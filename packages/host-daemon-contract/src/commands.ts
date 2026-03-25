import {
  availableModelSchema,
  discoveredWorkspacePropertiesSchema,
  dynamicToolSchema,
  promptInputSchema,
  threadExecutionOptionsSchema,
  threadGitDiffResponseSchema,
  threadGitDiffSelectionSchema,
  workspaceProvisionTypeSchema,
  workspaceStatusSchema,
} from "@bb/domain";
import { z } from "zod";

export const HOST_DAEMON_PROTOCOL_VERSION = 2 as const;

export const HOST_DAEMON_COMMAND_TYPES = [
  "thread.start",
  "thread.resume",
  "turn.run",
  "turn.steer",
  "thread.stop",
  "thread.rename",
  "provider.list_models",
  "environment.provision",
  "environment.destroy",
  "workspace.status",
  "workspace.diff",
  "workspace.commit",
  "workspace.squash_merge",
  "workspace.reset",
  "workspace.checkpoint",
  "workspace.promote",
  "workspace.demote",
  "workspace.list_files",
  "workspace.read_file",
  "workspace.list_branches",
] as const;
export const hostDaemonCommandTypeSchema = z.enum(HOST_DAEMON_COMMAND_TYPES);
export type HostDaemonCommandType = z.infer<typeof hostDaemonCommandTypeSchema>;

export const hostDaemonExecutionOptionsSchema = threadExecutionOptionsSchema;
export type HostDaemonExecutionOptions = z.infer<
  typeof hostDaemonExecutionOptionsSchema
>;

const hostDaemonThreadTargetSchema = z.object({
  environmentId: z.string().min(1),
  threadId: z.string().min(1),
});

const hostDaemonEnvironmentTargetSchema = z.object({
  environmentId: z.string().min(1),
});

export const threadStartCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("thread.start"),
  workspacePath: z.string().min(1),
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  input: z.array(promptInputSchema).min(1).optional(),
  options: hostDaemonExecutionOptionsSchema.optional(),
  dynamicTools: z.array(dynamicToolSchema).optional(),
});

export const threadResumeCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("thread.resume"),
  workspacePath: z.string().min(1),
  projectId: z.string().min(1).optional(),
  providerThreadId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  options: hostDaemonExecutionOptionsSchema.optional(),
  dynamicTools: z.array(dynamicToolSchema).optional(),
});

export const turnRunCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("turn.run"),
  input: z.array(promptInputSchema).min(1),
  options: hostDaemonExecutionOptionsSchema.optional(),
});

export const turnSteerCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("turn.steer"),
  expectedTurnId: z.string().min(1),
  input: z.array(promptInputSchema).min(1),
});

export const threadStopCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("thread.stop"),
});

export const threadRenameCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("thread.rename"),
  title: z.string().min(1),
});

export const providerListModelsCommandSchema = z.object({
  type: z.literal("provider.list_models"),
  providerId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
});

export const environmentProvisionCommandSchema = hostDaemonEnvironmentTargetSchema.extend({
  type: z.literal("environment.provision"),
  projectId: z.string().min(1),
  workspaceProvisionType: workspaceProvisionTypeSchema,
  /** Path to validate (unmanaged) or target path (managed) */
  path: z.string().min(1).optional(),
  /** Source repo path (managed-worktree, managed-clone) */
  sourcePath: z.string().min(1).optional(),
  /** Target path for worktree/clone creation */
  targetPath: z.string().min(1).optional(),
  /** Branch name (managed-worktree, managed-clone) */
  branchName: z.string().min(1).optional(),
  /** Setup script filename */
  scriptName: z.string().min(1).optional(),
  /** Setup script timeout in ms */
  timeoutMs: z.number().int().positive().optional(),
});

export const environmentDestroyCommandSchema = hostDaemonEnvironmentTargetSchema.extend({
  type: z.literal("environment.destroy"),
  path: z.string().min(1),
  workspaceProvisionType: workspaceProvisionTypeSchema,
});

export const workspaceStatusCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("workspace.status"),
  mergeBaseBranch: z.string().min(1).optional(),
});

export const workspaceDiffCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("workspace.diff"),
  selection: threadGitDiffSelectionSchema.optional(),
  mergeBaseBranch: z.string().min(1).optional(),
});

export const workspaceCommitCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("workspace.commit"),
  message: z.string().min(1),
  includeUnstaged: z.boolean().optional(),
});

export const workspaceSquashMergeCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("workspace.squash_merge"),
  targetBranch: z.string().min(1),
  commitMessage: z.string().min(1),
});

export const workspaceResetCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("workspace.reset"),
});

export const workspaceCheckpointCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("workspace.checkpoint"),
  commitMessage: z.string().min(1),
  remoteName: z.string().min(1).optional(),
});

export const workspacePromoteCommandSchema = hostDaemonEnvironmentTargetSchema.extend({
  type: z.literal("workspace.promote"),
  threadId: z.string().min(1),
  primaryPath: z.string().min(1),
});

export const workspaceDemoteCommandSchema = hostDaemonEnvironmentTargetSchema.extend({
  type: z.literal("workspace.demote"),
  threadId: z.string().min(1),
  primaryPath: z.string().min(1),
  defaultBranch: z.string().min(1),
  envBranch: z.string().min(1),
});

const hostDaemonWorkspaceTargetSchema = hostDaemonEnvironmentTargetSchema;

export const workspaceListFilesCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.list_files"),
  query: z.string().optional(),
});

export const workspaceReadFileCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.read_file"),
  path: z.string().min(1),
});

export const workspaceListBranchesCommandSchema = hostDaemonEnvironmentTargetSchema.extend({
  type: z.literal("workspace.list_branches"),
});

export const hostDaemonCommandSchema = z.discriminatedUnion("type", [
  threadStartCommandSchema,
  threadResumeCommandSchema,
  turnRunCommandSchema,
  turnSteerCommandSchema,
  threadStopCommandSchema,
  threadRenameCommandSchema,
  providerListModelsCommandSchema,
  environmentProvisionCommandSchema,
  environmentDestroyCommandSchema,
  workspaceStatusCommandSchema,
  workspaceDiffCommandSchema,
  workspaceCommitCommandSchema,
  workspaceSquashMergeCommandSchema,
  workspaceResetCommandSchema,
  workspaceCheckpointCommandSchema,
  workspacePromoteCommandSchema,
  workspaceDemoteCommandSchema,
  workspaceListFilesCommandSchema,
  workspaceReadFileCommandSchema,
  workspaceListBranchesCommandSchema,
]);
export type HostDaemonCommand = z.infer<typeof hostDaemonCommandSchema>;

export const hostDaemonCommandResultSchemaByType = {
  "thread.start": z.object({
    providerThreadId: z.string().min(1),
  }),
  "thread.resume": z.object({
    providerThreadId: z.string().min(1).optional(),
  }),
  "turn.run": z.object({}),
  "turn.steer": z.object({}),
  "thread.stop": z.object({}),
  "thread.rename": z.object({}),
  "provider.list_models": z.object({
    models: z.array(availableModelSchema),
  }),
  "environment.provision": discoveredWorkspacePropertiesSchema.extend({
    ranSetup: z.boolean(),
  }),
  "environment.destroy": z.object({}),
  "workspace.status": z.object({
    workspaceStatus: workspaceStatusSchema.nullable(),
  }),
  "workspace.diff": z.object({
    diff: threadGitDiffResponseSchema,
  }),
  "workspace.commit": z.object({
    commitSha: z.string().min(1),
    commitSubject: z.string().min(1).optional(),
  }),
  "workspace.squash_merge": z.object({
    merged: z.boolean(),
    commitSha: z.string().min(1).optional(),
    message: z.string().optional(),
  }),
  "workspace.reset": z.object({}),
  "workspace.checkpoint": z.object({
    commitSha: z.string().min(1),
    remoteName: z.string().min(1),
    branchName: z.string().min(1).optional(),
  }),
  "workspace.promote": z.object({
    ok: z.boolean(),
  }),
  "workspace.demote": z.object({
    ok: z.boolean(),
  }),
  "workspace.list_files": z.object({
    files: z.array(z.object({ path: z.string(), name: z.string() })),
  }),
  "workspace.read_file": z.object({
    path: z.string(),
    content: z.string(),
  }),
  "workspace.list_branches": z.object({
    branches: z.array(z.string()),
    current: z.string().nullable(),
  }),
} as const satisfies Record<HostDaemonCommandType, z.ZodTypeAny>;

export type HostDaemonCommandResultByType = {
  [K in keyof typeof hostDaemonCommandResultSchemaByType]: z.infer<
    (typeof hostDaemonCommandResultSchemaByType)[K]
  >;
};

export type HostDaemonCommandResult<
  TType extends HostDaemonCommandType = HostDaemonCommandType,
> = HostDaemonCommandResultByType[TType];

export const hostDaemonCommandEnvelopeSchema = z.object({
  id: z.string().min(1),
  cursor: z.number().int().nonnegative(),
  command: hostDaemonCommandSchema,
});
export type HostDaemonCommandEnvelope = z.infer<
  typeof hostDaemonCommandEnvelopeSchema
>;

const hostDaemonCommandResultReportBaseSchema = z.object({
  sessionId: z.string().min(1),
  commandId: z.string().min(1),
  cursor: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative(),
});

function createHostDaemonCommandResultReportSchemasForType<
  TType extends HostDaemonCommandType,
>(
  type: TType,
  resultSchema: (typeof hostDaemonCommandResultSchemaByType)[TType],
) {
  return [
    hostDaemonCommandResultReportBaseSchema.extend({
      type: z.literal(type),
      ok: z.literal(true),
      result: resultSchema,
    }),
    hostDaemonCommandResultReportBaseSchema.extend({
      type: z.literal(type),
      ok: z.literal(false),
      errorCode: z.string().min(1),
      errorMessage: z.string().min(1),
    }),
  ] as const;
}

const hostDaemonCommandResultReportSchemas = HOST_DAEMON_COMMAND_TYPES.flatMap(
  (type) =>
    createHostDaemonCommandResultReportSchemasForType(
      type,
      hostDaemonCommandResultSchemaByType[type],
    ),
);

export const hostDaemonCommandResultReportSchema = z.union(
  hostDaemonCommandResultReportSchemas as unknown as [
    z.ZodTypeAny,
    z.ZodTypeAny,
    ...z.ZodTypeAny[],
  ],
);
export type HostDaemonCommandResultReport = z.infer<
  typeof hostDaemonCommandResultReportSchema
>;
