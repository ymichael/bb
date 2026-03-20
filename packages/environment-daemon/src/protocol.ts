import type {
  PromptInput,
  SpawnThreadRequest,
  Thread,
} from "@bb/core";
import { promptInputSchema } from "@bb/core";
import type {
  ProviderDynamicTool,
  ProviderExecutionOptions,
  ProviderThreadContext,
} from "@bb/provider-adapters";
import { z } from "zod";

export type EnvironmentDaemonTransportKind = "http";
export const ENVIRONMENT_DAEMON_PROTOCOL_VERSION = 1 as const;

export interface EnvironmentDaemonProviderLaunchWrapper {
  command: string;
  args: string[];
}

export interface EnvironmentDaemonProviderSpec {
  command: string;
  args: string[];
  launchCommand?: string;
  launchArgs?: string[];
  env?: Record<string, string>;
  files?: EnvironmentDaemonProviderFile[];
}

export type EnvironmentDaemonProviderFilePlacement = "home";

export interface EnvironmentDaemonProviderFile {
  path: string;
  content: string;
  placement: EnvironmentDaemonProviderFilePlacement;
}

export interface EnvironmentDaemonProviderStatus {
  running: boolean;
  launched: boolean;
  pid?: number;
}

export type EnvironmentDaemonConnectionTarget =
  {
    transport: "http";
    baseUrl: string;
    headers?: Record<string, string>;
    serverConnection?: EnvironmentDaemonServerConnectionConfig;
    providerLaunch?: EnvironmentDaemonProviderLaunchWrapper;
  };

export interface EnvironmentDaemonServerConnectionConfig {
  serverUrl?: string;
  authToken?: string;
  threadId?: string;
  projectId?: string;
  environmentId?: string;
  lastAckedSequence?: number;
}


export interface EnvironmentDaemonCommandMetadata {
  protocolVersion: typeof ENVIRONMENT_DAEMON_PROTOCOL_VERSION;
  commandId: string;
  idempotencyKey: string;
  sentAt: number;
  threadId?: string;
  projectId?: string;
  expectedAfterSequence?: number;
}

export interface EnvironmentDaemonInitializeRequest {
  method: string;
  params: unknown;
}

export type EnvironmentDaemonCommand =
  | {
      type: "provider.ensure";
      forThreadId?: string;
      providerId?: string;
      context?: ProviderThreadContext;
      providerLaunch?: EnvironmentDaemonProviderLaunchWrapper;
      command?: string;
      args?: string[];
      launchCommand?: string;
      launchArgs?: string[];
      env?: Record<string, string>;
      files?: EnvironmentDaemonProviderFile[];
    }
  | {
      type: "thread.start";
      threadId: string;
      projectId: string;
      request?: SpawnThreadRequest;
      context?: ProviderThreadContext;
      dynamicTools?: ProviderDynamicTool[];
      initialize?: EnvironmentDaemonInitializeRequest;
    }
  | {
      type: "thread.resume";
      threadId: string;
      projectId: string;
      providerThreadId?: string;
      context?: ProviderThreadContext;
      options?: ProviderExecutionOptions;
      resumePath?: string;
      dynamicTools?: ProviderDynamicTool[];
      initialize?: EnvironmentDaemonInitializeRequest;
    }
  | {
      type: "thread.stop";
      threadId: string;
      initialize?: EnvironmentDaemonInitializeRequest;
    }
  | {
      type: "turn.run";
      threadId: string;
      providerThreadId?: string;
      requestedMode?: "auto" | "steer" | "start";
      activeTurnId?: string;
      input?: PromptInput[];
      options?: ProviderExecutionOptions;
      initialize?: EnvironmentDaemonInitializeRequest;
    }
  | {
      type: "thread.rename";
      threadId: string;
      providerThreadId?: string;
      title: string;
      initialize?: EnvironmentDaemonInitializeRequest;
    }
  | {
      type: "provider.list_models";
      providerId?: string;
    }
  | {
      type: "provider.list_catalog";
    }
  | {
      type: "workspace.status";
      threadId: string;
    }
  | {
      type: "workspace.diff";
      threadId: string;
    };

export interface EnvironmentDaemonCommandEnvelope<
  TCommand extends EnvironmentDaemonCommand = EnvironmentDaemonCommand,
> {
  meta: EnvironmentDaemonCommandMetadata;
  command: TCommand;
}

