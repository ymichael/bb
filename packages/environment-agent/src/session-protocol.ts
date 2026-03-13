import type {
  EnvironmentAgentCommand,
  EnvironmentAgentEvent,
} from "./protocol.js";

export const ENVIRONMENT_AGENT_SESSION_PROTOCOL =
  "beanbag.env-agent.v1" as const;
export const ENVIRONMENT_AGENT_SESSION_PROTOCOL_VERSION = 1 as const;

export type EnvironmentAgentSessionCloseReason =
  | "agent_shutdown"
  | "daemon_shutdown"
  | "lease_expired"
  | "newer_session"
  | "migration"
  | "internal_error";

export interface EnvironmentAgentSessionCursor {
  generation: number;
  sequence: number;
}

export interface EnvironmentAgentSessionCursorExclusive {
  generation: number;
  sequenceExclusive: number;
}

export interface EnvironmentAgentSessionChannelBootstrap {
  channelId: string;
  generation: number;
  lastDaemonAcked?: EnvironmentAgentSessionCursor;
}

export interface EnvironmentAgentSessionControlEndpoint {
  baseUrl: string;
  authToken: string;
}

export interface EnvironmentAgentSessionOpenPayload {
  agentId: string;
  agentInstanceId: string;
  supportedProtocolVersions: number[];
  controlEndpoint?: EnvironmentAgentSessionControlEndpoint;
  channels: EnvironmentAgentSessionChannelBootstrap[];
}

export interface EnvironmentAgentSessionWelcomeChannel {
  channelId: string;
  applyFrom: EnvironmentAgentSessionCursorExclusive;
}

export interface EnvironmentAgentSessionWelcomePayload {
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  protocolVersion: typeof ENVIRONMENT_AGENT_SESSION_PROTOCOL_VERSION;
  channels: EnvironmentAgentSessionWelcomeChannel[];
}

export interface EnvironmentAgentSessionHeartbeatChannel {
  channelId: string;
  lastSent?: EnvironmentAgentSessionCursor;
  lastAcked?: EnvironmentAgentSessionCursor;
}

export interface EnvironmentAgentSessionHeartbeatPayload {
  agentObservedAt: number;
  outboxDepth: number;
  channels: EnvironmentAgentSessionHeartbeatChannel[];
}

export interface EnvironmentAgentSessionEventBatchItem<
  TEvent extends EnvironmentAgentEvent = EnvironmentAgentEvent,
> {
  sequence: number;
  eventId: string;
  emittedAt: number;
  event: TEvent;
}

export interface EnvironmentAgentSessionEventBatchChannel<
  TEvent extends EnvironmentAgentEvent = EnvironmentAgentEvent,
> {
  channelId: string;
  generation: number;
  events: EnvironmentAgentSessionEventBatchItem<TEvent>[];
}

export interface EnvironmentAgentSessionEventBatchPayload<
  TEvent extends EnvironmentAgentEvent = EnvironmentAgentEvent,
> {
  batches: EnvironmentAgentSessionEventBatchChannel<TEvent>[];
}

export interface EnvironmentAgentSessionEventAckChannel {
  channelId: string;
  ackedThrough: EnvironmentAgentSessionCursor;
}

export interface EnvironmentAgentSessionEventAckPayload {
  channels: EnvironmentAgentSessionEventAckChannel[];
}

export interface EnvironmentAgentSessionCommandBatchItem<
  TCommand extends EnvironmentAgentCommand = EnvironmentAgentCommand,
> {
  channelId: string;
  commandCursor: number;
  commandId: string;
  createdAt: number;
  command: TCommand;
}

export interface EnvironmentAgentSessionCommandBatchPayload<
  TCommand extends EnvironmentAgentCommand = EnvironmentAgentCommand,
> {
  commands: EnvironmentAgentSessionCommandBatchItem<TCommand>[];
}

export type EnvironmentAgentSessionCommandAckState =
  | "received"
  | "duplicate";

export interface EnvironmentAgentSessionCommandAckItem {
  commandId: string;
  channelId: string;
  state: EnvironmentAgentSessionCommandAckState;
}

