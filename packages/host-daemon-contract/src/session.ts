import { desktopBrowserChangedSchema } from "./desktop-browser.js";
import type { Hono } from "hono";
import { hc } from "hono/client";
import {
  discoveredWorkspacePropertiesSchema,
  ENVIRONMENT_CHANGE_KINDS,
  hostTypeSchema,
  jsonValueSchema,
  pendingInteractionCreateSchema,
  pendingInteractionStatusSchema,
  terminalColsSchema,
  terminalDataBase64Schema,
  terminalRowsSchema,
  threadEventSchema,
  toolCallRequestSchema,
  toolCallResponseSchema,
} from "@bb/domain";
import { z } from "zod";
import type { Endpoint } from "@bb/hono-typed-routes";
import type {
  HostDaemonOnlineRpcCommandType,
  HostDaemonSettledCommandType,
} from "./commands.js";
import {
  hostDaemonConnectTunnelIdentitySchema,
  hostDaemonOnlineRpcResultSchemaByType,
  hostDaemonCommandResultSchemaByType,
  hostDaemonSettledCommandTypeSchema,
  hostDaemonRpcCommandSchema,
  hostDaemonRpcCommandTypeSchema,
  workspaceContextSchema,
} from "./commands.js";
import { hostPlatformSchema } from "./local.js";

const HOST_DAEMON_WEBSOCKET_PROTOCOL = "bb-host-daemon.v1";

export const hostDaemonActiveThreadSchema = z.object({
  threadId: z.string().min(1),
});
export type HostDaemonActiveThread = z.infer<
  typeof hostDaemonActiveThreadSchema
>;

const hostDaemonLoadedEnvironmentSchema = z.object({
  environmentId: z.string().min(1),
});
export type HostDaemonLoadedEnvironment = z.infer<
  typeof hostDaemonLoadedEnvironmentSchema
>;

const hostDaemonWatchSetWorkspaceTargetSchema = z
  .object({
    environmentId: z.string().min(1),
    workspaceContext: workspaceContextSchema,
  })
  .strict();
export type HostDaemonWatchSetWorkspaceTarget = z.infer<
  typeof hostDaemonWatchSetWorkspaceTargetSchema
>;

const hostDaemonWatchSetThreadStorageTargetSchema = z
  .object({
    environmentId: z.string().min(1),
    threadId: z.string().min(1),
  })
  .strict();
export type HostDaemonWatchSetThreadStorageTarget = z.infer<
  typeof hostDaemonWatchSetThreadStorageTargetSchema
>;

const hostDaemonWatchSetSchema = z
  .object({
    generation: z.number().int().nonnegative(),
    workspaceTargets: z.array(hostDaemonWatchSetWorkspaceTargetSchema),
    threadStorageTargets: z.array(hostDaemonWatchSetThreadStorageTargetSchema),
  })
  .strict();
export type HostDaemonWatchSet = z.infer<typeof hostDaemonWatchSetSchema>;

const hostDaemonConnectSharesSchema = z
  .object({
    generation: z.number().int().nonnegative(),
    ports: z.array(z.number().int().min(1).max(65535)),
  })
  .strict();
export type HostDaemonConnectShares = z.infer<
  typeof hostDaemonConnectSharesSchema
>;

const hostDaemonPluginHostGenerationSchema = z
  .object({
    pluginId: z.string().min(1),
    generation: z.string().min(1),
  })
  .strict();

export const hostDaemonSessionOpenRequestSchema = z.object({
  hostId: z.string().min(1),
  instanceId: z.string().min(1),
  hostName: z.string().min(1),
  hostType: hostTypeSchema,
  connectMachineId: z.string().min(1).optional(),
  hasMachineCredential: z.boolean(),
  platform: hostPlatformSchema,
  dataDir: z.string().min(1),
  localApiPort: z.number().int().min(1).max(65_535).nullable().default(null),
  protocolVersion: z.number().int().positive(),
  activeThreads: z.array(hostDaemonActiveThreadSchema),
  loadedEnvironments: z.array(hostDaemonLoadedEnvironmentSchema).default([]),
});
export type HostDaemonSessionOpenRequest = z.output<
  typeof hostDaemonSessionOpenRequestSchema
