import {
  desktopBrowserCommandSchemas,
  desktopBrowserResultSchemas,
} from "./desktop-browser.js";
import {
  availableModelSchema,
  discoveredWorkspacePropertiesSchema,
  dynamicToolSchema,
  gitBranchOptionsSchema,
  gitSourceInspectionSchema,
  instructionModeSchema,
  pendingInteractionResolutionSchema,
  permissionModeSchema,
  promptInputSchema,
  providerForkSchema,
  threadGitDiffResponseSchema,
  workspaceProvisionTypeSchema,
  runtimeThreadExecutionOptionsSchema,
  provisioningTranscriptEntrySchema,
  rawDiffFileStatSchema,
  workspaceDiffTargetSchema,
  workspaceStatusSchema,
  gitHostPullRequestSchema,
  clientTurnRequestIdSchema,
  gitBranchNameSchema,
  jsonObjectSchema,
  jsonValueSchema,
  providerNativeRootSetSchema,
  BRANCH_LIST_LIMIT_MAX,
  BRANCH_LIST_QUERY_MAX_LENGTH,
  FILE_LIST_LIMIT_MAX,
  FILE_LIST_QUERY_MAX_LENGTH,
} from "@bb/domain";
import { z } from "zod";
import {
  pathsExistRequestSchema,
  pathsExistResponseSchema,
  pickFolderResponseSchema,
  providerCliInstallEventSchema,
  providerCliInstallActionKindSchema,
} from "./local.js";
import { workspaceResolutionFailureSchema } from "./workspace.js";
import { HOST_ARTIFACT_MAX_BYTES } from "./protocol.js";
import {
  providerHealthSchema,
  providerHealthResultSchema,
  providerInstallationStatusSchema,
  providerUsageResultSchema,
  providerUsageSchema,
  providerUsageWindowSchema,
} from "@bb/provider-bridge-protocol";

export {
  HOST_ARTIFACT_MAX_BYTES,
  HOST_DAEMON_PROTOCOL_VERSION,
} from "./protocol.js";
export {
  workspaceResolutionFailureCodeSchema,
  workspaceResolutionFailureSchema,
  type WorkspaceResolutionFailure,
  type WorkspaceResolutionFailureCode,
} from "./workspace.js";

export {
  BRANCH_LIST_LIMIT_MAX,
  BRANCH_LIST_QUERY_MAX_LENGTH,
  FILE_LIST_LIMIT_MAX,
  FILE_LIST_QUERY_MAX_LENGTH,
} from "@bb/domain";
const INJECTED_SKILL_NAME_PATTERN =
  /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export const workspaceContextSchema = z.object({
  workspacePath: z.string().min(1),
  workspaceProvisionType: workspaceProvisionTypeSchema,
});
export type WorkspaceContext = z.infer<typeof workspaceContextSchema>;

