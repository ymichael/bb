export type EnvironmentAgentTransportKind = "http";
export const ENVIRONMENT_AGENT_PROTOCOL_VERSION = 1 as const;

export interface EnvironmentAgentProviderLaunchWrapper {
  command: string;
  args: string[];
}

export interface EnvironmentAgentProviderSpec {
  command: string;
  args: string[];
  launchCommand?: string;
  launchArgs?: string[];
  env?: Record<string, string>;
  files?: EnvironmentAgentProviderFile[];
}

export type EnvironmentAgentProviderFilePlacement = "home";

export interface EnvironmentAgentProviderFile {
  path: string;
  content: string;
  placement: EnvironmentAgentProviderFilePlacement;
}

export interface EnvironmentAgentProviderStatus {
  running: boolean;
  launched: boolean;
  pid?: number;
}

export type EnvironmentAgentConnectionTarget =
  {
    transport: "http";
    baseUrl: string;
    headers?: Record<string, string>;
    daemonConnection?: EnvironmentAgentDaemonConnectionConfig;
    providerLaunch?: EnvironmentAgentProviderLaunchWrapper;
  };

export interface EnvironmentAgentDaemonConnectionConfig {
  daemonUrl?: string;
  authToken?: string;
  threadId?: string;
  projectId?: string;
  environmentId?: string;
  lastAckedSequence?: number;
}

export interface EnvironmentAgentCommandMetadata {
  protocolVersion: typeof ENVIRONMENT_AGENT_PROTOCOL_VERSION;
  commandId: string;
  idempotencyKey: string;
  sentAt: number;
  threadId?: string;
  projectId?: string;
  expectedAfterSequence?: number;
}

export interface EnvironmentAgentInitializeRequest {
  method: string;
  params: unknown;
}

export type EnvironmentAgentCommand =
  | ({
      type: "provider.ensure";
      forThreadId?: string;
    } & EnvironmentAgentProviderSpec)
  | {
      type: "thread.start";
      threadId: string;
      projectId: string;
      params: unknown;
      initialize?: EnvironmentAgentInitializeRequest;
    }
  | {
      type: "thread.resume";
      threadId: string;
      projectId: string;
      providerThreadId: string;
      params: unknown;
      initialize?: EnvironmentAgentInitializeRequest;
    }
  | {
      type: "thread.stop";
      threadId: string;
      params?: unknown;
      initialize?: EnvironmentAgentInitializeRequest;
    }
  | {
      type: "turn.start";
      threadId: string;
      providerThreadId: string;
      params: unknown;
      initialize?: EnvironmentAgentInitializeRequest;
    }
  | {
      type: "turn.run";
      threadId: string;
      providerThreadId: string;
      requestedMode?: "auto" | "steer" | "start";
      activeTurnId?: string;
      startParams: unknown;
      steerParams?: unknown;
      initialize?: EnvironmentAgentInitializeRequest;
    }
  | {
      type: "turn.steer";
      threadId: string;
      providerThreadId: string;
      turnId: string;
      params: unknown;
      initialize?: EnvironmentAgentInitializeRequest;
    }
  | {
      type: "thread.rename";
      threadId: string;
      providerThreadId: string;
      title: string;
      params: unknown;
      initialize?: EnvironmentAgentInitializeRequest;
    }
  | {
      type: "workspace.status";
      threadId: string;
    }
  | {
      type: "workspace.diff";
      threadId: string;
    };

export interface EnvironmentAgentCommandEnvelope<
  TCommand extends EnvironmentAgentCommand = EnvironmentAgentCommand,
> {
  meta: EnvironmentAgentCommandMetadata;
  command: TCommand;
}

export type EnvironmentAgentCommandDeliveryState =
  | "accepted"
  | "duplicate"
  | "rejected";

export interface EnvironmentAgentCommandAck {
  protocolVersion: typeof ENVIRONMENT_AGENT_PROTOCOL_VERSION;
  commandId: string;
  idempotencyKey: string;
  state: EnvironmentAgentCommandDeliveryState;
  acknowledgedAt: number;
  latestSequence: number;
  errorCode?: string;
  message?: string;
  result?: unknown;
}

export type EnvironmentAgentEvent =
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

export interface EnvironmentAgentEventEnvelope<
  TEvent extends EnvironmentAgentEvent = EnvironmentAgentEvent,
> {
  protocolVersion: typeof ENVIRONMENT_AGENT_PROTOCOL_VERSION;
  sequence: number;
  emittedAt: number;
  threadId: string;
  event: TEvent;
}

export type EnvironmentAgentDeliveryReason =
  | "accepted"
  | "duplicate"
  | "sequence_gap"
  | "transport_error"
  | "thread_archived"
  | "thread_inactive";

export type EnvironmentAgentDeliveryRuntimeState =
  | "healthy"
  | "retrying"
  | "stalled"
  | "stopped";

export interface EnvironmentAgentStatusSnapshot {
  protocolVersion: typeof ENVIRONMENT_AGENT_PROTOCOL_VERSION;
  threadId?: string;
  projectId?: string;
  environmentId?: string;
  latestSequence: number;
  lastAckedSequence?: number;
  connectedToDaemon: boolean;
  pendingEventCount: number;
  pendingCommandCount: number;
  deliveryState: EnvironmentAgentDeliveryRuntimeState;
  deliveryIssue?: EnvironmentAgentDeliveryReason;
  retryAttemptCount: number;
  nextRetryAt?: number;
  lastDeliveryError?: string;
}

interface EnvironmentAgentControlMessageBase {
  environmentAgentMessage: true;
  requestId: string;
}

export type EnvironmentAgentControlRequest =
  | (EnvironmentAgentControlMessageBase & {
      type: "command";
      payload: EnvironmentAgentCommandEnvelope;
    })
  | (EnvironmentAgentControlMessageBase & {
      type: "provider.ensure";
      payload: EnvironmentAgentProviderSpec;
    })
  | (EnvironmentAgentControlMessageBase & {
      type: "status";
    });

export type EnvironmentAgentControlResponse =
  | (EnvironmentAgentControlMessageBase & {
      type: "command.response";
      payload: EnvironmentAgentCommandAck;
    })
  | (EnvironmentAgentControlMessageBase & {
      type: "provider.ensure.response";
      payload: EnvironmentAgentProviderStatus;
    })
  | (EnvironmentAgentControlMessageBase & {
      type: "status.response";
      payload: EnvironmentAgentStatusSnapshot;
    });

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function isEnvironmentAgentControlRequest(
  value: unknown,
): value is EnvironmentAgentControlRequest {
  const record = asRecord(value);
  if (!record) return false;
  if (record.environmentAgentMessage !== true) return false;
  if (typeof record.requestId !== "string" || record.requestId.length === 0) return false;
  const type = record.type;
  return (
    type === "command" ||
    type === "provider.ensure" ||
    type === "status"
  );
}

export function isEnvironmentAgentControlResponse(
  value: unknown,
): value is EnvironmentAgentControlResponse {
  const record = asRecord(value);
  if (!record) return false;
  if (record.environmentAgentMessage !== true) return false;
  if (typeof record.requestId !== "string" || record.requestId.length === 0) return false;
  const type = record.type;
  return (
    type === "command.response" ||
    type === "provider.ensure.response" ||
    type === "status.response"
  );
}
import type { Thread } from "@bb/core";