>;

export const hostDaemonEnrollRequestSchema = z
  .object({
    hostId: z.string().min(1),
    hostName: z.string().min(1),
    hostType: hostTypeSchema,
    connectMachineId: z.string().min(1).optional(),
  })
  .strict();
export type HostDaemonEnrollRequest = z.infer<
  typeof hostDaemonEnrollRequestSchema
>;

export const hostDaemonEnrollResponseSchema = z
  .object({
    hostId: z.string().min(1),
    hostKey: z.string().min(1),
  })
  .strict();
type HostDaemonEnrollResponse = z.infer<typeof hostDaemonEnrollResponseSchema>;

export const hostDaemonEnrollKeyRequestSchema = z
  .object({
    hostId: z.string().min(1).optional(),
  })
  .strict();
export type HostDaemonEnrollKeyRequest = z.infer<
  typeof hostDaemonEnrollKeyRequestSchema
>;

export const hostDaemonEnrollKeyResponseSchema = z
  .object({
    enrollKey: z.string().min(1),
    expiresAt: z.number().int().positive(),
    hostId: z.string().min(1),
  })
  .strict();
export type HostDaemonEnrollKeyResponse = z.infer<
  typeof hostDaemonEnrollKeyResponseSchema
>;

export const hostDaemonSessionOpenResponseSchema = z
  .object({
    sessionId: z.string().min(1),
    heartbeatIntervalMs: z.number().int().positive(),
    leaseTimeoutMs: z.number().int().positive(),
    watchSet: hostDaemonWatchSetSchema.default({
      generation: 0,
      workspaceTargets: [],
      threadStorageTargets: [],
    }),
    connectShares: hostDaemonConnectSharesSchema.default({
      generation: 0,
      ports: [],
    }),
    pluginHostGenerations: z
      .array(hostDaemonPluginHostGenerationSchema)
      .default([]),
    retiredEnvironmentIds: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type HostDaemonSessionOpenResponse = z.infer<
  typeof hostDaemonSessionOpenResponseSchema
>;

export const hostDaemonProjectAttachmentContentQuerySchema = z.object({
  sessionId: z.string().min(1),
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  path: z.string().min(1),
});
export type HostDaemonProjectAttachmentContentQuery = z.infer<
  typeof hostDaemonProjectAttachmentContentQuerySchema
>;

const hostDaemonEventEnvelopeSchema = z
  .object({
    threadId: z.string().min(1),
    event: threadEventSchema,
  })
  .strict();
export type HostDaemonEventEnvelope = z.infer<
  typeof hostDaemonEventEnvelopeSchema
>;

const hostDaemonWireEventSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (typeof value !== "object" || value === null) return;
    if (Object.hasOwn(value, "sequence")) {
      context.addIssue({
        code: "custom",
        message: "Daemon events must not provide a server-owned sequence",
        path: ["sequence"],
      });
    }
  })
  .pipe(threadEventSchema);

const hostDaemonEventGroupSchema = z
  .object({
    threadId: z.string().min(1),
    events: z.array(hostDaemonWireEventSchema).min(1),
  })
  .strict();
type HostDaemonEventGroup = z.infer<typeof hostDaemonEventGroupSchema>;

export const hostDaemonEventBatchRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    eventGroups: z.array(hostDaemonEventGroupSchema),
  })
  .strict();
export type HostDaemonEventBatchRequest = z.infer<
  typeof hostDaemonEventBatchRequestSchema
>;

