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

/**
 * Start a new provider session for a thread.
 *
 * Sent by the server after provisioning completes and input is available.
 * The daemon creates/ensures the AgentRuntime for the environment (using
 * `workspacePath`), then calls `runtime.startThread()`.
 *
 * Result: `{ providerThreadId }`.
 *
 * Not lane-serialized — thread commands run concurrently.
 */
export const threadStartCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("thread.start"),
  workspacePath: z.string().min(1),
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  input: z.array(promptInputSchema).min(1).optional(),
  options: hostDaemonExecutionOptionsSchema.optional(),
  dynamicTools: z.array(dynamicToolSchema).optional(),
});

/**
 * Resume an existing provider session after daemon restart.
 *
 * Sent by the server to reconnect a thread whose provider session was lost.
 * The daemon creates/ensures the AgentRuntime, then calls
 * `runtime.resumeThread()` with the prior `providerThreadId`. Includes
 * `workspacePath` so the daemon can recreate the runtime if it was lost.
 *
 * Result: `{ providerThreadId }`.
 *
 * Not lane-serialized — thread commands run concurrently.
 */
export const threadResumeCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("thread.resume"),
  workspacePath: z.string().min(1),
  projectId: z.string().min(1).optional(),
  providerThreadId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  options: hostDaemonExecutionOptionsSchema.optional(),
  dynamicTools: z.array(dynamicToolSchema).optional(),
});

/**
 * Execute a conversation turn.
 *
 * Sent by the server when the user submits input on an active thread.
 * The daemon calls `runtime.runTurn()` with the input and execution options.
 * Events flow back to the server via POST /session/events.
 *
 * If the runtime doesn't exist (e.g. post-restart), the daemon lazily
 * recreates it via `resolveThreadRuntime` + `resumeThread` before running.
 *
 * Result: `{}`.
 *
 * Not lane-serialized — thread commands run concurrently.
 */
export const turnRunCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("turn.run"),
  input: z.array(promptInputSchema).min(1),
  options: hostDaemonExecutionOptionsSchema.optional(),
});

/**
 * Steer an active turn mid-execution.
 *
 * Sent by the server when the user provides steering input during an
 * in-progress turn. The daemon calls `runtime.steerTurn()` with the
 * `expectedTurnId` and new input.
 *
 * Result: `{}`.
 *
 * Not lane-serialized — thread commands run concurrently.
 */
export const turnSteerCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("turn.steer"),
  expectedTurnId: z.string().min(1),
  input: z.array(promptInputSchema).min(1),
});

/**
 * Stop an active thread's provider session.
 *
 * Sent by the server when the user stops a thread or the server needs to
 * tear it down. The daemon calls `runtime.stopThread()` and marks the
 * thread inactive.
 *
 * Result: `{}`.
 *
 * Not lane-serialized — thread commands run concurrently.
 */
export const threadStopCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("thread.stop"),
});

/**
 * Rename a thread on the provider side.
 *
 * Sent by the server when the user changes the title or when auto-title
 * generates one. The daemon calls `runtime.renameThread()`.
 *
 * Result: `{}`.
 *
 * Not lane-serialized — thread commands run concurrently.
 */
export const threadRenameCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("thread.rename"),
  title: z.string().min(1),
});

/**
 * List available providers.
 *
 * Sent by the server to discover which providers the daemon knows about.
 * The daemon calls `listAvailableProviderInfos()` from agent-runtime.
 * Not environment-scoped — returns all providers the daemon knows about.
 *
 * Result: `{ providers: ProviderInfo[] }`.
 *
 * Not lane-serialized.
 */
export const providerListCommandSchema = z.object({
  type: z.literal("provider.list"),
});

/**
 * List available models for a specific provider.
 *
 * Sent by the server to enumerate models for a given provider. The daemon
 * calls `createProviderForId(providerId).listModels()`. Not environment-scoped.
 *
 * Result: `{ models: AvailableModel[] }`.
 *
 * Not lane-serialized.
 */
export const providerListModelsCommandSchema = z.object({
  type: z.literal("provider.list_models"),
  providerId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
});

/**
 * Provision a workspace for an environment.
 *
 * Discriminated by `workspaceProvisionType`:
 * - `unmanaged`: validates path exists, discovers git properties (isGitRepo,
 *   isWorktree, branchName). Does NOT create anything.
 * - `managed-worktree`: creates a git worktree at targetPath from sourcePath,
 *   runs setup script if present.
 * - `managed-clone`: clones repo from sourcePath to targetPath, runs setup
 *   script if present.
 *
 * Idempotent — if path already exists and is valid, reports success.
 * Rolls back partial state on failure.
 *
 * Result: `{ path, isGitRepo, isWorktree, branchName, ranSetup }`.
 *
 * Lane-serialized per environmentId.
 */
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

/**
 * Destroy an environment's workspace and runtime.
 *
 * Sent by the server after ensuring threads are stopped/errored. The daemon
 * shuts down the AgentRuntime (kills provider processes), then calls
 * `workspace.destroy()`.
 *
 * Idempotent — no-op if the environment doesn't exist.
 *
 * Result: `{}`.
 *
 * Lane-serialized per environmentId.
 */
