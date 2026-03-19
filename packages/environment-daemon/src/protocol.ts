import type {
  PromptInput,
  ProviderDynamicTool,
  ProviderExecutionOptions,
  ProviderThreadContext,
  SpawnThreadRequest,
  Thread,
} from "@bb/core";

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
      providerThreadId: string;
      context?: ProviderThreadContext;
      options?: ProviderExecutionOptions;
      resumePath?: string;
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
      providerThreadId: string;
      requestedMode?: "auto" | "steer" | "start";
      activeTurnId?: string;
      input?: PromptInput[];
      options?: ProviderExecutionOptions;
      initialize?: EnvironmentDaemonInitializeRequest;
    }
  | {
      type: "thread.rename";
      threadId: string;
      providerThreadId: string;
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