function isConnectBaseDomain(value: string): boolean {
  try {
    const parsed = new URL(`https://${value}`);
    return (
      parsed.host === value &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

export const hostDaemonConnectTunnelIdentitySchema = z
  .object({
    label: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
      .refine((label) => !label.includes("--")),
    baseDomain: z.string().min(1).refine(isConnectBaseDomain),
  })
  .strict();
export type HostDaemonConnectTunnelIdentity = z.infer<
  typeof hostDaemonConnectTunnelIdentitySchema
>;

const hostDaemonThreadTargetSchema = z
  .object({
    environmentId: z.string().min(1),
    threadId: z.string().min(1),
  })
  .strict();

const hostDaemonInjectedSkillSourceBaseSchema = z
  .object({
    name: z.string().max(64).regex(INJECTED_SKILL_NAME_PATTERN),
    description: z.string().min(1).max(1024),
  })
  .strict();

export const hostDaemonInjectedSkillSourceSchema = z.discriminatedUnion(
  "kind",
  [
    hostDaemonInjectedSkillSourceBaseSchema
      .extend({
        kind: z.literal("tree"),
        treeHash: z.string().regex(/^[a-f0-9]{64}$/u),
        entryPath: z.string().min(1),
        sourceType: z.enum(["builtin", "data-dir"]),
      })
      .strict(),
    hostDaemonInjectedSkillSourceBaseSchema
      .extend({
        kind: z.literal("workspace-path"),
        sourceType: z.literal("project"),
        sourceRootPath: z.string().min(1),
        skillFilePath: z.string().min(1),
      })
      .strict(),
    hostDaemonInjectedSkillSourceBaseSchema
      .extend({
        kind: z.literal("host-path"),
        sourceType: z.enum(["shared-user", "shared-project"]),
        sourceRootPath: z.string().min(1),
        skillFilePath: z.string().min(1),
      })
      .strict(),
  ],
);
export type HostDaemonInjectedSkillSource = z.infer<
  typeof hostDaemonInjectedSkillSourceSchema
>;

const hostDaemonBridgeLaunchSchema = z
  .object({
    pluginId: z.string().min(1),
    source: z
      .object({
        kind: z.literal("artifact"),
        digest: z.string().regex(/^[a-f0-9]{64}$/u),
        byteLength: z.number().int().positive().max(HOST_ARTIFACT_MAX_BYTES),
      })
      .strict(),
    capabilities: z
      .object({
        providerInstallation: z.boolean(),
        supportsServiceTier: z.boolean(),
        permissionModes: z.array(permissionModeSchema).min(1),
        supportsThreadArchive: z.boolean(),
        supportsThreadRename: z.boolean(),
        fork: providerForkSchema,
      })
      .strict(),
    providerOptions: jsonObjectSchema,
    envPassthrough: z.array(z.string().min(1)),
  })
  .strict();
export type HostDaemonBridgeLaunch = z.infer<
  typeof hostDaemonBridgeLaunchSchema
>;

export const hostDaemonContributedEnvEntrySchema = z
  .object({
    name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
    value: z.union([
      z.string(),
      z.object({ serverPath: z.string().startsWith("/") }).strict(),
    ]),
    source: z.object({ plugin: z.string().min(1) }).strict(),
    reason: z.string(),
    secret: z.boolean(),
  })
  .strict();
export type HostDaemonContributedEnvEntry = z.infer<
  typeof hostDaemonContributedEnvEntrySchema
>;

const hostDaemonThreadRuntimeContextSchema = z
  .object({
    workspaceContext: workspaceContextSchema,
    projectId: z.string().min(1),
    providerId: z.string().min(1),
    bridgeLaunch: hostDaemonBridgeLaunchSchema,
    options: runtimeThreadExecutionOptionsSchema,
    instructions: z.string().min(1),
    dynamicTools: z.array(dynamicToolSchema),
    contributedEnv: z.array(hostDaemonContributedEnvEntrySchema).default([]),
    injectedSkillSources: z.array(hostDaemonInjectedSkillSourceSchema),
    disallowedTools: z.array(z.string()).optional(),
    instructionMode: instructionModeSchema,
  })
  .strict();

const hostDaemonExistingThreadRuntimeContextSchema =
  hostDaemonThreadRuntimeContextSchema.extend({
    providerThreadId: z.string().min(1),
  });

const turnResumeContextSchema =
  hostDaemonExistingThreadRuntimeContextSchema.omit({
    options: true,
  });

const hostDaemonEnvironmentTargetSchema = z
  .object({
    environmentId: z.string().min(1),
  })
  .strict();

const hostDaemonWorkspaceTargetSchema =
  hostDaemonEnvironmentTargetSchema.extend({
    workspaceContext: workspaceContextSchema,
  });

const hostDaemonThreadWorkspaceTargetSchema =
  hostDaemonThreadTargetSchema.extend({
    workspaceContext: workspaceContextSchema,
  });

type HostDaemonPromptInput = z.infer<typeof promptInputSchema>;

interface GroupedPromptInputCommand {
  input: HostDaemonPromptInput[];
  inputGroups?: HostDaemonPromptInput[][];
}

function flattenPromptInputGroups(
  inputGroups: readonly HostDaemonPromptInput[][],
): HostDaemonPromptInput[] {
  return inputGroups.flatMap((inputGroup, index) =>
    index === 0
      ? inputGroup
      : [{ type: "text" as const, text: "\n\n", mentions: [] }, ...inputGroup],
  );
}

function refineGroupedInputMatchesFlatInput(
  value: GroupedPromptInputCommand,
  ctx: z.RefinementCtx,
): void {
  if (value.inputGroups === undefined) return;
  if (
    JSON.stringify(value.input) ===
    JSON.stringify(flattenPromptInputGroups(value.inputGroups))
  ) {
    return;
  }

  ctx.addIssue({
    code: "custom",
    message: "input must match the flattened inputGroups",
    path: ["inputGroups"],
  });
}

const threadStartCommandSchema = hostDaemonThreadTargetSchema
  .merge(hostDaemonThreadRuntimeContextSchema)
  .extend({
    type: z.literal("thread.start"),
    requestId: clientTurnRequestIdSchema,
    input: z.array(promptInputSchema),
    inputGroups: z.array(z.array(promptInputSchema).min(1)).min(1).optional(),
    threadStoragePath: z.string().min(1).optional(),
    fork: z
      .object({
        sourceProviderThreadId: z.string().min(1),
        sourceProviderCheckpointId: z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.fork === undefined && value.input.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "input must contain at least one entry",
        path: ["input"],
      });
    }
    refineGroupedInputMatchesFlatInput(value, ctx);
  });

const threadRewindPrepareCommandSchema = hostDaemonThreadTargetSchema
  .merge(hostDaemonThreadRuntimeContextSchema)
  .extend({
    type: z.literal("thread.rewind.prepare"),
    leaseId: z.string().min(1),
    sourceProviderThreadId: z.string().min(1),
    retainThroughProviderCheckpoint: z.string().min(1),
  })
  .strict();

const threadRewindDiscardCommandSchema = hostDaemonThreadTargetSchema
  .extend({
    type: z.literal("thread.rewind.discard"),
    leaseId: z.string().min(1),
  })
  .strict();

const turnSubmitTargetSchema = z.discriminatedUnion("mode", [
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

const turnSubmitCommandSchema = hostDaemonThreadTargetSchema
  .extend({
    type: z.literal("turn.submit"),
    requestId: clientTurnRequestIdSchema,
    input: z.array(promptInputSchema).min(1),
    inputGroups: z.array(z.array(promptInputSchema).min(1)).min(1).optional(),
    options: runtimeThreadExecutionOptionsSchema,
    bridgeLaunch: hostDaemonBridgeLaunchSchema,
    resumeContext: turnResumeContextSchema,
    target: turnSubmitTargetSchema,
  })
  .strict()
  .superRefine(refineGroupedInputMatchesFlatInput);

const threadStopIntentSchema = z.enum(["interrupt", "release"]);

export type ThreadStopIntent = z.infer<typeof threadStopIntentSchema>;

export const threadStopCommandSchema = hostDaemonThreadTargetSchema
  .extend({
    type: z.literal("thread.stop"),
    intent: threadStopIntentSchema,
  })
  .strict();

const threadGoalClearCommandSchema = hostDaemonThreadTargetSchema
  .extend({
    type: z.literal("thread.goal.clear"),
    options: runtimeThreadExecutionOptionsSchema,
    bridgeLaunch: hostDaemonBridgeLaunchSchema,
    resumeContext: turnResumeContextSchema,
  })
  .strict();

const threadPlanCancelCommandSchema = hostDaemonThreadTargetSchema
  .extend({
    type: z.literal("thread.plan.cancel"),
    expectedTurnId: z.string().min(1),
  })
  .strict();

const threadRenameCommandSchema = hostDaemonThreadTargetSchema
  .extend({
    type: z.literal("thread.rename"),
    title: z.string().min(1),
  })
  .strict();

const threadArchiveCommandSchema = hostDaemonThreadWorkspaceTargetSchema
  .extend({
    type: z.literal("thread.archive"),
    providerId: z.string().min(1),
    providerThreadId: z.string().min(1),
    bridgeLaunch: hostDaemonBridgeLaunchSchema,
  })
  .strict();

const threadUnarchiveCommandSchema = hostDaemonThreadTargetSchema
  .extend({
    type: z.literal("thread.unarchive"),
    providerId: z.string().min(1),
    providerThreadId: z.string().min(1),
    bridgeLaunch: hostDaemonBridgeLaunchSchema,
  })
  .strict();

const interactiveResolveCommandSchema = hostDaemonThreadTargetSchema
  .extend({
    type: z.literal("interactive.resolve"),
    interactionId: z.string().min(1),
    providerId: z.string().min(1),
    providerThreadId: z.string().min(1),
    providerRequestId: z.string().min(1),
    resolution: pendingInteractionResolutionSchema,
  })
  .strict();

const hostReadFileCommandSchema = z
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

const hostReadFileRelativeDotfilePolicySchema = z.enum(["allow", "deny"]);
export type HostReadFileRelativeDotfilePolicy = z.infer<
  typeof hostReadFileRelativeDotfilePolicySchema
>;

const hostReadFileRelativeCommandSchema = z
  .object({
    type: z.literal("host.read_file_relative"),
    rootPath: z.string().min(1),
    path: z.string().min(1),
    dotfiles: hostReadFileRelativeDotfilePolicySchema,
  })
  .strict();

const hostFileMetadataCommandSchema = z
  .object({
    type: z.literal("host.file_metadata"),
    path: z.string().min(1),
    rootPath: z.string().min(1).optional(),
  })
  .strict();

const hostWriteFileCommandSchema = z
  .object({
    type: z.literal("host.write_file"),
    path: z.string().min(1),
    rootPath: z.string().min(1).optional(),
    content: z.string(),
    contentEncoding: z.enum(["utf8", "base64"]),
    createParents: z.boolean(),
    expectedSha256: z.string().nullable().optional(),
    mode: z.number().int().min(0).max(0o777).optional(),
  })
  .strict();

const hostListFilesCommandSchema = z.object({
  type: z.literal("host.list_files"),
  path: z.string().min(1),
  query: z.string().max(FILE_LIST_QUERY_MAX_LENGTH).optional(),
  limit: z.number().int().positive().max(FILE_LIST_LIMIT_MAX),
});

const hostPathEntryKindSchema = z.enum(["file", "directory"]);
export type HostPathEntryKind = z.infer<typeof hostPathEntryKindSchema>;

const hostPathEntrySchema = z.object({
  kind: hostPathEntryKindSchema,
  path: z.string(),
  name: z.string(),
  score: z.number(),
  positions: z.array(z.number().int().nonnegative()),
});
export type HostPathEntry = z.infer<typeof hostPathEntrySchema>;

const hostListPathsCommandSchema = z
  .object({
    type: z.literal("host.list_paths"),
    path: z.string().min(1),
    query: z.string().max(FILE_LIST_QUERY_MAX_LENGTH).optional(),
    limit: z.number().int().positive().max(FILE_LIST_LIMIT_MAX),
    includeFiles: z.boolean(),
    includeDirectories: z.boolean(),
  })
  .refine((command) => command.includeFiles || command.includeDirectories, {
    message: "At least one path kind must be included",
  });

const hostMkdirCommandSchema = z
  .object({
    type: z.literal("host.mkdir"),
    path: z.string().min(1),
    rootPath: z.string().min(1).optional(),
    recursive: z.boolean(),
  })
  .strict();

const hostMovePathCommandSchema = z
  .object({
    type: z.literal("host.move_path"),
    sourcePath: z.string().min(1),
    destinationPath: z.string().min(1),
    rootPath: z.string().min(1).optional(),
  })
  .strict();

const hostRemovePathCommandSchema = z
  .object({
    type: z.literal("host.remove_path"),
    path: z.string().min(1),
    rootPath: z.string().min(1).optional(),
    recursive: z.boolean(),
  })
  .strict();

const hostBrowseDirectoryCommandSchema = z.object({
  type: z.literal("host.browse_directory"),
  path: z.string().min(1).optional(),
});

const hostPathsExistCommandSchema = pathsExistRequestSchema
  .extend({
    type: z.literal("host.paths_exist"),
  })
  .strict();

const projectInspectCommandSchema = z
  .object({
    type: z.literal("project.inspect"),
    path: z.string().min(1),
  })
  .strict();

const projectCloneDefaultPathCommandSchema = z
  .object({
    type: z.literal("project.clone_default_path"),
    projectSlug: z.string().min(1),
  })
  .strict();

const projectCloneCommandSchema = z
  .object({
    type: z.literal("project.clone"),
    remoteUrl: z.string().min(1),
    projectSlug: z.string().min(1),
    targetPath: z.string().min(1).optional(),
  })
  .strict();

const hostPickFolderCommandSchema = z
  .object({
    type: z.literal("host.pick_folder"),
  })
  .strict();

const pluginHostArtifactSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
    byteLength: z.number().int().positive().max(HOST_ARTIFACT_MAX_BYTES),
  })
  .strict();

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

const pluginHostCallCommandSchema = z
  .object({
    type: z.literal("plugin.host.call"),
    pluginId: z.string().min(1),
    generation: z.string().min(1),
    artifact: pluginHostArtifactSchema,
    callId: z.string().min(1),
    method: z.string().min(1),
    input: jsonValueSchema,
    timeoutMs: z.number().int().positive().max(MAX_NODE_TIMER_DELAY_MS),
  })
  .strict();

const pluginHostCancelCommandSchema = z
  .object({
    type: z.literal("plugin.host.cancel"),
    pluginId: z.string().min(1),
    generation: z.string().min(1),
    callId: z.string().min(1),
  })
  .strict();

const pluginHostDisposeCommandSchema = z
  .object({
    type: z.literal("plugin.host.dispose"),
    pluginId: z.string().min(1),
    generation: z.string().min(1),
  })
  .strict();

const connectTunnelEnsureIdentityCommandSchema = z
  .object({
    type: z.literal("connect-tunnel.ensure-identity"),
  })
  .strict();

const directoryEntrySchema = z.object({
  kind: hostPathEntryKindSchema,
  name: z.string(),
  path: z.string(),
});
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

const directoryListingSchema = z.object({
  directory: z.string(),
  parent: z.string().nullable(),
  entries: z.array(directoryEntrySchema),
});

const hostCommandSourceSchema = z.enum(["skill", "command"]);
export type HostCommandSource = z.infer<typeof hostCommandSourceSchema>;

const hostCommandOriginSchema = z.enum(["project", "user"]);
export type HostCommandOrigin = z.infer<typeof hostCommandOriginSchema>;

const hostProviderCommandSchema = z.object({
  name: z.string(),
  source: hostCommandSourceSchema,
  origin: hostCommandOriginSchema,
  description: z.string().nullable(),
  argumentHint: z.string().nullable(),
});
export type HostProviderCommand = z.infer<typeof hostProviderCommandSchema>;

const hostListCommandsCommandSchema = z
  .object({
    type: z.literal("host.list_commands"),
    providerId: z.string().min(1),
    cwd: z.string().min(1).nullable(),
    nativeRoots: providerNativeRootSetSchema,
  })
  .strict();

const skillRootKindSchema = z.enum([
  "bb-project",
  "bb-data-dir",
  "bb-builtin",
  "provider-project",
  "provider-user",
  "shared-project",
  "shared-user",
  "plugin",
]);
export type SkillRootKind = z.infer<typeof skillRootKindSchema>;

const discoveredSkillSchema = z.object({
  id: z.string().regex(/^skill_[a-f0-9]{64}$/u),
  name: z.string(),
  description: z.string().nullable(),
  filePath: z.string(),
  rootKind: skillRootKindSchema,
  linked: z.boolean(),
});
export type DiscoveredSkill = z.infer<typeof discoveredSkillSchema>;

const hostListSkillsCommandSchema = z
  .object({
    type: z.literal("host.list_skills"),
    providerId: z.string().min(1),
    cwd: z.string().min(1).nullable(),
    nativeRoots: providerNativeRootSetSchema,
  })
  .strict();

export const deletableSkillScopeSchema = z.enum([
  "bb-user",
  "bb-project",
  "provider-user",
  "provider-project",
]);

const hostDeleteSkillCommandSchema = z
  .object({
    type: z.literal("host.delete_skill"),
    scope: deletableSkillScopeSchema,
    name: z.string().min(1),
    cwd: z.string().min(1).nullable(),
    rootPath: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((command, context) => {
    if (command.scope === "bb-project" && command.cwd === null) {
      context.addIssue({
        code: "custom",
        path: ["cwd"],
        message: "cwd is required to delete a bb-project skill",
      });
    }
    const isBbScope =
      command.scope === "bb-user" || command.scope === "bb-project";
    if (isBbScope && command.rootPath !== null) {
      context.addIssue({
        code: "custom",
        path: ["rootPath"],
        message: "rootPath must be null for a bb skill",
      });
    }
    if (!isBbScope && command.rootPath === null) {
      context.addIssue({
        code: "custom",
        path: ["rootPath"],
        message: "rootPath is required for a provider skill",
      });
    }
  });

const writableBbSkillScopeSchema = z.enum(["bb-user", "bb-project"]);

const hostWriteSkillCommandSchema = z
  .object({
    type: z.literal("host.write_skill"),
    scope: writableBbSkillScopeSchema,
    name: z.string().min(1),
    cwd: z.string().min(1).nullable(),
    content: z.string().min(1).max(1_000_000),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .superRefine((command, context) => {
    if (command.scope === "bb-project" && command.cwd === null) {
      context.addIssue({
        code: "custom",
        path: ["cwd"],
        message: "cwd is required to edit a bb-project skill",
      });
    }
  });

const hostInstallGlobalSkillSchema = z
  .object({
    name: z.string().max(64).regex(INJECTED_SKILL_NAME_PATTERN),
    treeHash: z.string().regex(/^[a-f0-9]{64}$/u),
    entryPath: z.string().min(1),
  })
  .strict();
export type HostInstallGlobalSkill = z.infer<
  typeof hostInstallGlobalSkillSchema
>;

const hostInstallGlobalSkillsCommandSchema = z
  .object({
    type: z.literal("host.install_global_skills"),
    skills: z.array(hostInstallGlobalSkillSchema).min(1).max(64),
  })
  .strict();

const hostGlobalSkillsStatusCommandSchema = z
  .object({
    type: z.literal("host.global_skills_status"),
    names: z
      .array(z.string().max(64).regex(INJECTED_SKILL_NAME_PATTERN))
      .min(1)
      .max(64),
  })
  .strict();

const hostInspectGitSourceCommandSchema = z
  .object({
    type: z.literal("host.inspect_git_source"),
    path: z.string().min(1),
    remoteRefresh: z.enum(["background", "blocking"]),
  })
  .strict();

const hostListBranchOptionsCommandSchema = z
  .object({
    type: z.literal("host.list_branch_options"),
    path: z.string().min(1),
    query: z.string().max(BRANCH_LIST_QUERY_MAX_LENGTH).optional(),
    selectedBranch: gitBranchNameSchema.optional(),
    limit: z.number().int().positive().max(BRANCH_LIST_LIMIT_MAX),
    remoteRefresh: z.enum(["background", "none"]),
  })
  .strict();

const providerListModelsCommandSchema = z.object({
  type: z.literal("provider.list_models"),
  providerId: z.string().min(1),
  bridgeLaunch: hostDaemonBridgeLaunchSchema,
  cwd: z.string().min(1).optional(),
});

const providerHealthCommandSchema = z
  .object({
    type: z.literal("provider.health"),
    providerId: z.string().min(1),
    bridgeLaunch: hostDaemonBridgeLaunchSchema,
    cwd: z.string().min(1).optional(),
  })
  .strict();

const providerInstallationStatusCommandSchema = z
  .object({
    type: z.literal("provider.installation.status"),
    providerId: z.string().min(1),
    bridgeLaunch: hostDaemonBridgeLaunchSchema,
    cwd: z.string().min(1).optional(),
    requirement: z.literal("thread_rewind").optional(),
  })
  .strict();

const providerInstallationRunCommandSchema = z
  .object({
    type: z.literal("provider.installation.run"),
    providerId: z.string().min(1),
    action: providerCliInstallActionKindSchema,
    bridgeLaunch: hostDaemonBridgeLaunchSchema,
    cwd: z.string().min(1).optional(),
  })
  .strict();

export { providerHealthSchema };
export type {
  ProviderHealth,
  ProviderHealthResult,
} from "@bb/provider-bridge-protocol";

const provisionInitiatorSchema = z
  .object({
    threadId: z.string().min(1),
    provisioningId: z.string().min(1),
  })
  .strict();

const environmentProvisionCommandBaseSchema =
  hostDaemonEnvironmentTargetSchema.extend({
    type: z.literal("environment.provision"),
    initiator: provisionInitiatorSchema.nullable(),
  });

const unmanagedCheckoutSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("existing"),
      name: gitBranchNameSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("new"),
      name: gitBranchNameSchema,
      baseBranch: gitBranchNameSchema,
    })
    .strict(),
]);

const unmanagedEnvironmentProvisionCommandSchema =
  environmentProvisionCommandBaseSchema
    .extend({
      workspaceProvisionType: z.literal("unmanaged"),
      path: z.string().min(1),
      checkout: unmanagedCheckoutSchema.optional(),
    })
    .strict();

const managedEnvironmentProvisionFieldsSchema = z.object({
  sourcePath: z.string().min(1),
  targetPath: z.string().min(1),
  branchName: gitBranchNameSchema,
  baseBranch: gitBranchNameSchema.nullable(),
  setupTimeoutMs: z.number().int().positive(),
});

const managedWorktreeEnvironmentProvisionCommandSchema =
  environmentProvisionCommandBaseSchema
    .merge(managedEnvironmentProvisionFieldsSchema)
    .extend({ workspaceProvisionType: z.literal("managed-worktree") })
    .strict();

const personalEnvironmentProvisionCommandSchema =
  environmentProvisionCommandBaseSchema
    .extend({
      workspaceProvisionType: z.literal("personal"),
      targetPath: z.string().min(1),
    })
    .strict();

const environmentProvisionCommandSchema = z.discriminatedUnion(
  "workspaceProvisionType",
  [
    unmanagedEnvironmentProvisionCommandSchema,
    managedWorktreeEnvironmentProvisionCommandSchema,
    personalEnvironmentProvisionCommandSchema,
  ],
);
export type EnvironmentProvisionCommand = z.infer<
  typeof environmentProvisionCommandSchema
>;

const environmentProvisionCancelCommandSchema =
  hostDaemonEnvironmentTargetSchema
    .extend({
      type: z.literal("environment.provision.cancel"),
    })
    .strict();

const environmentDestroyCommandSchema = hostDaemonWorkspaceTargetSchema
  .extend({
    type: z.literal("environment.destroy"),
    /** Maximum time in ms to wait for the teardown script. */
    teardownTimeoutMs: z.number().int().positive(),
  })
  .strict();

const workspaceStatusCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.status"),
  mergeBaseBranch: gitBranchNameSchema.optional(),
  maxUntrackedLineStatFiles: z.number().int().positive(),
  maxUntrackedLineStatBytes: z.number().int().positive(),
});

const workspaceDiffCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.diff"),
  target: workspaceDiffTargetSchema,
  maxDiffBytes: z.number().int().positive(),
  maxFileListBytes: z.number().int().positive(),
  maxUntrackedFiles: z.number().int().positive(),
});

const workspaceDiffFilesCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.diffFiles"),
  target: workspaceDiffTargetSchema,
  maxFiles: z.number().int().positive(),
});

const workspaceDiffPatchCommandSchema = hostDaemonWorkspaceTargetSchema.extend({
  type: z.literal("workspace.diffPatch"),
  target: workspaceDiffTargetSchema,
  paths: z.array(z.string()),
  maxBytesPerFile: z.number().int().positive(),
});

const workspacePullRequestCommandSchema =
  hostDaemonWorkspaceTargetSchema.extend({
    type: z.literal("workspace.pull_request"),
  });

const pullRequestMergeMethodSchema = z.enum(["merge", "squash", "rebase"]);

const workspacePullRequestReadyCommandSchema = hostDaemonWorkspaceTargetSchema
  .extend({
    type: z.literal("workspace.pull_request_action"),
    operation: z.literal("ready"),
  })
  .strict();

const workspacePullRequestDraftCommandSchema = hostDaemonWorkspaceTargetSchema
  .extend({
    type: z.literal("workspace.pull_request_action"),
    operation: z.literal("draft"),
  })
  .strict();

