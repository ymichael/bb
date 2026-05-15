import {
  availableModelSchema,
  discoveredWorkspacePropertiesSchema,
  dynamicToolSchema,
  instructionModeSchema,
  pendingInteractionResolutionSchema,
  promptInputSchema,
  threadGitDiffResponseSchema,
  workspaceProvisionTypeSchema,
  providerInfoSchema,
  runtimeThreadExecutionOptionsSchema,
  provisioningTranscriptEntrySchema,
  workspaceDiffTargetSchema,
  workspaceStatusSchema,
  clientTurnRequestIdSchema,
} from "@bb/domain";
import {
  replayCaptureDaemonListResponseSchema,
  replayCaptureManifestSchema,
  replaySpeedSchema,
} from "@bb/replay-capture/schema";
import { z } from "zod";
import { hostRuntimeMaterialSnapshotSchema } from "./local-state.js";

export const HOST_DAEMON_PROTOCOL_VERSION = 14 as const;

export const FILE_LIST_QUERY_MAX_LENGTH = 256;
export const FILE_LIST_LIMIT_MAX = 10_000;

export const HOST_DAEMON_COMMAND_TYPES = [
  "thread.start",
  "turn.submit",
  "thread.stop",
  "thread.rename",
  "thread.archive",
  "thread.unarchive",
  "thread.deleted",
  "interactive.resolve",
  "host.sync_runtime_material",
  "host.list_files",
  "host.list_branches",
  "host.read_file",
  "provider.list",
  "provider.list_models",
  "environment.provision",
  "environment.destroy",
  "workspace.status",
  "workspace.diff",
  "workspace.commit",
  "workspace.squash_merge",
  "replay.capture_list",
  "replay.capture_get",
  "replay.capture_delete",
  "replay.run",
] as const;
export const hostDaemonCommandTypeSchema = z.enum(HOST_DAEMON_COMMAND_TYPES);
export type HostDaemonCommandType = z.infer<typeof hostDaemonCommandTypeSchema>;

const hostDaemonCommandTypes = new Set<string>(HOST_DAEMON_COMMAND_TYPES);

export function isHostDaemonCommandType(
  type: string,
): type is HostDaemonCommandType {
  return hostDaemonCommandTypes.has(type);
}

export const hostDaemonExecutionOptionsSchema =
  runtimeThreadExecutionOptionsSchema;
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

const hostDaemonProviderThreadTargetSchema = z.object({
  threadId: z.string().min(1),
});

const hostDaemonThreadRuntimeContextSchema = z.object({
  workspaceContext: workspaceContextSchema,
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  options: hostDaemonExecutionOptionsSchema,
  instructions: z.string().min(1),
  dynamicTools: z.array(dynamicToolSchema),
  disallowedTools: z.array(z.string()).optional(),
  instructionMode: instructionModeSchema,
});

const hostDaemonExistingThreadRuntimeContextSchema =
  hostDaemonThreadRuntimeContextSchema.extend({
    providerThreadId: z.string().min(1),
  });

const turnResumeContextSchema =
  hostDaemonExistingThreadRuntimeContextSchema.omit({
    options: true,
  });

const hostDaemonEnvironmentTargetSchema = z.object({
  environmentId: z.string().min(1),
});

const hostDaemonWorkspaceTargetSchema =
  hostDaemonEnvironmentTargetSchema.extend({
    workspaceContext: workspaceContextSchema,
  });

const hostDaemonThreadWorkspaceTargetSchema =
  hostDaemonThreadTargetSchema.extend({
    workspaceContext: workspaceContextSchema,
  });

export const threadStartCommandSchema = hostDaemonThreadTargetSchema
  .merge(hostDaemonThreadRuntimeContextSchema)
  .extend({
    type: z.literal("thread.start"),
    requestId: clientTurnRequestIdSchema,
    input: z.array(promptInputSchema).min(1),
    threadStoragePath: z.string().min(1).optional(),
  })
  .strict();