export function groupHostDaemonEvents(
  envelopes: readonly HostDaemonEventEnvelope[],
): HostDaemonEventGroup[] {
  const groups: HostDaemonEventGroup[] = [];
  for (const envelope of envelopes) {
    const last = groups.at(-1);
    if (last?.threadId === envelope.threadId) {
      last.events.push(envelope.event);
    } else {
      groups.push({ threadId: envelope.threadId, events: [envelope.event] });
    }
  }
  return groups;
}

export function ungroupHostDaemonEvents(
  groups: readonly HostDaemonEventGroup[],
): HostDaemonEventEnvelope[] {
  return groups.flatMap((group) =>
    group.events.map((event) => ({ threadId: group.threadId, event })),
  );
}

const hostDaemonEventRejectionReasonSchema = z.enum([
  "thread_not_owned_by_host",
]);

const hostDaemonRejectedEventSchema = z
  .object({
    eventIndex: z.number().int().nonnegative(),
    threadId: z.string().min(1),
    reason: hostDaemonEventRejectionReasonSchema,
  })
  .strict();
export type HostDaemonRejectedEvent = z.infer<
  typeof hostDaemonRejectedEventSchema
>;

export const hostDaemonEventBatchResponseSchema = z
  .object({
    acceptedEvents: z.array(
      z
        .object({
          eventIndex: z.number().int().nonnegative(),
          threadId: z.string().min(1),
          sequence: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    rejectedEvents: z.array(hostDaemonRejectedEventSchema),
  })
  .strict();
export type HostDaemonEventBatchResponse = z.infer<
  typeof hostDaemonEventBatchResponseSchema
>;

const hostDaemonEnvironmentChangeSchema = z
  .enum(ENVIRONMENT_CHANGE_KINDS)
  .extract([
    "work-status-changed",
    "git-refs-changed",
    "thread-storage-changed",
  ]);
export type HostDaemonEnvironmentChange = z.infer<
  typeof hostDaemonEnvironmentChangeSchema
>;

const hostDaemonEnvironmentChangePayloadSchema = z.object({
  environmentId: z.string().min(1),
  change: hostDaemonEnvironmentChangeSchema,
});
export type HostDaemonEnvironmentChangePayload = z.infer<
  typeof hostDaemonEnvironmentChangePayloadSchema
>;

const hostDaemonEnvironmentMetadataChangePayloadSchema = z
  .object({
    environmentId: z.string().min(1),
    workspace: discoveredWorkspacePropertiesSchema,
  })
  .strict();
export type HostDaemonEnvironmentMetadataChangePayload = z.infer<
  typeof hostDaemonEnvironmentMetadataChangePayloadSchema
>;

const hostDaemonSessionCloseReasonSchema = z.enum([
  "replaced",
  "expired",
  "daemon-disconnect",
]);
export type HostDaemonSessionCloseReason = z.infer<
  typeof hostDaemonSessionCloseReasonSchema
>;

const terminalIdSchema = z.string().min(1);
const terminalRequestIdSchema = z.string().min(1);
const terminalCloseReasonSchema = z.enum([
  "user",
  "process-exit",
  "daemon-disconnect",
  "environment-destroyed",
  "thread-archived",
  "thread-deleted",
  "open-timeout",
]);
const hostDaemonOnlineRpcRequestIdSchema = z.string().min(1);

const hostDaemonOnlineRpcRequestMessageSchema = z
  .object({
    type: z.literal("host-rpc.request"),
    requestId: hostDaemonOnlineRpcRequestIdSchema,
    command: hostDaemonRpcCommandSchema,
  })
  .strict();

const hostDaemonWatchSetReplaceMessageSchema = hostDaemonWatchSetSchema
  .extend({
    type: z.literal("watch-set.replace"),
  })
  .strict();
export type HostDaemonWatchSetReplaceMessage = z.infer<
  typeof hostDaemonWatchSetReplaceMessageSchema
>;

const hostDaemonConnectSharesReplaceMessageSchema =
  hostDaemonConnectSharesSchema
    .extend({
      type: z.literal("connect-shares.replace"),
    })
    .strict();
export type HostDaemonConnectSharesReplaceMessage = z.infer<
  typeof hostDaemonConnectSharesReplaceMessageSchema
>;

const hostDaemonOnlineRpcResponseSuccessBaseSchema = z
  .object({
    type: z.literal("host-rpc.response"),
    requestId: hostDaemonOnlineRpcRequestIdSchema,
    ok: z.literal(true),
  })
  .strict();

function onlineRpcResponseSuccessSchemaFor<
  TType extends HostDaemonOnlineRpcCommandType,
>(commandType: TType) {
  return hostDaemonOnlineRpcResponseSuccessBaseSchema.extend({
    commandType: z.literal(commandType),
    result: hostDaemonOnlineRpcResultSchemaByType[commandType],
  });
}

function commandRpcResponseSuccessSchemaFor<
  TType extends HostDaemonSettledCommandType,
>(commandType: TType) {
  return hostDaemonOnlineRpcResponseSuccessBaseSchema.extend({
    commandType: z.literal(commandType),
    result:
      hostDaemonCommandResultSchemaByType[
        hostDaemonSettledCommandTypeSchema.parse(commandType)
      ],
  });
}

const hostDaemonOnlineRpcResponseSuccessSchema = z.discriminatedUnion(
  "commandType",
  [
    onlineRpcResponseSuccessSchemaFor("desktop.browser.list_instances"),
    onlineRpcResponseSuccessSchemaFor("desktop.browser.list_tabs"),
    onlineRpcResponseSuccessSchemaFor("desktop.browser.create_tab"),
    onlineRpcResponseSuccessSchemaFor("desktop.browser.reveal_tab"),
    onlineRpcResponseSuccessSchemaFor("desktop.browser.close_tab"),
    onlineRpcResponseSuccessSchemaFor("desktop.browser.capture_tab"),
    onlineRpcResponseSuccessSchemaFor("desktop.browser.acquire_control"),
    onlineRpcResponseSuccessSchemaFor("desktop.browser.open_connection"),
    onlineRpcResponseSuccessSchemaFor("desktop.browser.release_control"),
    onlineRpcResponseSuccessSchemaFor("host.list_files"),
    onlineRpcResponseSuccessSchemaFor("host.list_paths"),
    onlineRpcResponseSuccessSchemaFor("host.mkdir"),
    onlineRpcResponseSuccessSchemaFor("host.move_path"),
    onlineRpcResponseSuccessSchemaFor("host.remove_path"),
    onlineRpcResponseSuccessSchemaFor("host.browse_directory"),
    onlineRpcResponseSuccessSchemaFor("host.paths_exist"),
    onlineRpcResponseSuccessSchemaFor("project.inspect"),
    onlineRpcResponseSuccessSchemaFor("project.clone_default_path"),
    onlineRpcResponseSuccessSchemaFor("host.pick_folder"),
    onlineRpcResponseSuccessSchemaFor("plugin.host.call"),
    onlineRpcResponseSuccessSchemaFor("plugin.host.cancel"),
    onlineRpcResponseSuccessSchemaFor("plugin.host.dispose"),
    onlineRpcResponseSuccessSchemaFor("connect-tunnel.ensure-identity"),
    onlineRpcResponseSuccessSchemaFor("host.list_commands"),
    onlineRpcResponseSuccessSchemaFor("host.list_skills"),
    onlineRpcResponseSuccessSchemaFor("host.delete_skill"),
    onlineRpcResponseSuccessSchemaFor("host.write_skill"),
    onlineRpcResponseSuccessSchemaFor("host.install_global_skills"),
    onlineRpcResponseSuccessSchemaFor("host.global_skills_status"),
    onlineRpcResponseSuccessSchemaFor("host.file_metadata"),
    onlineRpcResponseSuccessSchemaFor("host.list_branch_options"),
    onlineRpcResponseSuccessSchemaFor("host.inspect_git_source"),
    onlineRpcResponseSuccessSchemaFor("host.read_file"),
    onlineRpcResponseSuccessSchemaFor("host.read_file_relative"),
    onlineRpcResponseSuccessSchemaFor("host.write_file"),
    onlineRpcResponseSuccessSchemaFor("provider.list_models"),
    onlineRpcResponseSuccessSchemaFor("provider.health"),
    onlineRpcResponseSuccessSchemaFor("provider.installation.status"),
    onlineRpcResponseSuccessSchemaFor("provider.installation.run"),
    onlineRpcResponseSuccessSchemaFor("provider.usage"),
    onlineRpcResponseSuccessSchemaFor("workspace.status"),
    onlineRpcResponseSuccessSchemaFor("workspace.diff"),
    onlineRpcResponseSuccessSchemaFor("workspace.diffFiles"),
    onlineRpcResponseSuccessSchemaFor("workspace.diffPatch"),
    onlineRpcResponseSuccessSchemaFor("workspace.pull_request"),
    commandRpcResponseSuccessSchemaFor("thread.rewind.discard"),
    commandRpcResponseSuccessSchemaFor("thread.rewind.prepare"),
    commandRpcResponseSuccessSchemaFor("thread.start"),
    commandRpcResponseSuccessSchemaFor("turn.submit"),
    commandRpcResponseSuccessSchemaFor("thread.stop"),
    commandRpcResponseSuccessSchemaFor("thread.goal.clear"),
    commandRpcResponseSuccessSchemaFor("thread.plan.cancel"),
    commandRpcResponseSuccessSchemaFor("thread.rename"),
    commandRpcResponseSuccessSchemaFor("thread.archive"),
    commandRpcResponseSuccessSchemaFor("thread.unarchive"),
    commandRpcResponseSuccessSchemaFor("interactive.resolve"),
    commandRpcResponseSuccessSchemaFor("environment.provision"),
    commandRpcResponseSuccessSchemaFor("project.clone"),
    commandRpcResponseSuccessSchemaFor("environment.provision.cancel"),
    commandRpcResponseSuccessSchemaFor("environment.destroy"),
    commandRpcResponseSuccessSchemaFor("workspace.commit"),
    commandRpcResponseSuccessSchemaFor("workspace.pull_request_action"),
  ],
);

const hostDaemonOnlineRpcResponseFailureSchema = z
  .object({
    type: z.literal("host-rpc.response"),
    requestId: hostDaemonOnlineRpcRequestIdSchema,
    commandType: hostDaemonRpcCommandTypeSchema,
    ok: z.literal(false),
    errorCode: z.string().min(1),
    errorMessage: z.string().min(1),
  })
  .strict();

export const hostDaemonOnlineRpcResponseMessageSchema = z.union([
  hostDaemonOnlineRpcResponseSuccessSchema,
  hostDaemonOnlineRpcResponseFailureSchema,
]);
export type HostDaemonOnlineRpcResponseMessage = z.infer<
  typeof hostDaemonOnlineRpcResponseMessageSchema
>;

export type HostDaemonOnlineRpcRequestMessage = z.infer<
  typeof hostDaemonOnlineRpcRequestMessageSchema
>;

export const hostDaemonTerminalOutputChunkSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    dataBase64: terminalDataBase64Schema,
  })
  .strict();

const hostDaemonTerminalOpenTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("workspace"),
      environmentId: z.string().min(1),
      workspaceContext: workspaceContextSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("host_path"),
      cwd: z.string().min(1).nullable(),
    })
    .strict(),
]);

