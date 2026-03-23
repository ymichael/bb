import {
  availableModelSchema,
  dynamicToolSchema,
  hostTypeSchema,
  promptInputSchema,
  threadEventSchema,
  threadExecutionOptionsSchema,
  threadGitDiffResponseSchema,
  threadGitDiffSelectionSchema,
  workspaceStatusSchema,
} from "@bb/domain";
import { z } from "zod";

export const HOST_DAEMON_PROTOCOL_VERSION = 1 as const;

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
  "workspace.export",
  "workspace.import",
  "workspace.reattach",
] as const;
export const hostDaemonCommandTypeSchema = z.enum(HOST_DAEMON_COMMAND_TYPES);
export type HostDaemonCommandType = z.infer<typeof hostDaemonCommandTypeSchema>;

export const hostDaemonExecutionOptionsSchema = threadExecutionOptionsSchema;
export type HostDaemonExecutionOptions = z.infer<
  typeof hostDaemonExecutionOptionsSchema
>;

export const threadStartCommandSchema = z.object({
  type: z.literal("thread.start"),
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  input: z.array(promptInputSchema).min(1).optional(),
  options: hostDaemonExecutionOptionsSchema.optional(),
  dynamicTools: z.array(dynamicToolSchema).optional(),
});

export const threadResumeCommandSchema = z.object({
  type: z.literal("thread.resume"),
  threadId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  providerThreadId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  options: hostDaemonExecutionOptionsSchema.optional(),
  dynamicTools: z.array(dynamicToolSchema).optional(),
});

export const turnRunCommandSchema = z.object({
  type: z.literal("turn.run"),
  threadId: z.string().min(1),
  input: z.array(promptInputSchema).min(1),
  options: hostDaemonExecutionOptionsSchema.optional(),
});

export const turnSteerCommandSchema = z.object({
  type: z.literal("turn.steer"),
  threadId: z.string().min(1),
  expectedTurnId: z.string().min(1),
  input: z.array(promptInputSchema).min(1),
});

export const threadStopCommandSchema = z.object({
  type: z.literal("thread.stop"),
  threadId: z.string().min(1),
});

export const threadRenameCommandSchema = z.object({
  type: z.literal("thread.rename"),
  threadId: z.string().min(1),
  title: z.string().min(1),
});

export const providerListModelsCommandSchema = z.object({
  type: z.literal("provider.list_models"),
  providerId: z.string().min(1),
});