export const turnSubmitTargetSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("start"),
  }),
  z.object({
    mode: z.literal("auto"),
    expectedTurnId: z.string().min(1).nullable(),
  }),
  z.object({
    mode: z.literal("steer"),
    expectedTurnId: z.string().min(1).nullable(),
  }),
]);
export type TurnSubmitTarget = z.infer<typeof turnSubmitTargetSchema>;

/**
 * Submit input for an existing provider thread. The daemon chooses whether
 * auto-targeted input steers the expected active turn or starts a new turn.
 */
export const turnSubmitCommandSchema = hostDaemonThreadTargetSchema
  .extend({
    type: z.literal("turn.submit"),
    requestId: clientTurnRequestIdSchema,
    input: z.array(promptInputSchema).min(1),
    options: hostDaemonExecutionOptionsSchema,
    resumeContext: turnResumeContextSchema,
    target: turnSubmitTargetSchema,
  })
  .strict();

export const threadStopCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("thread.stop"),
});

export const threadRenameCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("thread.rename"),
  title: z.string().min(1),
});

export const threadArchiveCommandSchema =
  hostDaemonThreadWorkspaceTargetSchema.extend({
    type: z.literal("thread.archive"),
    providerId: z.string().min(1),
    providerThreadId: z.string().min(1),
  });

export const threadUnarchiveCommandSchema =
  hostDaemonProviderThreadTargetSchema.extend({
    type: z.literal("thread.unarchive"),
    providerId: z.string().min(1),
    providerThreadId: z.string().min(1),
  });

export const threadDeletedCommandSchema = hostDaemonThreadTargetSchema.extend({
  type: z.literal("thread.deleted"),
});

export const replayCaptureListCommandSchema = z.object({
  type: z.literal("replay.capture_list"),
});

export const replayCaptureGetCommandSchema = z.object({
  type: z.literal("replay.capture_get"),
  captureId: z.string().min(1),
});

export const replayCaptureDeleteCommandSchema = z.object({
  type: z.literal("replay.capture_delete"),
  captureId: z.string().min(1),
});

export const replayRunCommandSchema = hostDaemonThreadTargetSchema
  .extend({
    type: z.literal("replay.run"),
    captureId: z.string().min(1),
    requestId: clientTurnRequestIdSchema,
    speed: replaySpeedSchema,
  })
  .strict();

export const interactiveResolveCommandSchema =
  hostDaemonThreadTargetSchema.extend({
    type: z.literal("interactive.resolve"),
    interactionId: z.string().min(1),
    providerId: z.string().min(1),
    providerThreadId: z.string().min(1),
    providerRequestId: z.string().min(1),
    resolution: pendingInteractionResolutionSchema,
  });

/**
 * Request that the daemon replace its managed runtime material with the
 * server's authoritative snapshot for this version.
 */
export const hostSyncRuntimeMaterialCommandSchema = z.object({
  type: z.literal("host.sync_runtime_material"),
  version: hostRuntimeMaterialSnapshotSchema.shape.version,
});

/**
 * Read a file from an absolute host path. When `rootPath` is provided, the
 * daemon enforces that the resolved file stays under that declared absolute
 * root. When `rootPath` is omitted, the daemon reads the explicit absolute
 * disk path without containment-root checks.
 *
 * When `ref` is set, the file is read from git history at that ref instead of
 * from disk. `rootPath` is then interpreted as the repo root, the path becomes
 * a `<repo>/<rel>` join, and the daemon shells `git -C <rootPath> cat-file`.
 * Same caps, same encoding detection, same `file_too_large` behavior — the
 * only difference is the source of bytes. A missing object at `ref` (e.g.
 * the file did not exist at that ref) returns empty content, not an error.
 */
export const hostReadFileCommandSchema = z
  .object({
    type: z.literal("host.read_file"),
    path: z.string().min(1),
    rootPath: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
  })
  .superRefine((command, context) => {
    if (command.ref !== undefined && command.rootPath === undefined) {
      context.addIssue({
        code: "custom",
        path: ["rootPath"],
        message: "rootPath is required when ref is set",
      });
    }
  });