export const environmentDestroyCommandSchema = hostDaemonEnvironmentTargetSchema.extend({
  type: z.literal("environment.destroy"),
  path: z.string().min(1),
  workspaceProvisionType: workspaceProvisionTypeSchema,
});

/**
 * Get git/workspace status.
 *
 * Sent by the server to check the current state of a workspace. The daemon
 * returns workspace status including state (clean/dirty), changed file
 * counts, and branch info.
 *
 * Result: `{ workspaceStatus: WorkspaceStatus }`.
 *
 * Lane-serialized per environmentId (workspace command).
 */
export const workspaceStatusCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("workspace.status"),
  mergeBaseBranch: z.string().min(1).optional(),
});

/**
 * Get git diff for a workspace.
 *
 * Sent by the server to retrieve diff information. Accepts optional
 * `mergeBaseBranch` and `selection` to scope the diff.
 *
 * Result: `{ diff: ThreadGitDiffResponse }` with diff text, commits, and
 * branch info.
 *
 * Lane-serialized per environmentId (workspace command).
 */
export const workspaceDiffCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("workspace.diff"),
  selection: threadGitDiffSelectionSchema.optional(),
  mergeBaseBranch: z.string().min(1).optional(),
});

/**
 * Commit changes in the workspace.
 *
 * Sent by the server to create a git commit. Takes a commit `message` and
 * optional `includeUnstaged` flag to stage all changes before committing.
 *
 * Result: `{ commitSha, commitSubject }`.
 *
 * Lane-serialized per environmentId (workspace command).
 */
export const workspaceCommitCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("workspace.commit"),
  message: z.string().min(1),
  includeUnstaged: z.boolean().optional(),
});

/**
 * Squash-merge current branch into a target branch.
 *
 * Sent by the server to merge environment work into a target branch as a
 * single squashed commit. Takes `targetBranch` and `commitMessage`.
 *
 * Result: `{ merged, commitSha }`.
 *
 * Lane-serialized per environmentId (workspace command).
 */
export const workspaceSquashMergeCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("workspace.squash_merge"),
  targetBranch: z.string().min(1),
  commitMessage: z.string().min(1),
});

/**
 * Reset workspace to clean state.
 *
 * Sent by the server to discard all uncommitted changes and restore the
 * workspace to a clean git state.
 *
 * Result: `{}`.
 *
 * Lane-serialized per environmentId (workspace command).
 */
export const workspaceResetCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("workspace.reset"),
});

/**
 * Checkpoint the workspace (commit + push).
 *
 * Sent by the server to create a checkpoint commit and push it to a remote.
 * Takes `commitMessage` and optional `remoteName`.
 *
 * Result: `{ commitSha, branchName, remoteName }`.
 *
 * Lane-serialized per environmentId (workspace command).
 */
export const workspaceCheckpointCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("workspace.checkpoint"),
  commitMessage: z.string().min(1),
  remoteName: z.string().min(1).optional(),
});

/**
 * Promote an environment branch to the primary checkout.
 *
 * Sent by the server when the user wants to switch the primary checkout to
 * the environment's branch. The daemon checks both workspaces are clean,
 * detaches the source HEAD, and checks out the env branch on the primary.
 *
 * Result: `{ ok: true }`.
 *
 * Lane-serialized per environmentId (workspace command).
 */
export const workspacePromoteCommandSchema = hostDaemonEnvironmentTargetSchema.extend({
  type: z.literal("workspace.promote"),
  threadId: z.string().min(1),
  primaryPath: z.string().min(1),
});

/**
 * Demote an environment back from the primary checkout.
 *
 * Sent by the server to reverse a prior promote. Takes `primaryPath`,
 * `defaultBranch`, and `envBranch`. Restores the primary to
 * `defaultBranch` and checks out `envBranch` on the environment.
 *
 * Result: `{ ok: true }`.
 *
 * Lane-serialized per environmentId (workspace command).
 */
export const workspaceDemoteCommandSchema = hostDaemonEnvironmentTargetSchema.extend({
  type: z.literal("workspace.demote"),
  threadId: z.string().min(1),
  primaryPath: z.string().min(1),
  defaultBranch: z.string().min(1),
  envBranch: z.string().min(1),
});

const hostDaemonWorkspaceTargetSchema = hostDaemonEnvironmentTargetSchema;

/**
 * List files in a workspace.
 *
 * Uses `git ls-files` (tracked + untracked non-ignored) for git workspaces,
 * falls back to recursive readdir for non-git workspaces. Optional `query`
 * filter narrows results.
 *
 * Result: `{ files: [{ path, name }] }`.
 *
 * Lane-serialized per environmentId (workspace command).
 */
export const workspaceListFilesCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.list_files"),
  query: z.string().optional(),
});

/**
 * Read a single file from the workspace.
 *
 * Takes `path` relative to the workspace root. Path traversal protection
 * rejects paths that escape the workspace root.
 *
 * Result: `{ path, content }`.
 *
 * Lane-serialized per environmentId (workspace command).
 */
export const workspaceReadFileCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.read_file"),
  path: z.string().min(1),
});

/**
 * List git branches in the workspace.
 *
 * Result: `{ branches: string[], current: string | null }`.
 *
 * Lane-serialized per environmentId (workspace command).
 */
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
  providerListCommandSchema,
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