export interface EnvironmentAgentSessionCommandAckPayload {
  commands: EnvironmentAgentSessionCommandAckItem[];
}

export type EnvironmentAgentSessionCommandResultState =
  | "started"
  | "completed"
  | "failed";

export interface EnvironmentAgentSessionCommandResultPayload {
  commandId: string;
  channelId: string;
  state: EnvironmentAgentSessionCommandResultState;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export interface EnvironmentAgentSessionProviderRequestPayload {
  requestId: string | number;
  method: string;
  params?: unknown;
}

export interface EnvironmentAgentSessionProviderResponsePayload {
  requestId: string | number;
  ok: boolean;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export interface EnvironmentAgentSessionClosePayload {
  reason: EnvironmentAgentSessionCloseReason;
}

export interface EnvironmentAgentSessionReplacedPayload {
  reason: "newer_session";
}

interface EnvironmentAgentSessionMessageBase {
  protocol: typeof ENVIRONMENT_AGENT_SESSION_PROTOCOL;
  messageId: string;
  sentAt: number;
}

interface EnvironmentAgentSessionBoundMessageBase
  extends EnvironmentAgentSessionMessageBase {
  sessionId: string;
}

export interface EnvironmentAgentSessionOpenMessage
  extends EnvironmentAgentSessionMessageBase {
  type: "session_open";
  payload: EnvironmentAgentSessionOpenPayload;
}

export interface EnvironmentAgentSessionWelcomeMessage
  extends EnvironmentAgentSessionBoundMessageBase {
  type: "session_welcome";
  payload: EnvironmentAgentSessionWelcomePayload;
}

export interface EnvironmentAgentSessionHeartbeatMessage
  extends EnvironmentAgentSessionBoundMessageBase {
  type: "heartbeat";
  payload: EnvironmentAgentSessionHeartbeatPayload;
}

export interface EnvironmentAgentSessionEventBatchMessage<
  TEvent extends EnvironmentAgentEvent = EnvironmentAgentEvent,
> extends EnvironmentAgentSessionBoundMessageBase {
  type: "event_batch";
  payload: EnvironmentAgentSessionEventBatchPayload<TEvent>;
}

export interface EnvironmentAgentSessionEventAckMessage
  extends EnvironmentAgentSessionBoundMessageBase {
  type: "event_ack";
  payload: EnvironmentAgentSessionEventAckPayload;
}

export interface EnvironmentAgentSessionCommandBatchMessage<
  TCommand extends EnvironmentAgentCommand = EnvironmentAgentCommand,
> extends EnvironmentAgentSessionBoundMessageBase {
  type: "command_batch";
  payload: EnvironmentAgentSessionCommandBatchPayload<TCommand>;
}

export interface EnvironmentAgentSessionCommandAckMessage
  extends EnvironmentAgentSessionBoundMessageBase {
  type: "command_ack";
  payload: EnvironmentAgentSessionCommandAckPayload;
}

export interface EnvironmentAgentSessionCommandResultMessage
  extends EnvironmentAgentSessionBoundMessageBase {
  type: "command_result";
  payload: EnvironmentAgentSessionCommandResultPayload;
}

export interface EnvironmentAgentSessionProviderRequestMessage
  extends EnvironmentAgentSessionBoundMessageBase {
  type: "provider_request";
  payload: EnvironmentAgentSessionProviderRequestPayload;
}

export interface EnvironmentAgentSessionProviderResponseMessage
  extends EnvironmentAgentSessionBoundMessageBase {
  type: "provider_response";
  payload: EnvironmentAgentSessionProviderResponsePayload;
}

export interface EnvironmentAgentSessionCloseMessage
  extends EnvironmentAgentSessionBoundMessageBase {
  type: "session_close";
  payload: EnvironmentAgentSessionClosePayload;
}

export interface EnvironmentAgentSessionReplacedMessage
  extends EnvironmentAgentSessionBoundMessageBase {
  type: "session_replaced";
  payload: EnvironmentAgentSessionReplacedPayload;
}

export type EnvironmentAgentSessionClientMessage =
  | EnvironmentAgentSessionOpenMessage
  | EnvironmentAgentSessionHeartbeatMessage
  | EnvironmentAgentSessionEventBatchMessage
  | EnvironmentAgentSessionCommandAckMessage
  | EnvironmentAgentSessionCommandResultMessage
  | EnvironmentAgentSessionProviderRequestMessage
  | EnvironmentAgentSessionCloseMessage;

export type EnvironmentAgentSessionServerMessage =
  | EnvironmentAgentSessionWelcomeMessage
  | EnvironmentAgentSessionEventAckMessage
  | EnvironmentAgentSessionCommandBatchMessage
  | EnvironmentAgentSessionProviderResponseMessage
  | EnvironmentAgentSessionSessionControlMessage;

export type EnvironmentAgentSessionSessionControlMessage =
  | EnvironmentAgentSessionCloseMessage
  | EnvironmentAgentSessionReplacedMessage;

export type EnvironmentAgentSessionMessage =
  | EnvironmentAgentSessionClientMessage
  | EnvironmentAgentSessionServerMessage;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasBaseMessageFields(
  value: unknown,
): value is Record<string, unknown> & {
  protocol: typeof ENVIRONMENT_AGENT_SESSION_PROTOCOL;
  messageId: string;
  sentAt: number;
  type: string;
} {
  const record = asRecord(value);
  if (!record) return false;
  return (
    record.protocol === ENVIRONMENT_AGENT_SESSION_PROTOCOL &&
    typeof record.messageId === "string" &&
    record.messageId.length > 0 &&
    typeof record.sentAt === "number" &&
    Number.isFinite(record.sentAt) &&
    typeof record.type === "string"
  );
}

export function isEnvironmentAgentSessionCursor(
  value: unknown,
): value is EnvironmentAgentSessionCursor {
  const record = asRecord(value);
  if (!record) return false;
  return (
    typeof record.generation === "number" &&
    Number.isInteger(record.generation) &&
    record.generation >= 0 &&
    typeof record.sequence === "number" &&
    Number.isInteger(record.sequence) &&
    record.sequence >= 0
  );
}

export function compareEnvironmentAgentSessionCursors(
  left: EnvironmentAgentSessionCursor,
  right: EnvironmentAgentSessionCursor,
): number {
  if (left.generation !== right.generation) {
    return left.generation - right.generation;
  }
  return left.sequence - right.sequence;
}

export function isEnvironmentAgentSessionMessage(
  value: unknown,
): value is EnvironmentAgentSessionMessage {
  if (!hasBaseMessageFields(value)) return false;

  switch (value.type) {
    case "session_open":
      return true;
    case "session_welcome":
    case "heartbeat":
    case "event_batch":
    case "event_ack":
    case "command_batch":
    case "command_ack":
    case "command_result":
    case "provider_request":
    case "session_close":
    case "session_replaced":
      return typeof value.sessionId === "string" && value.sessionId.length > 0;
    default:
      return false;
  }
}

export function isEnvironmentAgentSessionClientMessage(
  value: unknown,
): value is EnvironmentAgentSessionClientMessage {
  if (!isEnvironmentAgentSessionMessage(value)) return false;
  switch (value.type) {
    case "session_open":
    case "heartbeat":
    case "event_batch":
    case "command_ack":
    case "command_result":
    case "provider_request":
    case "session_close":
      return true;
    case "session_welcome":
    case "event_ack":
    case "command_batch":
    case "session_replaced":
      return false;
    default:
      return false;
  }
}

export function isEnvironmentAgentSessionServerMessage(
  value: unknown,
): value is EnvironmentAgentSessionServerMessage {
  if (!isEnvironmentAgentSessionMessage(value)) return false;
  switch (value.type) {
    case "session_welcome":
    case "event_ack":
    case "command_batch":
    case "provider_response":
    case "session_close":
    case "session_replaced":
      return true;
    case "session_open":
    case "heartbeat":
    case "event_batch":
    case "command_ack":
    case "command_result":
      return false;
    default:
      return false;
  }
}