export const hostListFilesCommandSchema = z.object({
  type: z.literal("host.list_files"),
  path: z.string().min(1),
  query: z.string().max(FILE_LIST_QUERY_MAX_LENGTH).optional(),
  limit: z.number().int().positive().max(FILE_LIST_LIMIT_MAX),
});

/**
 * List git branches at an absolute host path. Path-only sibling of
 * `host.list_files`. Does not require an environment row, does not
 * provision anything, and does not create daemon-side workspace state.
 */
export const hostListBranchesCommandSchema = z.object({
  type: z.literal("host.list_branches"),
  path: z.string().min(1),
});

export const providerListCommandSchema = z.object({
  type: z.literal("provider.list"),
});

export const providerListModelsCommandSchema = z.object({
  type: z.literal("provider.list_models"),
  providerId: z.string().min(1),
});

const provisionInitiatorSchema = z
  .object({
    /** Thread that initiated provisioning. Used to stream progress events. */
    threadId: z.string().min(1),
    /** Stable provisioning lifecycle rendered by streamed progress events. */
    provisioningId: z.string().min(1),
  })
  .strict();

const environmentProvisionCommandBaseSchema =
  hostDaemonEnvironmentTargetSchema.extend({
    type: z.literal("environment.provision"),
    /** Initiating thread for live progress streaming. Null when no thread is associated (e.g., project source provisioning). */
    initiator: provisionInitiatorSchema.nullable(),
  });

/**
 * Pre-provision checkout for unmanaged workspaces. The server resolves the
 * branch name (including server-minted names for the `new` case) before
 * sending — daemon just runs the corresponding git checkout.
 */
const unmanagedCheckoutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), name: z.string().min(1) }),
  z.object({ kind: z.literal("new"), name: z.string().min(1) }),
]);

const unmanagedEnvironmentProvisionCommandSchema =
  environmentProvisionCommandBaseSchema.extend({
    workspaceProvisionType: z.literal("unmanaged"),
    /** Path to validate */
    path: z.string().min(1),
    /** When set, the daemon checks out this branch before opening the workspace. */
    checkout: unmanagedCheckoutSchema.optional(),
  });