export const environmentProvisionCommandSchema = z.object({
  type: z.literal("environment.provision"),
  projectId: z.string().min(1),
  strategy: z.enum(["worktree", "clone", "existing_path"]),
  sourcePath: z.string().min(1).optional(),
  targetPath: z.string().min(1),
  branchName: z.string().min(1).optional(),
  scriptName: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const environmentDestroyCommandSchema = z.object({
  type: z.literal("environment.destroy"),
  path: z.string().min(1),
  kind: z.enum(["worktree", "directory"]),
  force: z.boolean().optional(),
});

export const workspaceStatusCommandSchema = z.object({
  type: z.literal("workspace.status"),
  mergeBaseBranch: z.string().min(1).optional(),
});

export const workspaceDiffCommandSchema = z.object({
  type: z.literal("workspace.diff"),
  selection: threadGitDiffSelectionSchema.optional(),
  mergeBaseBranch: z.string().min(1).optional(),
});

export const workspaceCommitCommandSchema = z.object({
  type: z.literal("workspace.commit"),
  message: z.string().min(1),
  includeUnstaged: z.boolean().optional(),
});

export const workspaceSquashMergeCommandSchema = z.object({
  type: z.literal("workspace.squash_merge"),
  targetBranch: z.string().min(1),
  commitMessage: z.string().min(1),
});

export const workspaceResetCommandSchema = z.object({
  type: z.literal("workspace.reset"),
});

export const workspaceCheckpointCommandSchema = z.object({
  type: z.literal("workspace.checkpoint"),
  commitMessage: z.string().min(1),
  remoteName: z.string().min(1).optional(),
});

export const workspaceExportCommandSchema = z.object({
  type: z.literal("workspace.export"),
  pushToRemote: z.string().min(1).optional(),
});

export const workspaceImportCommandSchema = z.object({
  type: z.literal("workspace.import"),
  branch: z.string().min(1),
  remote: z.string().min(1).optional(),
});

export const workspaceReattachCommandSchema = z.object({
  type: z.literal("workspace.reattach"),
  branch: z.string().min(1),
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
  workspaceExportCommandSchema,
  workspaceImportCommandSchema,
  workspaceReattachCommandSchema,
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
  "environment.provision": z.object({
    path: z.string().min(1),
    branchName: z.string().min(1).optional(),
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
  "workspace.export": z.object({
    type: z.literal("branch"),
    branch: z.string().min(1),
    remote: z.string().min(1).optional(),
  }),
  "workspace.import": z.object({
    previousBranch: z.string().min(1).optional(),
    stashRef: z.string().nullable().optional(),
  }),
  "workspace.reattach": z.object({}),
} as const satisfies Record<HostDaemonCommandType, z.ZodTypeAny>;

export type HostDaemonCommandResultByType = {
  [K in keyof typeof hostDaemonCommandResultSchemaByType]: z.infer<
    (typeof hostDaemonCommandResultSchemaByType)[K]
  >;
};

export type HostDaemonCommandResult<
  TType extends HostDaemonCommandType = HostDaemonCommandType,
> = HostDaemonCommandResultByType[TType];

export const hostDaemonCommandMetaSchema = z.object({
  commandId: z.string().min(1),
  cursor: z.number().int().nonnegative(),
  environmentId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  createdAt: z.number().int().nonnegative(),
});
export type HostDaemonCommandMeta = z.infer<typeof hostDaemonCommandMetaSchema>;

export const hostDaemonCommandEnvelopeSchema = z.object({
  meta: hostDaemonCommandMetaSchema,
  command: hostDaemonCommandSchema,
});
export type HostDaemonCommandEnvelope = z.infer<
  typeof hostDaemonCommandEnvelopeSchema
>;

export const hostDaemonEventEnvelopeSchema = z.object({
  id: z.string().min(1),
  environmentId: z.string().min(1),
  threadId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  event: threadEventSchema,
});
export type HostDaemonEventEnvelope = z.infer<
  typeof hostDaemonEventEnvelopeSchema
>;

export const hostDaemonActiveThreadSchema = z.object({
  environmentId: z.string().min(1),
  threadId: z.string().min(1),
  providerThreadId: z.string().min(1),
});
export type HostDaemonActiveThread = z.infer<typeof hostDaemonActiveThreadSchema>;

export const hostDaemonSessionOpenRequestSchema = z.object({
  hostId: z.string().min(1),
  instanceId: z.string().min(1),
  hostName: z.string().min(1),
  hostType: hostTypeSchema,
  protocolVersion: z.literal(HOST_DAEMON_PROTOCOL_VERSION),
  activeThreads: z.array(hostDaemonActiveThreadSchema).optional(),
});
export type HostDaemonSessionOpenRequest = z.infer<
  typeof hostDaemonSessionOpenRequestSchema
>;

export const hostDaemonSessionOpenResponseSchema = z.object({
  sessionId: z.string().min(1),
  heartbeatIntervalMs: z.number().int().positive(),
  leaseTimeoutMs: z.number().int().positive(),
});
export type HostDaemonSessionOpenResponse = z.infer<
  typeof hostDaemonSessionOpenResponseSchema
>;

export const hostDaemonHeartbeatRequestSchema = z.object({
  sessionId: z.string().min(1),
  bufferDepth: z.number().int().nonnegative(),
  lastCommandCursor: z.number().int().nonnegative().optional(),
});
export type HostDaemonHeartbeatRequest = z.infer<
  typeof hostDaemonHeartbeatRequestSchema
>;

export const hostDaemonHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
});
export type HostDaemonHeartbeatResponse = z.infer<
  typeof hostDaemonHeartbeatResponseSchema
>;

export const hostDaemonCommandBatchSchema = z.object({
  commands: z.array(hostDaemonCommandEnvelopeSchema),
});
export type HostDaemonCommandBatch = z.infer<typeof hostDaemonCommandBatchSchema>;

export const hostDaemonCommandResultReportSchema = z.object({
  sessionId: z.string().min(1),
  commandId: z.string().min(1),
  cursor: z.number().int().nonnegative(),
  type: hostDaemonCommandTypeSchema,
  ok: z.boolean(),
  result: z.unknown().optional(),
  errorCode: z.string().min(1).optional(),
  errorMessage: z.string().min(1).optional(),
  completedAt: z.number().int().nonnegative(),
});
export type HostDaemonCommandResultReport = z.infer<
  typeof hostDaemonCommandResultReportSchema
>;

export const hostDaemonEventBatchRequestSchema = z.object({
  sessionId: z.string().min(1),
  events: z.array(hostDaemonEventEnvelopeSchema),
});
export type HostDaemonEventBatchRequest = z.infer<
  typeof hostDaemonEventBatchRequestSchema
>;

export const hostDaemonEventBatchResponseSchema = z.object({
  highWaterMarks: z.array(
    z.object({
      threadId: z.string().min(1),
      sequence: z.number().int().nonnegative(),
    }),
  ),
});
export type HostDaemonEventBatchResponse = z.infer<
  typeof hostDaemonEventBatchResponseSchema
>;