export type EnvironmentDaemonCommandDeliveryState =
  | "accepted"
  | "duplicate"
  | "rejected";

export interface EnvironmentDaemonCommandAck {
  protocolVersion: typeof ENVIRONMENT_DAEMON_PROTOCOL_VERSION;
  commandId: string;
  idempotencyKey: string;
  state: EnvironmentDaemonCommandDeliveryState;
  acknowledgedAt: number;
  latestSequence: number;
  errorCode?: string;
  message?: string;
  result?: unknown;
}

export type EnvironmentDaemonEvent =
  | {
      type: "environment.ready";
      threadId: string;
    }
  | {
      type: "environment.degraded";
      threadId: string;
      message: string;
    }
  | {
      type: "thread.started";
      threadId: string;
      providerThreadId: string;
    }
  | {
      type: "thread.stopped";
      threadId: string;
    }
  | {
      type: "turn.started";
      threadId: string;
      turnId?: string;
    }
  | {
      type: "turn.completed";
      threadId: string;
      turnId?: string;
    }
  | {
      type: "provider.event";
      threadId: string;
      method: string;
      payload: unknown;
      providerId?: string;
      normalizedMethod?: string;
      shouldPersist?: boolean;
      shouldBroadcast?: boolean;
      nextStatus?: Thread["status"];
      title?: string;
      turnState?: "active" | "idle";
      turnId?: string;
    }
  | {
      type: "provider.stderr";
      threadId: string;
      line: string;
    }
  | {
      type: "provider.rpc_error";
      threadId: string;
      requestId: string | number;
      message: string;
    }
  | {
      type: "workspace.status.changed";
      threadId: string;
    };

export interface EnvironmentDaemonEventEnvelope<
  TEvent extends EnvironmentDaemonEvent = EnvironmentDaemonEvent,
> {
  protocolVersion: typeof ENVIRONMENT_DAEMON_PROTOCOL_VERSION;
  sequence: number;
  emittedAt: number;
  threadId: string;
  event: TEvent;
}

export type EnvironmentDaemonDeliveryReason =
  | "accepted"
  | "duplicate"
  | "sequence_gap"
  | "transport_error"
  | "thread_archived"
  | "thread_inactive";

export type EnvironmentDaemonDeliveryRuntimeState =
  | "healthy"
  | "retrying"
  | "stalled"
  | "stopped";

export interface EnvironmentDaemonStatusSnapshot {
  protocolVersion: typeof ENVIRONMENT_DAEMON_PROTOCOL_VERSION;
  threadId?: string;
  projectId?: string;
  environmentId?: string;
  latestSequence: number;
  lastAckedSequence?: number;
  connectedToServer: boolean;
  pendingEventCount: number;
  pendingCommandCount: number;
  deliveryState: EnvironmentDaemonDeliveryRuntimeState;
  deliveryIssue?: EnvironmentDaemonDeliveryReason;
  retryAttemptCount: number;
  nextRetryAt?: number;
  lastDeliveryError?: string;
}

interface EnvironmentDaemonControlMessageBase {
  environmentDaemonMessage: true;
  requestId: string;
}

export type EnvironmentDaemonControlRequest =
  | (EnvironmentDaemonControlMessageBase & {
      type: "command";
      payload: EnvironmentDaemonCommandEnvelope;
    })
  | (EnvironmentDaemonControlMessageBase & {
      type: "provider.ensure";
      payload: EnvironmentDaemonProviderSpec;
    })
  | (EnvironmentDaemonControlMessageBase & {
      type: "status";
    });

export type EnvironmentDaemonControlResponse =
  | (EnvironmentDaemonControlMessageBase & {
      type: "command.response";
      payload: EnvironmentDaemonCommandAck;
    })
  | (EnvironmentDaemonControlMessageBase & {
      type: "provider.ensure.response";
      payload: EnvironmentDaemonProviderStatus;
    })
  | (EnvironmentDaemonControlMessageBase & {
      type: "status.response";
      payload: EnvironmentDaemonStatusSnapshot;
    });

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function isEnvironmentDaemonControlRequest(
  value: unknown,
): value is EnvironmentDaemonControlRequest {
  const record = asRecord(value);
  if (!record) return false;
  if (record.environmentDaemonMessage !== true) return false;
  if (typeof record.requestId !== "string" || record.requestId.length === 0) return false;
  const type = record.type;
  return (
    type === "command" ||
    type === "provider.ensure" ||
    type === "status"
  );
}

