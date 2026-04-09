import {
  availableModelSchema,
  discoveredWorkspacePropertiesSchema,
  dynamicToolSchema,
  promptInputSchema,
  threadExecutionOptionsSchema,
  threadGitDiffResponseSchema,
  workspaceProvisionTypeSchema,
  providerInfoSchema,
  reasoningLevelSchema,
  sandboxModeSchema,
  serviceTierSchema,
  provisioningTranscriptEntrySchema,
  workspaceDiffTargetSchema,
  workspaceStatusSchema,
} from "@bb/domain";
import { z } from "zod";

export const HOST_DAEMON_PROTOCOL_VERSION = 5 as const;

export const HOST_DAEMON_COMMAND_TYPES = [
  "thread.start",
  "turn.run",
  "turn.steer",
  "thread.stop",
  "thread.rename",
  "thread.deleted",
  "host.list_files",
  "host.read_file",
  "provider.list",
  "provider.list_models",
  "environment.provision",
  "environment.destroy",
  "workspace.status",
  "workspace.diff",
  "workspace.commit",
  "workspace.squash_merge",
  "workspace.promote",
  "workspace.demote",
  "workspace.list_files",
  "workspace.list_branches",
] as const;
export const hostDaemonCommandTypeSchema = z.enum(HOST_DAEMON_COMMAND_TYPES);
export type HostDaemonCommandType = z.infer<typeof hostDaemonCommandTypeSchema>;

export const hostDaemonExecutionOptionsSchema = threadExecutionOptionsSchema.extend({
  model: z.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  sandboxMode: sandboxModeSchema,
});
export type HostDaemonExecutionOptions = z.infer<
  typeof hostDaemonExecutionOptionsSchema
>;

export const workspaceContextSchema = z.object({
  workspacePath: z.string().min(1),
  workspaceProvisionType: workspaceProvisionTypeSchema,
});
export type WorkspaceContext = z.infer<typeof workspaceContextSchema>;

const hostDaemonThreadTargetSchema = z.object({
  environmentId: z.string().min(1),
  threadId: z.string().min(1),
});

const hostDaemonThreadRuntimeContextSchema = z.object({
  workspaceContext: workspaceContextSchema,
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  options: hostDaemonExecutionOptionsSchema,
  instructions: z.string().min(1),
  dynamicTools: z.array(dynamicToolSchema),
});

const hostDaemonExistingThreadRuntimeContextSchema =
  hostDaemonThreadRuntimeContextSchema.extend({
    providerThreadId: z.string().min(1),
  });

const turnResumeContextSchema = hostDaemonExistingThreadRuntimeContextSchema.omit({
  options: true,
});

const hostDaemonEnvironmentTargetSchema = z.object({
  environmentId: z.string().min(1),
});

const hostDaemonWorkspaceTargetSchema = hostDaemonEnvironmentTargetSchema.extend({
  workspaceContext: workspaceContextSchema,
});

export const threadStartCommandSchema = hostDaemonThreadTargetSchema.merge(
  hostDaemonThreadRuntimeContextSchema,
).extend({
  type: z.literal("thread.start"),
  eventSequence: z.number().int().nonnegative(),
  input: z.array(promptInputSchema).min(1),
  threadStoragePath: z.string().min(1).optional(),
});

/** Run a conversation turn with user input. Used for every message after the first. */
export const turnRunCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("turn.run"),
  eventSequence: z.number().int().nonnegative(),
  input: z.array(promptInputSchema).min(1),
  options: hostDaemonExecutionOptionsSchema,
  resumeContext: turnResumeContextSchema,
});

export const turnSteerCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("turn.steer"),
  eventSequence: z.number().int().nonnegative(),
  expectedTurnId: z.string().min(1),
  input: z.array(promptInputSchema).min(1),
  options: hostDaemonExecutionOptionsSchema,
  resumeContext: turnResumeContextSchema,
});

export const threadStopCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("thread.stop"),
});

export const threadRenameCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("thread.rename"),
  title: z.string().min(1),
});

export const threadDeletedCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("thread.deleted"),
});

/**
 * Read a file from an absolute host path while enforcing that the resolved file
 * stays under the declared absolute root.
 */
export const hostReadFileCommandSchema = z.object({
  type: z.literal("host.read_file"),
  path: z.string().min(1),
  rootPath: z.string().min(1),
});