const hostDaemonTerminalOpenMessageSchema = z
  .object({
    type: z.literal("terminal.open"),
    requestId: terminalRequestIdSchema,
    terminalId: terminalIdSchema,
    threadId: z.string().min(1).optional(),
    target: hostDaemonTerminalOpenTargetSchema,
    cols: terminalColsSchema,
    rows: terminalRowsSchema,
    start: z
      .discriminatedUnion("mode", [
        z
          .object({
            mode: z.literal("shell"),
          })
          .strict(),
        z
          .object({
            mode: z.literal("command"),
            command: z.string().min(1),
          })
          .strict(),
      ])
      .default({ mode: "shell" }),
  })
  .strict();

const hostDaemonTerminalAttachMessageSchema = z
  .object({
    type: z.literal("terminal.attach"),
    requestId: terminalRequestIdSchema,
    terminalId: terminalIdSchema,
    sinceSeq: z.number().int().nonnegative(),
    tailBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
  })
  .strict();

const hostDaemonTerminalInputMessageSchema = z
  .object({
    type: z.literal("terminal.input"),
    terminalId: terminalIdSchema,
    dataBase64: terminalDataBase64Schema,
  })
  .strict();

const hostDaemonTerminalResizeMessageSchema = z
  .object({
    type: z.literal("terminal.resize"),
    terminalId: terminalIdSchema,
    cols: terminalColsSchema,
    rows: terminalRowsSchema,
  })
  .strict();