export function isEnvironmentDaemonControlResponse(
  value: unknown,
): value is EnvironmentDaemonControlResponse {
  const record = asRecord(value);
  if (!record) return false;
  if (record.environmentDaemonMessage !== true) return false;
  if (typeof record.requestId !== "string" || record.requestId.length === 0) return false;
  const type = record.type;
  return (
    type === "command.response" ||
    type === "provider.ensure.response" ||
    type === "status.response"
  );
}

const ENVIRONMENT_DAEMON_COMMAND_TYPES = [
  "provider.ensure",
  "thread.start",
  "thread.resume",
  "thread.stop",
  "turn.run",
  "thread.rename",
  "provider.list_models",
  "provider.list_catalog",
  "workspace.status",
  "workspace.diff",
] as const satisfies readonly EnvironmentDaemonCommand["type"][];

function decodeEnvironmentDaemonCommandType(
  value: string,
): EnvironmentDaemonCommand["type"] | null {
  return ENVIRONMENT_DAEMON_COMMAND_TYPES.find((candidate) => candidate === value) ?? null;
}

const nonEmptyStringSchema = z.string().min(1);
const stringArraySchema = z.array(z.string());
const stringRecordSchema = z.record(z.string());
const providerFileSchema = z.object({
  path: nonEmptyStringSchema,
  content: nonEmptyStringSchema,
  placement: z.literal("home"),
});
const providerLaunchSchema = z.object({
  command: nonEmptyStringSchema,
  args: stringArraySchema,
});
const initializeRequestSchema = z.object({
  method: nonEmptyStringSchema,
  params: z.unknown(),
});
const providerThreadContextSchema = z.object({
  projectId: nonEmptyStringSchema,
  threadId: nonEmptyStringSchema,
  serverUrl: nonEmptyStringSchema.optional(),
  path: nonEmptyStringSchema.optional(),
});
const providerDynamicToolSchema = z.object({
  name: nonEmptyStringSchema,
  description: z.string(),
  inputSchema: z.unknown(),
});
const providerExecutionOptionsSchema = z.object({
  model: z.string().optional(),
  serviceTier: z.enum(["fast", "flex"]).optional(),
  reasoningLevel: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  sandboxMode: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .optional(),
});
const environmentDescriptorSchema = z.object({
  type: z.literal("path"),
  path: nonEmptyStringSchema,
});
const environmentCreationArgsSchema = z.object({
  kind: nonEmptyStringSchema,
});
const spawnThreadRequestSchema = z
  .object({
    projectId: nonEmptyStringSchema,
    providerId: nonEmptyStringSchema.optional(),
    type: z.enum(["standard", "manager"]).optional(),
    title: nonEmptyStringSchema.optional(),
    input: z.array(promptInputSchema).min(1).optional(),
    model: z.string().optional(),
    serviceTier: z.enum(["fast", "flex"]).optional(),
    reasoningLevel: z.enum(["low", "medium", "high", "xhigh"]).optional(),
    sandboxMode: z
      .enum(["read-only", "workspace-write", "danger-full-access"])
      .optional(),
    environmentId: nonEmptyStringSchema.optional(),
    environmentDescriptor: environmentDescriptorSchema.optional(),
    environmentCreationArgs: environmentCreationArgsSchema.optional(),
    developerInstructions: z.string().optional(),
    parentThreadId: z.string().optional(),
    spawnInitiator: z.enum(["user", "agent", "system"]).optional(),
  })
  .superRefine((value, ctx) => {
    const selectedCount = [
      value.environmentId !== undefined,
      value.environmentDescriptor !== undefined,
      value.environmentCreationArgs !== undefined,
    ].filter(Boolean).length;
    if (selectedCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide at most one of environmentId, environmentDescriptor, or environmentCreationArgs",
        path: ["environmentId"],
      });
    }
  });

const providerEnsureCommandSchema = z
  .object({
    type: z.literal("provider.ensure"),
    forThreadId: nonEmptyStringSchema.optional(),
    providerId: nonEmptyStringSchema.optional(),
    context: providerThreadContextSchema.optional(),
    providerLaunch: providerLaunchSchema.optional(),
    command: nonEmptyStringSchema.optional(),
    args: stringArraySchema.optional(),
    launchCommand: nonEmptyStringSchema.optional(),
    launchArgs: stringArraySchema.optional(),
    env: stringRecordSchema.optional(),
    files: z.array(providerFileSchema).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.command && !value.providerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider.ensure requires command or providerId",
        path: ["command"],
      });
    }
  });
