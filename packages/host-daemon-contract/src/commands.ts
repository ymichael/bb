import {
  availableModelSchema,
  discoveredWorkspacePropertiesSchema,
  dynamicToolSchema,
  promptInputSchema,
  threadExecutionOptionsSchema,
  threadGitDiffResponseSchema,
  threadGitDiffSelectionSchema,
  workspaceProvisionTypeSchema,
  providerInfoSchema,
  reasoningLevelSchema,
  sandboxModeSchema,
  serviceTierSchema,
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
  "provider.list",
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

export const hostDaemonExecutionOptionsSchema = threadExecutionOptionsSchema.extend({
  model: z.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  sandboxMode: sandboxModeSchema,
});
export type HostDaemonExecutionOptions = z.infer<
  typeof hostDaemonExecutionOptionsSchema
>;

const hostDaemonThreadTargetSchema = z.object({
  environmentId: z.string().min(1),
  threadId: z.string().min(1),
});

const hostDaemonThreadRuntimeContextSchema = z.object({
  workspacePath: z.string().min(1),
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

const hostDaemonEnvironmentTargetSchema = z.object({
  environmentId: z.string().min(1),
});

const hostDaemonWorkspaceTargetSchema = hostDaemonEnvironmentTargetSchema.extend({
  environmentStatus: z.literal("ready"),
  workspacePath: z.string().min(1),
});

export const threadStartCommandSchema = hostDaemonThreadTargetSchema.merge(
  hostDaemonThreadRuntimeContextSchema,
).extend({
  type: z.literal("thread.start"),
  eventSequence: z.number().int().nonnegative(),
  input: z.array(promptInputSchema).min(1),
});

/** Reconnect a thread's provider session after a daemon restart. Does not start a turn. */
export const threadResumeCommandSchema = hostDaemonThreadTargetSchema.merge(
  hostDaemonExistingThreadRuntimeContextSchema,
).extend({
  type: z.literal("thread.resume"),
});

/** Run a conversation turn with user input. Used for every message after the first. */
export const turnRunCommandSchema = hostDaemonThreadTargetSchema.merge(
  hostDaemonExistingThreadRuntimeContextSchema,
).extend({
  type: z.literal("turn.run"),
  eventSequence: z.number().int().nonnegative(),
  input: z.array(promptInputSchema).min(1),
});

export const turnSteerCommandSchema = hostDaemonThreadTargetSchema.merge(
  hostDaemonExistingThreadRuntimeContextSchema,
).extend({
  type: z.literal("turn.steer"),
  eventSequence: z.number().int().nonnegative(),
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

export const providerListCommandSchema = z.object({
  type: z.literal("provider.list"),
});

export const providerListModelsCommandSchema = z.object({
  type: z.literal("provider.list_models"),
  providerId: z.string().min(1),
});

const environmentProvisionCommandBaseSchema = hostDaemonEnvironmentTargetSchema.extend({
  type: z.literal("environment.provision"),
  projectId: z.string().min(1),
});

const unmanagedEnvironmentProvisionCommandSchema =
  environmentProvisionCommandBaseSchema.extend({
    workspaceProvisionType: z.literal("unmanaged"),
    /** Path to validate */
    path: z.string().min(1),
  });

const managedWorktreeEnvironmentProvisionCommandSchema =
  environmentProvisionCommandBaseSchema.extend({
    workspaceProvisionType: z.literal("managed-worktree"),
    /** Source repo path */
    sourcePath: z.string().min(1),
    /** Target path for worktree creation */
    targetPath: z.string().min(1),
    /** Branch name */
    branchName: z.string().min(1),
  });

const managedCloneEnvironmentProvisionCommandSchema =
  environmentProvisionCommandBaseSchema.extend({
    workspaceProvisionType: z.literal("managed-clone"),
    /** Source repo path */
    sourcePath: z.string().min(1),
    /** Target path for clone creation */
    targetPath: z.string().min(1),
    /** Branch name */
    branchName: z.string().min(1),
  });

/**
 * Provision a workspace for an environment.
 *
 * Discriminated by `workspaceProvisionType`:
 * - `unmanaged`: validates `path`, discovers git properties (isGitRepo,
 *   isWorktree, branchName). Does NOT create anything.
 * - `managed-worktree`: creates a git worktree at `targetPath` from
 *   `sourcePath`, runs setup script if present.
 * - `managed-clone`: clones repo from `sourcePath` to `targetPath`, runs setup
 *   script if present.
 *
 * Idempotent — if path already exists and is valid, reports success.
 * Rolls back partial state on failure.
 *
 * Result: `{ path, isGitRepo, isWorktree, branchName, ranSetup }`.
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

export const environmentDestroyCommandSchema = hostDaemonEnvironmentTargetSchema.extend({
  type: z.literal("environment.destroy"),
  path: z.string().min(1),
  workspaceProvisionType: workspaceProvisionTypeSchema,
});

export const workspaceStatusCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.status"),
  mergeBaseBranch: z.string().min(1),
});

export const workspaceDiffCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.diff"),
  selection: threadGitDiffSelectionSchema,
  mergeBaseBranch: z.string().min(1),
});

export const workspaceCommitCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.commit"),
  message: z.string().min(1),
});

export const workspaceSquashMergeCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.squash_merge"),
  targetBranch: z.string().min(1),
});

/** Discard all uncommitted changes. Internal use only — not exposed via public API. */
export const workspaceResetCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.reset"),
});

/** Commit and push to remote. Internal use only — not exposed via public API. */
export const workspaceCheckpointCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.checkpoint"),
  commitMessage: z.string().min(1),
});

/** Switch the project's primary checkout to the environment's branch so the user can work with the changes directly. */
export const workspacePromoteCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.promote"),
  threadId: z.string().min(1),
  primaryPath: z.string().min(1),
});