const hostDaemonTerminalCloseMessageSchema = z
  .object({
    type: z.literal("terminal.close"),
    terminalId: terminalIdSchema,
    reason: terminalCloseReasonSchema,
  })
  .strict();

export const hostDaemonServerWsMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("session-close"),
      reason: hostDaemonSessionCloseReasonSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("heartbeat-ack"),
    })
    .strict(),
  hostDaemonOnlineRpcRequestMessageSchema,
  hostDaemonWatchSetReplaceMessageSchema,
  hostDaemonConnectSharesReplaceMessageSchema,
  hostDaemonTerminalOpenMessageSchema,
  hostDaemonTerminalAttachMessageSchema,
  hostDaemonTerminalInputMessageSchema,
  hostDaemonTerminalResizeMessageSchema,
  hostDaemonTerminalCloseMessageSchema,
]);
export type HostDaemonServerWsMessage = z.infer<
  typeof hostDaemonServerWsMessageSchema
>;

const hostDaemonHeartbeatMessageSchema = z
  .object({
    type: z.literal("heartbeat"),
  })
  .strict();

const hostDaemonEnvironmentChangeMessageSchema =
  hostDaemonEnvironmentChangePayloadSchema
    .extend({
      type: z.literal("environment-change"),
    })
    .strict();