const threadStartCommandSchema = z.object({
  type: z.literal("thread.start"),
  threadId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  request: spawnThreadRequestSchema.optional(),
  context: providerThreadContextSchema.optional(),
  dynamicTools: z.array(providerDynamicToolSchema).optional(),
  initialize: initializeRequestSchema.optional(),
});
const threadResumeCommandSchema = z.object({
  type: z.literal("thread.resume"),
  threadId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  providerThreadId: nonEmptyStringSchema.optional(),
  context: providerThreadContextSchema.optional(),
  options: providerExecutionOptionsSchema.optional(),
  resumePath: nonEmptyStringSchema.optional(),
  dynamicTools: z.array(providerDynamicToolSchema).optional(),
  initialize: initializeRequestSchema.optional(),
});
const threadStopCommandSchema = z.object({
  type: z.literal("thread.stop"),
  threadId: nonEmptyStringSchema,
  initialize: initializeRequestSchema.optional(),
});
const turnRunCommandSchema = z.object({
  type: z.literal("turn.run"),
  threadId: nonEmptyStringSchema,
  providerThreadId: nonEmptyStringSchema.optional(),
  requestedMode: z.enum(["auto", "steer", "start"]).optional(),
  activeTurnId: nonEmptyStringSchema.optional(),
  input: z.array(promptInputSchema),
  options: providerExecutionOptionsSchema.optional(),
  initialize: initializeRequestSchema.optional(),
});
const threadRenameCommandSchema = z.object({
  type: z.literal("thread.rename"),
  threadId: nonEmptyStringSchema,
  providerThreadId: nonEmptyStringSchema.optional(),
  title: nonEmptyStringSchema,
  initialize: initializeRequestSchema.optional(),
});
const providerListModelsCommandSchema = z.object({
  type: z.literal("provider.list_models"),
  providerId: nonEmptyStringSchema.optional(),
});
const providerListCatalogCommandSchema = z.object({
  type: z.literal("provider.list_catalog"),
});
const workspaceStatusCommandSchema = z.object({
  type: z.literal("workspace.status"),
  threadId: nonEmptyStringSchema,
});
const workspaceDiffCommandSchema = z.object({
  type: z.literal("workspace.diff"),
  threadId: nonEmptyStringSchema,
});

const environmentDaemonCommandSchemas = {
  "provider.ensure": providerEnsureCommandSchema,
  "thread.start": threadStartCommandSchema,
  "thread.resume": threadResumeCommandSchema,
  "thread.stop": threadStopCommandSchema,
  "turn.run": turnRunCommandSchema,
  "thread.rename": threadRenameCommandSchema,
  "provider.list_models": providerListModelsCommandSchema,
  "provider.list_catalog": providerListCatalogCommandSchema,
  "workspace.status": workspaceStatusCommandSchema,
  "workspace.diff": workspaceDiffCommandSchema,
} satisfies Record<EnvironmentDaemonCommand["type"], z.ZodTypeAny>;

function formatSchemaError(commandType: string, error: z.ZodError): Error {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "payload";
    return `${path}: ${issue.message}`;
  });
  return new Error(
    `Invalid persisted environment-daemon command payload for ${commandType}: ${issues.join("; ")}`,
  );
}

export function decodePersistedEnvironmentDaemonCommand(args: {
  commandType: string;
  payload: unknown;
}): EnvironmentDaemonCommand {
  const commandType = decodeEnvironmentDaemonCommandType(args.commandType);
  if (!commandType) {
    throw new Error(`Unsupported environment-daemon command type ${args.commandType}`);
  }
  const payload = asRecord(args.payload);
  if (!payload) {
    throw new Error(`Invalid persisted environment-daemon command payload for ${commandType}`);
  }
  if ("type" in payload && payload.type !== commandType) {
    throw new Error(`Environment-daemon command payload type mismatch for ${commandType}`);
  }
  const parseResult = environmentDaemonCommandSchemas[commandType].safeParse({
    ...payload,
    type: commandType,
  });
  if (!parseResult.success) {
    throw formatSchemaError(commandType, parseResult.error);
  }

  return parseResult.data as EnvironmentDaemonCommand;
}