export const hostListFilesCommandSchema = z.object({
  type: z.literal("host.list_files"),
  path: z.string().min(1),
  query: z.string().optional(),
  limit: z.number().int().positive(),
});

export const providerListCommandSchema = z.object({
  type: z.literal("provider.list"),
});

export const providerListModelsCommandSchema = z.object({
  type: z.literal("provider.list_models"),
  providerId: z.string().min(1),
});

const provisionInitiatorSchema = z.object({
  /** Thread that initiated provisioning. Used to stream progress events. */
  threadId: z.string().min(1),
  /** Current max event sequence for the thread. Seeds the event buffer so daemon-emitted events don't collide with server-side sequences. */
  eventSequence: z.number().int().nonnegative(),
});

const environmentProvisionCommandBaseSchema = hostDaemonEnvironmentTargetSchema.extend({
  type: z.literal("environment.provision"),
  /** Initiating thread for live progress streaming. Null when no thread is associated (e.g., project source provisioning). */
  initiator: provisionInitiatorSchema.nullable(),
});

const unmanagedEnvironmentProvisionCommandSchema =
  environmentProvisionCommandBaseSchema.extend({
    workspaceProvisionType: z.literal("unmanaged"),
    /** Path to validate */
    path: z.string().min(1),
  });

const managedEnvironmentProvisionFieldsSchema = z.object({
  /** Source repo path */
  sourcePath: z.string().min(1),
  /** Target path for worktree/clone creation */
  targetPath: z.string().min(1),
  /** Branch name */
  branchName: z.string().min(1),
  /** Maximum time in ms to wait for the setup script */
  setupTimeoutMs: z.number().int().positive(),
});

const managedWorktreeEnvironmentProvisionCommandSchema =
  environmentProvisionCommandBaseSchema
    .merge(managedEnvironmentProvisionFieldsSchema)
    .extend({ workspaceProvisionType: z.literal("managed-worktree") });

const managedCloneEnvironmentProvisionCommandSchema =
  environmentProvisionCommandBaseSchema
    .merge(managedEnvironmentProvisionFieldsSchema)
    .extend({ workspaceProvisionType: z.literal("managed-clone") });

/**
 * Provision a workspace for an environment.
 *
 * Discriminated by `workspaceProvisionType`:
 * - `unmanaged`: validates `path`, discovers git properties (isGitRepo,
 *   isWorktree, branchName). Does NOT create anything.
 * - `managed-worktree`: creates a git worktree at `targetPath` from
 *   `sourcePath`, runs setup script if present.
 * - `managed-clone`: clones repo from `sourcePath` to `targetPath`, where
 *   `sourcePath` may be a local repo path or a remote clone URL, then runs
 *   setup script if present.
 *
 * Idempotent — if path already exists and is valid, reports success.
 * Rolls back partial state on failure.
 *
 * Result: `{ path, isGitRepo, isWorktree, branchName, transcript }`.
 *
 * Lane-serialized per environmentId.
 */
export const environmentProvisionCommandSchema = z.discriminatedUnion(
  "workspaceProvisionType",
  [
    unmanagedEnvironmentProvisionCommandSchema,
    managedWorktreeEnvironmentProvisionCommandSchema,
    managedCloneEnvironmentProvisionCommandSchema,
  ],
);

export const environmentDestroyCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("environment.destroy"),
});

export const workspaceStatusCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.status"),
  mergeBaseBranch: z.string().min(1).optional(),
});

export const workspaceDiffCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.diff"),
  target: workspaceDiffTargetSchema,
  maxDiffBytes: z.number().int().positive().optional(),
  maxFileListBytes: z.number().int().positive().optional(),
});

export const workspaceCommitCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.commit"),
  message: z.string().min(1),
});

export const workspaceSquashMergeCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.squash_merge"),
  targetBranch: z.string().min(1),
  commitMessage: z.string().min(1),
});

/** Switch the project's primary checkout to the environment's branch so the user can work with the changes directly. */
export const workspacePromoteCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.promote"),
  primaryPath: z.string().min(1),
});

/** Reverse a prior promote — restore the primary checkout to the default branch. */
export const workspaceDemoteCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.demote"),
  primaryPath: z.string().min(1),
  defaultBranch: z.string().min(1),
  envBranch: z.string().min(1),
});