/** Reverse a prior promote — restore the primary checkout to the default branch. */
export const workspaceDemoteCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.demote"),
  threadId: z.string().min(1),
  primaryPath: z.string().min(1),
  defaultBranch: z.string().min(1),
  envBranch: z.string().min(1),
});

export const workspaceListFilesCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.list_files"),
  query: z.string().optional(),
});

export const workspaceReadFileCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.read_file"),
  path: z.string().min(1),
});

export const workspaceListBranchesCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.list_branches"),
});

const hostDaemonNonProvisionCommandSchema = z.discriminatedUnion("type", [
  threadStartCommandSchema,
  threadResumeCommandSchema,
  turnRunCommandSchema,
  turnSteerCommandSchema,
  threadStopCommandSchema,
  threadRenameCommandSchema,
  providerListCommandSchema,
  providerListModelsCommandSchema,
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
export const hostDaemonCommandSchema = z.union([
  hostDaemonNonProvisionCommandSchema,
  environmentProvisionCommandSchema,
]);
export type HostDaemonCommand = z.infer<typeof hostDaemonCommandSchema>;

export const hostDaemonCommandResultSchemaByType = {
  "thread.start": z.object({
    providerThreadId: z.string().min(1),
  }),
  "thread.resume": z.object({
    providerThreadId: z.string().min(1),
  }),
  "turn.run": z.object({}),
  "turn.steer": z.object({}),
  "thread.stop": z.object({}),
  "thread.rename": z.object({}),
  "provider.list": z.object({
    providers: z.array(providerInfoSchema),
  }),
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
    commitSubject: z.string().min(1),
  }),
  "workspace.squash_merge": z.object({
    merged: z.boolean(),
    commitSha: z.string().min(1),
  }),
  "workspace.reset": z.object({}),
  "workspace.checkpoint": z.object({
    commitSha: z.string().min(1),
    remoteName: z.string().min(1),
    branchName: z.string().min(1),
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

/**
 * Wire format for a command sent from the server to the daemon.
 *
 * Each command is self-describing — `command` contains the discriminated
 * `type` field plus its payload. `id` is a unique command identifier used
 * to correlate results. `cursor` is per-host monotonic, used by the daemon
 * to detect gaps and request replays.
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