const managedEnvironmentProvisionFieldsSchema = z.object({
  /** Source repo path */
  sourcePath: z.string().min(1),
  /** Target path for worktree/clone creation */
  targetPath: z.string().min(1),
  /** Name of the new branch the daemon should create for this environment. */
  branchName: z.string().min(1),
  /**
   * Branch on the source repo that the new branch should be based on. Pass
   * `null` to use the source's default branch (resolved by the daemon).
   */
  baseBranch: z.string().min(1).nullable(),
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
 * Lane-serialized per environmentId. Git worktree metadata mutations are
 * protected by the workspace implementation.
 */
export const environmentProvisionCommandSchema = z.discriminatedUnion(
  "workspaceProvisionType",
  [
    unmanagedEnvironmentProvisionCommandSchema,
    managedWorktreeEnvironmentProvisionCommandSchema,
    managedCloneEnvironmentProvisionCommandSchema,
  ],
);
export type EnvironmentProvisionCommand = z.infer<
  typeof environmentProvisionCommandSchema
>;

export const environmentDestroyCommandSchema =
  hostDaemonWorkspaceTargetSchema.extend({
    type: z.literal("environment.destroy"),
  });

export const workspaceStatusCommandSchema =
  hostDaemonWorkspaceTargetSchema.extend({
    type: z.literal("workspace.status"),
    mergeBaseBranch: z.string().min(1).optional(),
  });

export const workspaceDiffCommandSchema =
  hostDaemonWorkspaceTargetSchema.extend({
    type: z.literal("workspace.diff"),
    target: workspaceDiffTargetSchema,
    maxDiffBytes: z.number().int().positive(),
    maxFileListBytes: z.number().int().positive(),
  });

export const workspaceCommitCommandSchema =
  hostDaemonWorkspaceTargetSchema.extend({
    type: z.literal("workspace.commit"),
    message: z.string().min(1),
  });

export const workspaceSquashMergeCommandSchema =
  hostDaemonWorkspaceTargetSchema.extend({
    type: z.literal("workspace.squash_merge"),
    targetBranch: z.string().min(1),
    commitMessage: z.string().min(1),
  });

const hostDaemonNonProvisionCommandSchema = z.discriminatedUnion("type", [
  threadStartCommandSchema,
  turnSubmitCommandSchema,
  threadStopCommandSchema,
  threadRenameCommandSchema,
  threadArchiveCommandSchema,
  threadUnarchiveCommandSchema,
  threadDeletedCommandSchema,
  replayCaptureListCommandSchema,
  replayCaptureGetCommandSchema,
  replayCaptureDeleteCommandSchema,
  replayRunCommandSchema,
  interactiveResolveCommandSchema,
  hostSyncRuntimeMaterialCommandSchema,
  hostListFilesCommandSchema,
  hostListBranchesCommandSchema,
  hostReadFileCommandSchema,
  providerListCommandSchema,
  providerListModelsCommandSchema,
  environmentDestroyCommandSchema,
  workspaceStatusCommandSchema,
  workspaceDiffCommandSchema,
  workspaceCommitCommandSchema,
  workspaceSquashMergeCommandSchema,
]);
export const hostDaemonCommandSchema = z.union([
  hostDaemonNonProvisionCommandSchema,
  environmentProvisionCommandSchema,
]);
export type HostDaemonCommand = z.infer<typeof hostDaemonCommandSchema>;

export function shouldFlushEventsBeforeReportingCommandResult(
  command: HostDaemonCommand,
): boolean {
  switch (command.type) {
    case "thread.start":
    case "turn.submit":
    case "thread.stop":
    case "interactive.resolve":
      return true;
    case "environment.provision":
      return command.initiator !== null;
    case "environment.destroy":
    case "host.list_branches":
    case "host.list_files":
    case "host.read_file":
    case "host.sync_runtime_material":
    case "provider.list":
    case "provider.list_models":
    case "replay.capture_delete":
    case "replay.capture_get":
    case "replay.capture_list":
    case "replay.run":
    case "thread.deleted":
    case "thread.archive":
    case "thread.rename":
    case "thread.unarchive":
    case "workspace.commit":
    case "workspace.diff":
    case "workspace.squash_merge":
    case "workspace.status":
      return false;
  }
}

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
  "turn.submit": z.object({
    appliedAs: z.enum(["new-turn", "steer"]),
  }),
  "thread.stop": z.object({}),
  "thread.rename": z.object({}),
  "thread.archive": z.object({}),
  "thread.unarchive": z.object({}),
  "thread.deleted": z.object({}),
  "replay.capture_list": replayCaptureDaemonListResponseSchema,
  "replay.capture_get": replayCaptureManifestSchema,
  "replay.capture_delete": z.object({}),
  "replay.run": z.object({}),
  "interactive.resolve": z.object({}),
  "host.sync_runtime_material": z.object({
    appliedVersion: z.string().min(1),
  }),
  "host.list_files": fileListResultSchema,
  "host.list_branches": z.object({
    branches: z.array(z.string()),
    /** HEAD of the primary checkout at `path`. Null when the path is not a git repo. */
    current: z.string().nullable(),
    /** Repo's tracked default branch (origin/HEAD or `init.defaultBranch`). Null when unknown. */
    defaultBranch: z.string().nullable(),
  }),
  "host.read_file": fileReadResultSchema,
  "provider.list": z.object({
    providers: z.array(providerInfoSchema),
  }),
  "provider.list_models": z.object({
    models: z.array(availableModelSchema),
    selectedOnlyModels: z.array(availableModelSchema),
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
    commitSubject: z.string().min(1),
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
type HostDaemonCommandResultReportBase = z.infer<
  typeof hostDaemonCommandResultReportBaseSchema
>;
type HostDaemonCommandSuccessResultReportByType = {
  [TType in HostDaemonCommandType]: HostDaemonCommandResultReportBase & {
    type: TType;
    ok: true;
    result: HostDaemonCommandResult<TType>;
  };
};
type HostDaemonCommandSuccessResultReport =
  HostDaemonCommandSuccessResultReportByType[HostDaemonCommandType];
type HostDaemonKnownCommandErrorResultReportByType = {
  [TType in HostDaemonCommandType]: HostDaemonCommandResultReportBase & {
    type: TType;
    ok: false;
    errorCode: string;
    errorMessage: string;
  };
};
type HostDaemonUnknownCommandErrorResultReport =
  HostDaemonCommandResultReportBase & {
    type: string;
    ok: false;
    errorCode: string;
    errorMessage: string;
  };
type HostDaemonCommandErrorResultReport =
  | HostDaemonKnownCommandErrorResultReportByType[HostDaemonCommandType]
  | HostDaemonUnknownCommandErrorResultReport;
export type HostDaemonKnownCommandResultReport =
  | HostDaemonCommandSuccessResultReport
  | HostDaemonKnownCommandErrorResultReportByType[HostDaemonCommandType];
type HostDaemonCommandErrorResultReportWithoutSession = Omit<
  HostDaemonCommandErrorResultReport,
  "sessionId"
>;
type HostDaemonCommandSuccessResultReportWithoutSession = Omit<
  HostDaemonCommandResultReportBase,
  "sessionId"
> & {
  type: HostDaemonCommandType;
  ok: true;
  result: HostDaemonCommandResult;
};
export type HostDaemonCommandResultReport =
  | HostDaemonCommandSuccessResultReport
  | HostDaemonCommandErrorResultReport;
export type HostDaemonCommandResultReportWithoutSession =
  | HostDaemonCommandSuccessResultReportWithoutSession
  | HostDaemonCommandErrorResultReportWithoutSession;

export function isKnownHostDaemonCommandResultReport(
  report: HostDaemonCommandResultReport,
): report is HostDaemonKnownCommandResultReport {
  return isHostDaemonCommandType(report.type);
}

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

function createKnownHostDaemonCommandResultReportSchemaForType<
  TType extends HostDaemonCommandType,
>(type: TType) {
  return z.discriminatedUnion(
    "ok",
    createHostDaemonCommandResultReportSchemasForType(
      type,
      hostDaemonCommandResultSchemaByType[type],
    ),
  );
}

/** Catch-all schema for reporting errors on command types the daemon doesn't recognize. */
const unknownCommandErrorSchema =
  hostDaemonCommandResultReportBaseSchema.extend({
    type: z.string().min(1),
    ok: z.literal(false),
    errorCode: z.literal("unknown_command"),
    errorMessage: z.string().min(1),
  });
const hostDaemonCommandResultReportEnvelopeSchema =
  hostDaemonCommandResultReportBaseSchema.extend({
    type: z.string().min(1),
    ok: z.boolean(),
  });
const knownHostDaemonCommandResultReportSchemasByType = new Map(
  HOST_DAEMON_COMMAND_TYPES.map((type) => [
    type,
    createKnownHostDaemonCommandResultReportSchemaForType(type),
  ]),
);

/**
 * Result report union sent from the daemon back to the server.
 *
 * Success reports (`ok: true`) include the typed result for the command type.
 * Error reports (`ok: false`) include `errorCode` and `errorMessage`.
 * Unknown command types use errorCode `"unknown_command"`.
 */
export const hostDaemonCommandResultReportSchema =
  z.custom<HostDaemonCommandResultReport>((value) => {
    const envelope =
      hostDaemonCommandResultReportEnvelopeSchema.safeParse(value);
    if (!envelope.success) {
      return false;
    }
    if (!isHostDaemonCommandType(envelope.data.type)) {
      return unknownCommandErrorSchema.safeParse(value).success;
    }
    const schema = knownHostDaemonCommandResultReportSchemasByType.get(
      envelope.data.type,
    );
    if (!schema) {
      return false;
    }
    return schema.safeParse(value).success;
  });