const workspacePullRequestMergeCommandSchema = hostDaemonWorkspaceTargetSchema
  .extend({
    type: z.literal("workspace.pull_request_action"),
    operation: z.literal("merge"),
    method: pullRequestMergeMethodSchema,
  })
  .strict();

const workspacePullRequestActionCommandSchema = z.discriminatedUnion(
  "operation",
  [
    workspacePullRequestReadyCommandSchema,
    workspacePullRequestDraftCommandSchema,
    workspacePullRequestMergeCommandSchema,
  ],
);

const workspaceCommitCommandSchema = hostDaemonWorkspaceTargetSchema
  .extend({
    type: z.literal("workspace.commit"),
    message: z.string().min(1),
  })
  .strict();

const fileReadResultSchema = z.object({
  path: z.string(),
  content: z.string(),
  contentEncoding: z.enum(["base64", "utf8"]),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAtMs: z.number().nonnegative().optional(),
  sha256: z.string(),
});

const fileWriteResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("written"),
      sha256: z.string(),
      sizeBytes: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("conflict"),
      currentSha256: z.string().nullable(),
    })
    .strict(),
]);

const fileMetadataResultSchema = z.object({
  path: z.string(),
  modifiedAtMs: z.number().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
});

const workspaceStatusResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      workspaceStatus: workspaceStatusSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("unavailable"),
      failure: workspaceResolutionFailureSchema,
    })
    .strict(),
]);

const workspaceDiffResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      diff: threadGitDiffResponseSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("unavailable"),
      failure: workspaceResolutionFailureSchema,
    })
    .strict(),
]);

const workspaceDiffFilesResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      files: z.array(rawDiffFileStatSchema),
      shortstat: z.string(),
      mergeBaseRef: z.string().nullable(),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("unavailable"),
      failure: workspaceResolutionFailureSchema,
    })
    .strict(),
]);

const workspaceDiffPatchResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      patches: z.array(
        z
          .object({
            path: z.string(),
            patch: z.string(),
            truncated: z.boolean(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("unavailable"),
      failure: workspaceResolutionFailureSchema,
    })
    .strict(),
]);

const workspacePullRequestResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      pullRequest: gitHostPullRequestSchema,
    })
    .strict(),
  z.object({ outcome: z.literal("absent") }).strict(),
  z
    .object({
      outcome: z.literal("unavailable"),
      message: z.string().min(1),
    })
    .strict(),
]);

const fileListResultSchema = z.object({
  files: z.array(z.object({ path: z.string(), name: z.string() })),
  truncated: z.boolean(),
});

const pathListResultSchema = z.object({
  paths: z.array(hostPathEntrySchema),
  truncated: z.boolean(),
});

const hostPathMutationResultSchema = z.object({ ok: z.literal(true) }).strict();

const pluginHostCallResultSchema = z
  .object({ output: jsonValueSchema })
  .strict();

const pluginHostCancelResultSchema = z
  .object({ cancelled: z.boolean() })
  .strict();

const pluginHostDisposeResultSchema = z
  .object({ disposed: z.boolean() })
  .strict();

const commandListResultSchema = z.object({
  commands: z.array(hostProviderCommandSchema),
});

const skillListResultSchema = z.object({
  skills: z.array(discoveredSkillSchema),
});

const deleteSkillResultSchema = z.object({
  deletedPath: z.string(),
});