const hostDaemonEnvironmentMetadataChangeMessageSchema =
  hostDaemonEnvironmentMetadataChangePayloadSchema
    .extend({
      type: z.literal("environment-metadata-change"),
    })
    .strict();

const hostDaemonConnectTunnelIdentityMessageSchema = z
  .object({
    type: z.literal("connect-tunnel.identity"),
    identity: hostDaemonConnectTunnelIdentitySchema,
  })
  .strict();

const pluginHostWorkerExitedMessageSchema = z
  .object({
    type: z.literal("plugin-host.worker-exited"),
    pluginId: z.string().min(1),
    generation: z.string().min(1),
  })
  .strict();

const pluginHostSignalMessageSchema = z
  .object({
    type: z.literal("plugin-host.signal"),
    pluginId: z.string().min(1),
    generation: z.string().min(1),
    signal: z.string().min(1),
    payload: jsonValueSchema,
  })
  .strict();

const hostDaemonTerminalOpenedMessageSchema = z
  .object({
    type: z.literal("terminal.opened"),
    requestId: terminalRequestIdSchema,
    terminalId: terminalIdSchema,
    shell: z.string().min(1),
    title: z.string().min(1),
    initialCwd: z.string().min(1),
    cols: terminalColsSchema,
    rows: terminalRowsSchema,
  })
  .strict();

