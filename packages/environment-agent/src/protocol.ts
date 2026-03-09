export type EnvironmentAgentTransportKind = "command-stdio" | "http";
export const ENVIRONMENT_AGENT_PROTOCOL_VERSION = 1 as const;

export type EnvironmentAgentConnectionTarget =
  | {
      transport: "command-stdio";
      command: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string | undefined>;
      daemonConnection?: EnvironmentAgentDaemonConnectionConfig;
      providerLaunch?: {
        command: string;
        args: string[];
      };
    }
  | {
      transport: "http";
      baseUrl: string;
      headers?: Record<string, string>;
      daemonConnection?: EnvironmentAgentDaemonConnectionConfig;
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

export type EnvironmentAgentCommand =
  | {
      type: "thread.start";
      threadId: string;
      projectId: string;
    }
  | {
      type: "thread.resume";
      threadId: string;
      projectId: string;
      providerThreadId: string;
    }
  | {
      type: "thread.stop";
      threadId: string;
    }
  | {
      type: "turn.start";
      threadId: string;
      providerThreadId: string;
    }
  | {
      type: "turn.steer";
      threadId: string;
      providerThreadId: string;
      turnId: string;
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
  message?: string;
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

export interface EnvironmentAgentReplayCursor {
  sequence: number;
}

export interface EnvironmentAgentReplayRequest {
  protocolVersion: typeof ENVIRONMENT_AGENT_PROTOCOL_VERSION;
  afterSequence: number;
  limit?: number;
  threadId?: string;
}

export interface EnvironmentAgentReplayResponse {
  protocolVersion: typeof ENVIRONMENT_AGENT_PROTOCOL_VERSION;
  fromSequenceExclusive: number;
  toSequenceInclusive: number;
  events: EnvironmentAgentEventEnvelope[];
  hasMore: boolean;
}

export interface EnvironmentAgentAckRequest {
  protocolVersion: typeof ENVIRONMENT_AGENT_PROTOCOL_VERSION;
  sequence: number;
  threadId?: string;
}

export interface EnvironmentAgentAckResponse {
  protocolVersion: typeof ENVIRONMENT_AGENT_PROTOCOL_VERSION;
  acknowledgedSequence: number;
  threadId?: string;
}

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
}

interface EnvironmentAgentControlMessageBase {
  environmentAgentMessage: true;
  requestId: string;
}

export type EnvironmentAgentControlRequest =
  | (EnvironmentAgentControlMessageBase & {
      type: "ack";
      payload: EnvironmentAgentAckRequest;
    })
  | (EnvironmentAgentControlMessageBase & {
      type: "replay";
      payload: EnvironmentAgentReplayRequest;
    })
  | (EnvironmentAgentControlMessageBase & {
      type: "status";
    });

export type EnvironmentAgentControlResponse =
  | (EnvironmentAgentControlMessageBase & {
      type: "ack.response";
      payload: EnvironmentAgentAckResponse;
    })
  | (EnvironmentAgentControlMessageBase & {
      type: "replay.response";
      payload: EnvironmentAgentReplayResponse;
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
  return type === "ack" || type === "replay" || type === "status";
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
    type === "ack.response" ||
    type === "replay.response" ||
    type === "status.response"
  );
}