export const workspaceListFilesCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.list_files"),
  query: z.string().optional(),
  limit: z.number().int().positive(),
});

export const workspaceListBranchesCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.list_branches"),
});

const hostDaemonNonProvisionCommandSchema = z.discriminatedUnion("type", [
  threadStartCommandSchema,
  turnRunCommandSchema,
  turnSteerCommandSchema,
  threadStopCommandSchema,
  threadRenameCommandSchema,
  threadDeletedCommandSchema,
  hostListFilesCommandSchema,
  hostReadFileCommandSchema,
  providerListCommandSchema,
  providerListModelsCommandSchema,
  environmentDestroyCommandSchema,
  workspaceStatusCommandSchema,
  workspaceDiffCommandSchema,
  workspaceCommitCommandSchema,
  workspaceSquashMergeCommandSchema,
  workspacePromoteCommandSchema,
  workspaceDemoteCommandSchema,
  workspaceListFilesCommandSchema,
  workspaceListBranchesCommandSchema,
]);
export const hostDaemonCommandSchema = z.union([
  hostDaemonNonProvisionCommandSchema,
  environmentProvisionCommandSchema,
]);
export type HostDaemonCommand = z.infer<typeof hostDaemonCommandSchema>;

const fileReadResultSchema = z.object({
  path: z.string(),
  content: z.string(),
  contentEncoding: z.enum(["base64", "utf8"]),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
});

const fileListResultSchema = z.object({
  files: z.array(z.object({ path: z.string(), name: z.string() })),
  truncated: z.boolean(),
});

export const hostDaemonCommandResultSchemaByType = {
  "thread.start": z.object({
    providerThreadId: z.string().min(1),
  }),
  "turn.run": z.object({}),
  "turn.steer": z.object({}),
  "thread.stop": z.object({}),
  "thread.rename": z.object({}),
  "thread.deleted": z.object({}),
  "host.list_files": fileListResultSchema,
  "host.read_file": fileReadResultSchema,
  "provider.list": z.object({
    providers: z.array(providerInfoSchema),
  }),
  "provider.list_models": z.object({
    models: z.array(availableModelSchema),
  }),
  "environment.provision": discoveredWorkspacePropertiesSchema.extend({
    transcript: z.array(provisioningTranscriptEntrySchema),
  }),
  "environment.destroy": z.object({}),
  "workspace.status": z.object({
    workspaceStatus: workspaceStatusSchema,
  }),
  "workspace.diff": z.object({
    diff: threadGitDiffResponseSchema,
  }),
  "workspace.commit": z.object({
    commitSha: z.string().min(1),
    commitSubject: z.string().min(1),
  }),
  "workspace.squash_merge": z.object({
    merged: z.boolean(),
    commitSha: z.string().min(1),
  }),
  "workspace.promote": z.object({
    ok: z.boolean(),
  }),
  "workspace.demote": z.object({
    ok: z.boolean(),
  }),
  "workspace.list_files": fileListResultSchema,
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

/**
 * Wire format for a command sent from the server to the daemon.
 *
 * Each command is self-describing — `command` contains the discriminated
 * `type` field plus its payload. `id` is a unique command identifier used
 * to correlate results. `cursor` is per-host monotonic and preserves
 * deterministic fetch order for a host.
 */
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

/** Catch-all schema for reporting errors on command types the daemon doesn't recognize. */
const unknownCommandErrorSchema = hostDaemonCommandResultReportBaseSchema.extend({
  type: z.string().min(1),
  ok: z.literal(false),
  errorCode: z.literal("unknown_command"),
  errorMessage: z.string().min(1),
});

/**
 * Result report union sent from the daemon back to the server.
 *
 * Success reports (`ok: true`) include the typed result for the command type.
 * Error reports (`ok: false`) include `errorCode` and `errorMessage`.
 * Unknown command types use errorCode `"unknown_command"`.
 */
export const hostDaemonCommandResultReportSchema = z.union([
  ...hostDaemonCommandResultReportSchemas,
  unknownCommandErrorSchema,
] as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
export type HostDaemonCommandResultReport = z.infer<
  typeof hostDaemonCommandResultReportSchema
>;