const hostDaemonTerminalOutputMessageSchema = z
  .object({
    type: z.literal("terminal.output"),
    terminalId: terminalIdSchema,
    chunk: hostDaemonTerminalOutputChunkSchema,
  })
  .strict();

const hostDaemonTerminalReplayMessageSchema = z
  .object({
    type: z.literal("terminal.replay"),
    requestId: terminalRequestIdSchema,
    terminalId: terminalIdSchema,
    chunks: z.array(hostDaemonTerminalOutputChunkSchema),
    replayStartSeq: z.number().int().nonnegative(),
    nextSeq: z.number().int().nonnegative(),
  })
  .strict();

const hostDaemonTerminalExitedMessageSchema = z
  .object({
    type: z.literal("terminal.exited"),
    terminalId: terminalIdSchema,
    exitCode: z.number().int().nullable(),
    closeReason: terminalCloseReasonSchema,
  })
  .strict();

const hostDaemonTerminalErrorMessageSchema = z
  .object({
    type: z.literal("terminal.error"),
    requestId: terminalRequestIdSchema,
    terminalId: terminalIdSchema,
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const hostDaemonDaemonWsMessageSchema = z.union([
  desktopBrowserChangedSchema,
  hostDaemonHeartbeatMessageSchema,
  hostDaemonEnvironmentChangeMessageSchema,
  hostDaemonEnvironmentMetadataChangeMessageSchema,
  hostDaemonConnectTunnelIdentityMessageSchema,
  pluginHostWorkerExitedMessageSchema,
  pluginHostSignalMessageSchema,
  hostDaemonTerminalOpenedMessageSchema,
  hostDaemonTerminalOutputMessageSchema,
  hostDaemonTerminalReplayMessageSchema,
  hostDaemonTerminalExitedMessageSchema,
  hostDaemonTerminalErrorMessageSchema,
  hostDaemonOnlineRpcResponseMessageSchema,
]);
export type HostDaemonDaemonWsMessage = z.infer<
  typeof hostDaemonDaemonWsMessageSchema
>;

export const hostDaemonToolCallRequestSchema = toolCallRequestSchema
  .pick({
    threadId: true,
    providerThreadId: true,
    turnId: true,
    callId: true,
    tool: true,
    arguments: true,
  })
  .extend({
    sessionId: z.string().min(1),
  });
export type HostDaemonToolCallRequest = z.infer<
  typeof hostDaemonToolCallRequestSchema
>;

export const hostDaemonToolCallResponseSchema = toolCallResponseSchema;
export type HostDaemonToolCallResponse = z.infer<
  typeof hostDaemonToolCallResponseSchema
>;

export const hostDaemonInteractiveRequestSchema = z.object({
  sessionId: z.string().min(1),
  interaction: pendingInteractionCreateSchema,
});
export type HostDaemonInteractiveRequest = z.infer<
  typeof hostDaemonInteractiveRequestSchema
>;

export const hostDaemonInteractiveRequestResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({
      outcome: z.literal("created"),
      interactionId: z.string().min(1),
      status: pendingInteractionStatusSchema,
    }),
    z.object({
      outcome: z.literal("existing"),
      interactionId: z.string().min(1),
      status: pendingInteractionStatusSchema,
    }),
    z.object({
      outcome: z.literal("rejected"),
      reason: z.string().min(1),
    }),
  ],
);
export type HostDaemonInteractiveRequestResponse = z.infer<
  typeof hostDaemonInteractiveRequestResponseSchema
>;

export const hostDaemonInteractiveInterruptRequestSchema = z.object({
  sessionId: z.string().min(1),
  providerId: z.string().min(1),
  threadIds: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
});
export type HostDaemonInteractiveInterruptRequest = z.infer<
  typeof hostDaemonInteractiveInterruptRequestSchema
>;