const installGlobalSkillsResultSchema = z
  .object({
    installations: z.array(
      z
        .object({
          name: z.string(),
          path: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

const globalSkillsStatusResultSchema = z
  .object({
    entries: z.array(
      z
        .object({
          name: z.string(),
          path: z.string(),
          treeHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type HostGlobalSkillsStatusResult = z.infer<
  typeof globalSkillsStatusResultSchema
>;

const writeSkillResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("written"),
    filePath: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  z.object({
    outcome: z.literal("conflict"),
    currentSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
  }),
]);

const providerListModelsResultSchema = z.object({
  models: z.array(availableModelSchema),
  selectedOnlyModels: z.array(availableModelSchema),
});

const threadStartResultSchema = z.object({
  providerThreadId: z.string().min(1),
});
const turnSubmitResultSchema = z.object({
  appliedAs: z.enum(["new-turn", "steer"]),
});
const threadStopResultSchema = z
  .object({
    providerCheckpointId: z.string().min(1).nullable(),
  })
  .strict();
const emptyCommandResultSchema = z.object({});
const projectPathResultSchema = z.object({ path: z.string().min(1) }).strict();
const projectInspectResultSchema = projectPathResultSchema
  .extend({ gitRemoteUrl: z.string().min(1).nullable() })
  .strict();
const projectCloneResultSchema = projectInspectResultSchema;
const environmentProvisionResultSchema =
  discoveredWorkspacePropertiesSchema.extend({
    transcript: z.array(provisioningTranscriptEntrySchema),
  });
const environmentProvisionCancelResultSchema = z.object({
  aborted: z.boolean(),
});
const environmentDestroyResultSchema = z
  .object({
    transcript: z.array(provisioningTranscriptEntrySchema),
  })
  .strict();
const workspaceCommitResultSchema = z.object({
  commitSha: z.string().min(1),
  commitSubject: z.string().min(1),
});
const workspacePullRequestActionResultSchema = z.object({}).strict();

export { providerUsageWindowSchema };
export type { ProviderUsageWindow } from "@bb/provider-bridge-protocol";

export type {
  ProviderUsage,
  ProviderUsageResult,
} from "@bb/provider-bridge-protocol";

export const providerUsageResponseSchema = z.record(
  z.string().min(1),
  providerUsageSchema,
);
export type ProviderUsageResponse = z.infer<typeof providerUsageResponseSchema>;

const providerUsageCommandSchema = z
  .object({
    type: z.literal("provider.usage"),
    providerId: z.string().min(1),
    bridgeLaunch: hostDaemonBridgeLaunchSchema,
    cwd: z.string().min(1).optional(),
  })
  .strict();

const providerCliInstallResultSchema = z
  .object({
    events: z.array(providerCliInstallEventSchema),
  })
  .strict();

type HostDaemonCommandTransport = "settled" | "onlineRpc";
export type HostDaemonCommandEnvironmentLane = "read" | "write";
type HostDaemonFlushEventsBeforeResult = boolean | "when-initiated";

interface HostDaemonCommandDescriptor<
  Type extends string,
  Schema extends z.ZodTypeAny,
  ResultSchema extends z.ZodTypeAny,
  Transport extends HostDaemonCommandTransport,
  Retryable extends boolean,
> {
  type: Type;
  schema: Schema;
  resultSchema: ResultSchema;
  transport: Transport;
  retryable: Retryable;
  flushEventsBeforeResult: HostDaemonFlushEventsBeforeResult;
  envLane: HostDaemonCommandEnvironmentLane | null;
}

function defineHostDaemonCommandDescriptor<
  const Type extends string,
  Schema extends z.ZodTypeAny,
  ResultSchema extends z.ZodTypeAny,
  const Transport extends HostDaemonCommandTransport,
  const Retryable extends boolean,
>(
  descriptor: HostDaemonCommandDescriptor<
    Type,
    Schema,
    ResultSchema,
    Transport,
    Retryable
  >,
): HostDaemonCommandDescriptor<
  Type,
  Schema,
  ResultSchema,
  Transport,
  Retryable
> {
  return descriptor;
}

export const hostDaemonCommandRegistry = {
  "desktop.browser.list_instances": defineHostDaemonCommandDescriptor({
    type: "desktop.browser.list_instances",
    schema: desktopBrowserCommandSchemas["desktop.browser.list_instances"],
    resultSchema: desktopBrowserResultSchemas["desktop.browser.list_instances"],
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "desktop.browser.list_tabs": defineHostDaemonCommandDescriptor({
    type: "desktop.browser.list_tabs",
    schema: desktopBrowserCommandSchemas["desktop.browser.list_tabs"],
    resultSchema: desktopBrowserResultSchemas["desktop.browser.list_tabs"],
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "desktop.browser.create_tab": defineHostDaemonCommandDescriptor({
    type: "desktop.browser.create_tab",
    schema: desktopBrowserCommandSchemas["desktop.browser.create_tab"],
    resultSchema: desktopBrowserResultSchemas["desktop.browser.create_tab"],
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "desktop.browser.reveal_tab": defineHostDaemonCommandDescriptor({
    type: "desktop.browser.reveal_tab",
    schema: desktopBrowserCommandSchemas["desktop.browser.reveal_tab"],
    resultSchema: desktopBrowserResultSchemas["desktop.browser.reveal_tab"],
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "desktop.browser.close_tab": defineHostDaemonCommandDescriptor({
    type: "desktop.browser.close_tab",
    schema: desktopBrowserCommandSchemas["desktop.browser.close_tab"],
    resultSchema: desktopBrowserResultSchemas["desktop.browser.close_tab"],
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "desktop.browser.capture_tab": defineHostDaemonCommandDescriptor({
    type: "desktop.browser.capture_tab",
    schema: desktopBrowserCommandSchemas["desktop.browser.capture_tab"],
    resultSchema: desktopBrowserResultSchemas["desktop.browser.capture_tab"],
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "desktop.browser.acquire_control": defineHostDaemonCommandDescriptor({
    type: "desktop.browser.acquire_control",
    schema: desktopBrowserCommandSchemas["desktop.browser.acquire_control"],
    resultSchema:
      desktopBrowserResultSchemas["desktop.browser.acquire_control"],
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "desktop.browser.open_connection": defineHostDaemonCommandDescriptor({
    type: "desktop.browser.open_connection",
    schema: desktopBrowserCommandSchemas["desktop.browser.open_connection"],
    resultSchema:
      desktopBrowserResultSchemas["desktop.browser.open_connection"],
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "desktop.browser.release_control": defineHostDaemonCommandDescriptor({
    type: "desktop.browser.release_control",
    schema: desktopBrowserCommandSchemas["desktop.browser.release_control"],
    resultSchema:
      desktopBrowserResultSchemas["desktop.browser.release_control"],
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "thread.rewind.discard": defineHostDaemonCommandDescriptor({
    type: "thread.rewind.discard",
    schema: threadRewindDiscardCommandSchema,
    resultSchema: emptyCommandResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: true,
    envLane: "read",
  }),
  "thread.rewind.prepare": defineHostDaemonCommandDescriptor({
    type: "thread.rewind.prepare",
    schema: threadRewindPrepareCommandSchema,
    resultSchema: threadStartResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: true,
    envLane: "read",
  }),
  "thread.start": defineHostDaemonCommandDescriptor({
    type: "thread.start",
    schema: threadStartCommandSchema,
    resultSchema: threadStartResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: true,
    envLane: "read",
  }),
  "turn.submit": defineHostDaemonCommandDescriptor({
    type: "turn.submit",
    schema: turnSubmitCommandSchema,
    resultSchema: turnSubmitResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: true,
    envLane: "read",
  }),
  "thread.stop": defineHostDaemonCommandDescriptor({
    type: "thread.stop",
    schema: threadStopCommandSchema,
    resultSchema: threadStopResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: true,
    envLane: null,
  }),
  "thread.goal.clear": defineHostDaemonCommandDescriptor({
    type: "thread.goal.clear",
    schema: threadGoalClearCommandSchema,
    resultSchema: z.object({ cleared: z.boolean() }).strict(),
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: true,
    envLane: "read",
  }),
  "thread.plan.cancel": defineHostDaemonCommandDescriptor({
    type: "thread.plan.cancel",
    schema: threadPlanCancelCommandSchema,
    resultSchema: z.object({ cancelled: z.boolean() }).strict(),
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: true,
    envLane: null,
  }),
  "thread.rename": defineHostDaemonCommandDescriptor({
    type: "thread.rename",
    schema: threadRenameCommandSchema,
    resultSchema: emptyCommandResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "thread.archive": defineHostDaemonCommandDescriptor({
    type: "thread.archive",
    schema: threadArchiveCommandSchema,
    resultSchema: emptyCommandResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: "write",
  }),
  "thread.unarchive": defineHostDaemonCommandDescriptor({
    type: "thread.unarchive",
    schema: threadUnarchiveCommandSchema,
    resultSchema: emptyCommandResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: "write",
  }),
  "interactive.resolve": defineHostDaemonCommandDescriptor({
    type: "interactive.resolve",
    schema: interactiveResolveCommandSchema,
    resultSchema: emptyCommandResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: true,
    envLane: null,
  }),
  "environment.provision": defineHostDaemonCommandDescriptor({
    type: "environment.provision",
    schema: environmentProvisionCommandSchema,
    resultSchema: environmentProvisionResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: "when-initiated",
    envLane: "write",
  }),
  "project.clone": defineHostDaemonCommandDescriptor({
    type: "project.clone",
    schema: projectCloneCommandSchema,
    resultSchema: projectCloneResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "environment.provision.cancel": defineHostDaemonCommandDescriptor({
    type: "environment.provision.cancel",
    schema: environmentProvisionCancelCommandSchema,
    resultSchema: environmentProvisionCancelResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: true,
    envLane: null,
  }),
  "environment.destroy": defineHostDaemonCommandDescriptor({
    type: "environment.destroy",
    schema: environmentDestroyCommandSchema,
    resultSchema: environmentDestroyResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: "write",
  }),
  "workspace.commit": defineHostDaemonCommandDescriptor({
    type: "workspace.commit",
    schema: workspaceCommitCommandSchema,
    resultSchema: workspaceCommitResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: "write",
  }),
  "workspace.pull_request_action": defineHostDaemonCommandDescriptor({
    type: "workspace.pull_request_action",
    schema: workspacePullRequestActionCommandSchema,
    resultSchema: workspacePullRequestActionResultSchema,
    transport: "settled",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: "write",
  }),
  "host.list_files": defineHostDaemonCommandDescriptor({
    type: "host.list_files",
    schema: hostListFilesCommandSchema,
    resultSchema: fileListResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.list_paths": defineHostDaemonCommandDescriptor({
    type: "host.list_paths",
    schema: hostListPathsCommandSchema,
    resultSchema: pathListResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.mkdir": defineHostDaemonCommandDescriptor({
    type: "host.mkdir",
    schema: hostMkdirCommandSchema,
    resultSchema: hostPathMutationResultSchema,
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.move_path": defineHostDaemonCommandDescriptor({
    type: "host.move_path",
    schema: hostMovePathCommandSchema,
    resultSchema: hostPathMutationResultSchema,
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.remove_path": defineHostDaemonCommandDescriptor({
    type: "host.remove_path",
    schema: hostRemovePathCommandSchema,
    resultSchema: hostPathMutationResultSchema,
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.browse_directory": defineHostDaemonCommandDescriptor({
    type: "host.browse_directory",
    schema: hostBrowseDirectoryCommandSchema,
    resultSchema: directoryListingSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.paths_exist": defineHostDaemonCommandDescriptor({
    type: "host.paths_exist",
    schema: hostPathsExistCommandSchema,
    resultSchema: pathsExistResponseSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "project.inspect": defineHostDaemonCommandDescriptor({
    type: "project.inspect",
    schema: projectInspectCommandSchema,
    resultSchema: projectInspectResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "project.clone_default_path": defineHostDaemonCommandDescriptor({
    type: "project.clone_default_path",
    schema: projectCloneDefaultPathCommandSchema,
    resultSchema: projectPathResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.pick_folder": defineHostDaemonCommandDescriptor({
    type: "host.pick_folder",
    schema: hostPickFolderCommandSchema,
    resultSchema: pickFolderResponseSchema,
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "plugin.host.call": defineHostDaemonCommandDescriptor({
    type: "plugin.host.call",
    schema: pluginHostCallCommandSchema,
    resultSchema: pluginHostCallResultSchema,
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "plugin.host.cancel": defineHostDaemonCommandDescriptor({
    type: "plugin.host.cancel",
    schema: pluginHostCancelCommandSchema,
    resultSchema: pluginHostCancelResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "plugin.host.dispose": defineHostDaemonCommandDescriptor({
    type: "plugin.host.dispose",
    schema: pluginHostDisposeCommandSchema,
    resultSchema: pluginHostDisposeResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "connect-tunnel.ensure-identity": defineHostDaemonCommandDescriptor({
    type: "connect-tunnel.ensure-identity",
    schema: connectTunnelEnsureIdentityCommandSchema,
    resultSchema: hostDaemonConnectTunnelIdentitySchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.list_commands": defineHostDaemonCommandDescriptor({
    type: "host.list_commands",
    schema: hostListCommandsCommandSchema,
    resultSchema: commandListResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.list_skills": defineHostDaemonCommandDescriptor({
    type: "host.list_skills",
    schema: hostListSkillsCommandSchema,
    resultSchema: skillListResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.delete_skill": defineHostDaemonCommandDescriptor({
    type: "host.delete_skill",
    schema: hostDeleteSkillCommandSchema,
    resultSchema: deleteSkillResultSchema,
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.write_skill": defineHostDaemonCommandDescriptor({
    type: "host.write_skill",
    schema: hostWriteSkillCommandSchema,
    resultSchema: writeSkillResultSchema,
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.install_global_skills": defineHostDaemonCommandDescriptor({
    type: "host.install_global_skills",
    schema: hostInstallGlobalSkillsCommandSchema,
    resultSchema: installGlobalSkillsResultSchema,
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.global_skills_status": defineHostDaemonCommandDescriptor({
    type: "host.global_skills_status",
    schema: hostGlobalSkillsStatusCommandSchema,
    resultSchema: globalSkillsStatusResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.inspect_git_source": defineHostDaemonCommandDescriptor({
    type: "host.inspect_git_source",
    schema: hostInspectGitSourceCommandSchema,
    resultSchema: gitSourceInspectionSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.list_branch_options": defineHostDaemonCommandDescriptor({
    type: "host.list_branch_options",
    schema: hostListBranchOptionsCommandSchema,
    resultSchema: gitBranchOptionsSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.file_metadata": defineHostDaemonCommandDescriptor({
    type: "host.file_metadata",
    schema: hostFileMetadataCommandSchema,
    resultSchema: fileMetadataResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.read_file": defineHostDaemonCommandDescriptor({
    type: "host.read_file",
    schema: hostReadFileCommandSchema,
    resultSchema: fileReadResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.read_file_relative": defineHostDaemonCommandDescriptor({
    type: "host.read_file_relative",
    schema: hostReadFileRelativeCommandSchema,
    resultSchema: fileReadResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "host.write_file": defineHostDaemonCommandDescriptor({
    type: "host.write_file",
    schema: hostWriteFileCommandSchema,
    resultSchema: fileWriteResultSchema,
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "provider.list_models": defineHostDaemonCommandDescriptor({
    type: "provider.list_models",
    schema: providerListModelsCommandSchema,
    resultSchema: providerListModelsResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "provider.health": defineHostDaemonCommandDescriptor({
    type: "provider.health",
    schema: providerHealthCommandSchema,
    resultSchema: providerHealthResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "provider.installation.status": defineHostDaemonCommandDescriptor({
    type: "provider.installation.status",
    schema: providerInstallationStatusCommandSchema,
    resultSchema: providerInstallationStatusSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "provider.installation.run": defineHostDaemonCommandDescriptor({
    type: "provider.installation.run",
    schema: providerInstallationRunCommandSchema,
    resultSchema: providerCliInstallResultSchema,
    transport: "onlineRpc",
    retryable: false,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "provider.usage": defineHostDaemonCommandDescriptor({
    type: "provider.usage",
    schema: providerUsageCommandSchema,
    resultSchema: providerUsageResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
  "workspace.status": defineHostDaemonCommandDescriptor({
    type: "workspace.status",
    schema: workspaceStatusCommandSchema,
    resultSchema: workspaceStatusResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: "read",
  }),
  "workspace.diff": defineHostDaemonCommandDescriptor({
    type: "workspace.diff",
    schema: workspaceDiffCommandSchema,
    resultSchema: workspaceDiffResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: "read",
  }),
  "workspace.diffFiles": defineHostDaemonCommandDescriptor({
    type: "workspace.diffFiles",
    schema: workspaceDiffFilesCommandSchema,
    resultSchema: workspaceDiffFilesResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: "read",
  }),
  "workspace.diffPatch": defineHostDaemonCommandDescriptor({
    type: "workspace.diffPatch",
    schema: workspaceDiffPatchCommandSchema,
    resultSchema: workspaceDiffPatchResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: "read",
  }),
  "workspace.pull_request": defineHostDaemonCommandDescriptor({
    type: "workspace.pull_request",
    schema: workspacePullRequestCommandSchema,
    resultSchema: workspacePullRequestResultSchema,
    transport: "onlineRpc",
    retryable: true,
    flushEventsBeforeResult: false,
    envLane: null,
  }),
};

type HostDaemonCommandRegistry = typeof hostDaemonCommandRegistry;
type AnyHostDaemonCommandDescriptor =
  HostDaemonCommandRegistry[keyof HostDaemonCommandRegistry];
type HostDaemonCommandDescriptorForTransport<
  Transport extends HostDaemonCommandTransport,
> = Extract<AnyHostDaemonCommandDescriptor, { transport: Transport }>;
type HostDaemonRetryableOnlineRpcCommandDescriptor = Extract<
  HostDaemonCommandDescriptorForTransport<"onlineRpc">,
  { retryable: true }
>;
type HostDaemonCommandTypeForTransport<
  Transport extends HostDaemonCommandTransport,
> = HostDaemonCommandDescriptorForTransport<Transport>["type"];
type HostDaemonSchemaForTransport<
  Transport extends HostDaemonCommandTransport,
> = HostDaemonCommandDescriptorForTransport<Transport>["schema"];
type HostDaemonRetryableOnlineRpcCommandSchema =
  HostDaemonRetryableOnlineRpcCommandDescriptor["schema"];

type HostDaemonResultSchemaMapForTransport<
  Transport extends HostDaemonCommandTransport,
> = {
  [
    Descriptor in HostDaemonCommandDescriptorForTransport<Transport> as Descriptor["type"]
  ]: Descriptor["resultSchema"];
};

type HostDaemonCommandResultSchemaMap =
  HostDaemonResultSchemaMapForTransport<"settled">;
type HostDaemonOnlineRpcResultSchemaMap =
  HostDaemonResultSchemaMapForTransport<"onlineRpc">;

export type HostDaemonSettledCommandType =
  HostDaemonCommandTypeForTransport<"settled">;
export type HostDaemonOnlineRpcCommandType =
  HostDaemonCommandTypeForTransport<"onlineRpc">;
export type HostDaemonRpcCommandType =
  | HostDaemonSettledCommandType
  | HostDaemonOnlineRpcCommandType;

export type HostDaemonCommand = z.infer<
  HostDaemonSchemaForTransport<"settled">
>;
export type HostDaemonOnlineRpcCommand = z.infer<
  HostDaemonSchemaForTransport<"onlineRpc">
>;
export type HostDaemonRetryableOnlineRpcCommand =
  z.infer<HostDaemonRetryableOnlineRpcCommandSchema>;
export type HostDaemonRpcCommand =
  | HostDaemonCommand
  | HostDaemonOnlineRpcCommand;

function hostDaemonCommandDescriptorsForTransport<
  const Transport extends HostDaemonCommandTransport,
>(transport: Transport): HostDaemonCommandDescriptorForTransport<Transport>[] {
  return Object.values(hostDaemonCommandRegistry).filter(
    (
      descriptor,
    ): descriptor is HostDaemonCommandDescriptorForTransport<Transport> =>
      descriptor.transport === transport,
  );
}

function hostDaemonCommandTypesForTransport<
  const Transport extends HostDaemonCommandTransport,
>(transport: Transport): HostDaemonCommandTypeForTransport<Transport>[] {
  return hostDaemonCommandDescriptorsForTransport(transport).map(
    (descriptor) => descriptor.type,
  ) as HostDaemonCommandTypeForTransport<Transport>[];
}

function hostDaemonCommandSchemaForTransport<
  const Transport extends HostDaemonCommandTransport,
>(
  transport: Transport,
): z.ZodType<z.infer<HostDaemonSchemaForTransport<Transport>>> {
  const schemas = hostDaemonCommandDescriptorsForTransport(transport).map(
    (descriptor) => descriptor.schema,
  );
  return z.union(
    schemas as [
      HostDaemonSchemaForTransport<Transport>,
      HostDaemonSchemaForTransport<Transport>,
      ...HostDaemonSchemaForTransport<Transport>[],
    ],
  );
}

function hostDaemonResultSchemaByTypeForTransport<
  const Transport extends HostDaemonCommandTransport,
>(transport: Transport): HostDaemonResultSchemaMapForTransport<Transport> {
  return Object.fromEntries(
    hostDaemonCommandDescriptorsForTransport(transport).map((descriptor) => [
      descriptor.type,
      descriptor.resultSchema,
    ]),
  ) as HostDaemonResultSchemaMapForTransport<Transport>;
}

export const HOST_DAEMON_SETTLED_COMMAND_TYPES =
  hostDaemonCommandTypesForTransport("settled");
export const HOST_DAEMON_ONLINE_RPC_COMMAND_TYPES =
  hostDaemonCommandTypesForTransport("onlineRpc");

const hostDaemonSettledCommandTypes = new Set<string>(
  HOST_DAEMON_SETTLED_COMMAND_TYPES,
);
const hostDaemonOnlineRpcCommandTypes = new Set<string>(
  HOST_DAEMON_ONLINE_RPC_COMMAND_TYPES,
);

function isHostDaemonSettledCommandType(
  type: string,
): type is HostDaemonSettledCommandType {
  return hostDaemonSettledCommandTypes.has(type);
}

function isHostDaemonOnlineRpcCommandType(
  type: string,
): type is HostDaemonOnlineRpcCommandType {
  return hostDaemonOnlineRpcCommandTypes.has(type);
}

function isHostDaemonSettledCommandTypeValue(
  value: unknown,
): value is HostDaemonSettledCommandType {
  return typeof value === "string" && isHostDaemonSettledCommandType(value);
}

function isHostDaemonOnlineRpcCommandTypeValue(
  value: unknown,
): value is HostDaemonOnlineRpcCommandType {
  return typeof value === "string" && isHostDaemonOnlineRpcCommandType(value);
}

export const hostDaemonSettledCommandTypeSchema =
  z.custom<HostDaemonSettledCommandType>(isHostDaemonSettledCommandTypeValue);
const hostDaemonOnlineRpcCommandTypeSchema =
  z.custom<HostDaemonOnlineRpcCommandType>(
    isHostDaemonOnlineRpcCommandTypeValue,
  );

export const hostDaemonCommandSchema =
  hostDaemonCommandSchemaForTransport("settled");
export const hostDaemonOnlineRpcCommandSchema =
  hostDaemonCommandSchemaForTransport("onlineRpc");
export const hostDaemonRpcCommandSchema = z.union([
  hostDaemonOnlineRpcCommandSchema,
  hostDaemonCommandSchema,
]);
export const hostDaemonRpcCommandTypeSchema = z.union([
  hostDaemonOnlineRpcCommandTypeSchema,
  hostDaemonSettledCommandTypeSchema,
]);

export function isHostDaemonCommand(
  command: HostDaemonRpcCommand,
): command is HostDaemonCommand {
  return isHostDaemonSettledCommandType(command.type);
}

export const hostDaemonCommandResultSchemaByType =
  hostDaemonResultSchemaByTypeForTransport("settled");
export const hostDaemonOnlineRpcResultSchemaByType =
  hostDaemonResultSchemaByTypeForTransport("onlineRpc");

type HostDaemonCommandResultByType = {
  [K in keyof HostDaemonCommandResultSchemaMap]: z.infer<
    HostDaemonCommandResultSchemaMap[K]
  >;
};

export type HostDaemonCommandResult<
  TType extends HostDaemonSettledCommandType = HostDaemonSettledCommandType,
> = HostDaemonCommandResultByType[TType];

export type HostDaemonOnlineRpcResultByType = {
  [K in keyof HostDaemonOnlineRpcResultSchemaMap]: z.infer<
    HostDaemonOnlineRpcResultSchemaMap[K]
  >;
};

export type HostDaemonOnlineRpcResult<
  TType extends HostDaemonOnlineRpcCommandType = HostDaemonOnlineRpcCommandType,
> = HostDaemonOnlineRpcResultByType[TType];

export function hostDaemonEnvironmentLaneForCommand(
  command: HostDaemonRpcCommand,
): HostDaemonCommandEnvironmentLane | null {
  return hostDaemonCommandRegistry[command.type].envLane;
}

export function shouldFlushEventsBeforeReportingCommandResult(
  command: HostDaemonCommand,
): boolean {
  const policy =
    hostDaemonCommandRegistry[command.type].flushEventsBeforeResult;
  if (policy === "when-initiated") {
    return "initiator" in command && command.initiator !== null;
  }
  return policy;
}

export type HostDaemonOnlineRpcResultForCommand<
  TCommand extends HostDaemonOnlineRpcCommand = HostDaemonOnlineRpcCommand,
> = TCommand extends { type: infer TType }
  ? TType extends keyof HostDaemonOnlineRpcResultByType
    ? HostDaemonOnlineRpcResultByType[TType]
    : never
  : never;

export type HostDaemonCommandResultForCommand<
  TCommand extends HostDaemonCommand = HostDaemonCommand,
> = TCommand extends { type: infer TType }
  ? TType extends keyof HostDaemonCommandResultByType
    ? HostDaemonCommandResultByType[TType]
    : never
  : never;

export type HostDaemonRpcResultForCommand<
  TCommand extends HostDaemonRpcCommand = HostDaemonRpcCommand,
> = TCommand extends HostDaemonOnlineRpcCommand
  ? HostDaemonOnlineRpcResultForCommand<TCommand>
  : TCommand extends HostDaemonCommand
    ? HostDaemonCommandResultForCommand<TCommand>
    : never;

export function parseHostDaemonCommandResultForCommand<
  TCommand extends HostDaemonCommand,
>(
  command: TCommand,
  value: unknown,
): HostDaemonCommandResultForCommand<TCommand>;
export function parseHostDaemonCommandResultForCommand(
  command: HostDaemonCommand,
  value: unknown,
): HostDaemonCommandResultForCommand {
  return hostDaemonCommandResultSchemaByType[command.type].parse(value);
}

export function parseHostDaemonOnlineRpcResultForCommand<
  TCommand extends HostDaemonOnlineRpcCommand,
>(
  command: TCommand,
  value: unknown,
): HostDaemonOnlineRpcResultForCommand<TCommand>;
export function parseHostDaemonOnlineRpcResultForCommand(
  command: HostDaemonOnlineRpcCommand,
  value: unknown,
): HostDaemonOnlineRpcResultForCommand {
  return hostDaemonOnlineRpcResultSchemaByType[command.type].parse(value);
}

export function parseHostDaemonRpcResultForCommand<
  TCommand extends HostDaemonRpcCommand,
>(command: TCommand, value: unknown): HostDaemonRpcResultForCommand<TCommand>;
export function parseHostDaemonRpcResultForCommand(
  command: HostDaemonRpcCommand,
  value: unknown,
): HostDaemonRpcResultForCommand {
  if (isHostDaemonCommand(command)) {
    return parseHostDaemonCommandResultForCommand(command, value);
  }
  return parseHostDaemonOnlineRpcResultForCommand(command, value);
}