export const hostDaemonInteractiveInterruptResponseSchema = z.object({
  ok: z.literal(true),
  interactionIds: z.array(z.string().min(1)),
});
export type HostDaemonInteractiveInterruptResponse = z.infer<
  typeof hostDaemonInteractiveInterruptResponseSchema
>;

const hostDaemonSkillTreeEntrySchema = z
  .object({
    path: z.string().min(1),
    mode: z.number().int().min(0).max(0o777),
    contentBase64: z.string(),
  })
  .strict();
export const hostDaemonSkillTreeSchema = z
  .object({
    treeHash: z.string().regex(/^[a-f0-9]{64}$/u),
    entries: z.array(hostDaemonSkillTreeEntrySchema),
  })
  .strict();
export type HostDaemonSkillTree = z.infer<typeof hostDaemonSkillTreeSchema>;

export type HostDaemonInternalSchema = {
  "/skills/tree/:hash": {
    $get: Endpoint<Record<never, never>, HostDaemonSkillTree, 200>;
  };
  "/plugins/:pluginId/host/:digest": {
    $get: Endpoint<Record<never, never>, Uint8Array, 200, "binary">;
  };
  "/provider-bridges/:sha256": {
    $get: Endpoint<Record<never, never>, Uint8Array, 200, "binary">;
  };
  "/hosts/enroll-key": {
    $post: Endpoint<
      { json: HostDaemonEnrollKeyRequest },
      HostDaemonEnrollKeyResponse,
      201
    >;
  };
  "/hosts/enroll": {
    $post: Endpoint<
      { json: HostDaemonEnrollRequest },
      HostDaemonEnrollResponse,
      201
    >;
  };
  "/session/open": {
    $post: Endpoint<
      { json: HostDaemonSessionOpenRequest },
      HostDaemonSessionOpenResponse,
      201
    >;
  };
  "/session/project-attachment-content": {
    $get: Endpoint<
      { query: HostDaemonProjectAttachmentContentQuery },
      Uint8Array,
      200,
      "binary"
    >;
  };
  "/session/events": {
    $post: Endpoint<
      { json: HostDaemonEventBatchRequest },
      HostDaemonEventBatchResponse
    >;
  };
  "/session/tool-call": {
    $post: Endpoint<
      { json: HostDaemonToolCallRequest },
      HostDaemonToolCallResponse
    >;
  };
  "/session/interactive-request": {
    $post: Endpoint<
      { json: HostDaemonInteractiveRequest },
      HostDaemonInteractiveRequestResponse
    >;
  };
  "/session/interactive-request/interrupt": {
    $post: Endpoint<
      { json: HostDaemonInteractiveInterruptRequest },
      HostDaemonInteractiveInterruptResponse
    >;
  };
};

type HostDaemonInternalRoutes = Hono<{}, HostDaemonInternalSchema, "/">;

function parseProtocolHeader(protocolHeader: string | undefined): string[] {
  if (!protocolHeader) {
    return [];
  }

  return protocolHeader
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function buildHostDaemonWebSocketAuthorizationHeader(
  hostKey: string,
): string {
  return `Bearer ${hostKey}`;
}

export function buildHostDaemonWebSocketProtocols(): string[] {
  return [HOST_DAEMON_WEBSOCKET_PROTOCOL];
}

export function hasHostDaemonWebSocketProtocol(
  protocolHeader: string | undefined,
): boolean {
  return parseProtocolHeader(protocolHeader).includes(
    HOST_DAEMON_WEBSOCKET_PROTOCOL,
  );
}

export function createHostDaemonClient(baseUrl: string, hostKey: string) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const internalBaseUrl = normalizedBaseUrl.endsWith("/internal")
    ? normalizedBaseUrl
    : `${normalizedBaseUrl}/internal`;
  return hc<HostDaemonInternalRoutes>(internalBaseUrl, {
    headers: {
      authorization: `Bearer ${hostKey}`,
    },
  });
}
