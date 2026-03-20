import type {
  ProviderToolCallRequest,
  ProviderToolCallResponse,
} from "@bb/provider-adapters";
import type {
  EnvironmentDaemonCommand,
  EnvironmentDaemonEvent,
} from "./protocol.js";

export const ENVIRONMENT_DAEMON_SESSION_PROTOCOL =
  "bb.env-daemon.v1" as const;
export const ENVIRONMENT_DAEMON_SESSION_PROTOCOL_VERSION = 1 as const;
export const ENVIRONMENT_DAEMON_SESSION_SUPPORTED_PROTOCOL_VERSIONS = [
  ENVIRONMENT_DAEMON_SESSION_PROTOCOL_VERSION,
] as const;
export type EnvironmentDaemonSessionProtocolVersion =
  (typeof ENVIRONMENT_DAEMON_SESSION_SUPPORTED_PROTOCOL_VERSIONS)[number];

export const ENVIRONMENT_DAEMON_SESSION_CAPABILITY_COMMANDS = [
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
export type EnvironmentDaemonSessionCapabilityCommand =
  (typeof ENVIRONMENT_DAEMON_SESSION_CAPABILITY_COMMANDS)[number];

export const ENVIRONMENT_DAEMON_SESSION_CAPABILITY_FEATURES = [
  "worker_metadata",
  "provider_metadata",
  "provider_runtime_version",
  "control_endpoint",
] as const;
export type EnvironmentDaemonSessionCapabilityFeature =
  (typeof ENVIRONMENT_DAEMON_SESSION_CAPABILITY_FEATURES)[number];

export type EnvironmentDaemonSessionCloseReason =
  | "agent_shutdown"
  | "server_shutdown"
  | "lease_expired"
  | "newer_session"
  | "migration"
  | "internal_error";

export interface EnvironmentDaemonSessionCursor {
  generation: number;
  sequence: number;
}

export interface EnvironmentDaemonSessionCursorExclusive {
  generation: number;
  sequenceExclusive: number;
}

export interface EnvironmentDaemonSessionChannelBootstrap {
  channelId: string;
  generation: number;
  lastServerAcked?: EnvironmentDaemonSessionCursor;
}

export interface EnvironmentDaemonSessionControlEndpoint {
  baseUrl: string;
  authToken: string;
}

export interface EnvironmentDaemonSessionWorkerMetadata {
  name: string;
  version: string;
  buildId?: string;
}

export interface EnvironmentDaemonSessionProviderMetadata {
  providerId: string;
  adapterVersion: string;
  runtimeVersion?: string;
}

export interface EnvironmentDaemonSessionCapabilities {
  commands: EnvironmentDaemonSessionCapabilityCommand[];
  features: EnvironmentDaemonSessionCapabilityFeature[];
}

const LEGACY_INFERRED_COMMANDS = [
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
] as const satisfies readonly EnvironmentDaemonSessionCapabilityCommand[];

export interface EnvironmentDaemonSessionOpenPayload {
  agentId: string;
  agentInstanceId: string;
  supportedProtocolVersions: number[];
  capabilities?: EnvironmentDaemonSessionCapabilities;
  worker?: EnvironmentDaemonSessionWorkerMetadata;
  providers?: EnvironmentDaemonSessionProviderMetadata[];
  controlEndpoint?: EnvironmentDaemonSessionControlEndpoint;
  channels: EnvironmentDaemonSessionChannelBootstrap[];
}

export interface EnvironmentDaemonSessionWelcomeChannel {
  channelId: string;
  applyFrom: EnvironmentDaemonSessionCursorExclusive;
}

export interface EnvironmentDaemonSessionWelcomePayload {
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  protocolVersion: EnvironmentDaemonSessionProtocolVersion;
  selectedCapabilities?: EnvironmentDaemonSessionCapabilities;
  channels: EnvironmentDaemonSessionWelcomeChannel[];
}

export function selectEnvironmentDaemonSessionProtocolVersion(args: {
  supportedByServer: readonly EnvironmentDaemonSessionProtocolVersion[];
  supportedByAgent: readonly number[];
}): EnvironmentDaemonSessionProtocolVersion | undefined {
  const agentSupportedVersions = new Set(args.supportedByAgent);
  for (const version of [...args.supportedByServer].sort((a, b) => b - a)) {
    if (agentSupportedVersions.has(version)) {
      return version;
    }
  }
  return undefined;
}

function uniqueInOrder<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function isKnownCommand(
  value: string,
): value is EnvironmentDaemonSessionCapabilityCommand {
  return ENVIRONMENT_DAEMON_SESSION_CAPABILITY_COMMANDS.includes(
    value as EnvironmentDaemonSessionCapabilityCommand,
  );
}

function isKnownFeature(
  value: string,
): value is EnvironmentDaemonSessionCapabilityFeature {
  return ENVIRONMENT_DAEMON_SESSION_CAPABILITY_FEATURES.includes(
    value as EnvironmentDaemonSessionCapabilityFeature,
  );
}

export function inferEnvironmentDaemonSessionCapabilities(args: {
  worker?: EnvironmentDaemonSessionWorkerMetadata;
  providers?: EnvironmentDaemonSessionProviderMetadata[];
  controlEndpoint?: EnvironmentDaemonSessionControlEndpoint;
}): EnvironmentDaemonSessionCapabilities {
  const features: EnvironmentDaemonSessionCapabilityFeature[] = [];
  if (args.worker) {
    features.push("worker_metadata");
  }
  if (args.providers && args.providers.length > 0) {
    features.push("provider_metadata");
    if (args.providers.some((provider) => provider.runtimeVersion?.trim())) {
      features.push("provider_runtime_version");
    }
  }
  if (args.controlEndpoint) {
    features.push("control_endpoint");
  }
  return {
    commands: [...LEGACY_INFERRED_COMMANDS],
    features,
  };
}

export function createEnvironmentDaemonSessionCapabilities(args: {
  worker?: EnvironmentDaemonSessionWorkerMetadata;
  providers?: EnvironmentDaemonSessionProviderMetadata[];
  controlEndpoint?: EnvironmentDaemonSessionControlEndpoint;
}): EnvironmentDaemonSessionCapabilities {
  const inferred = inferEnvironmentDaemonSessionCapabilities(args);
  return {
    commands: [...ENVIRONMENT_DAEMON_SESSION_CAPABILITY_COMMANDS],
    features: inferred.features,
  };
}

export function normalizeEnvironmentDaemonSessionCapabilities(
  capabilities: Partial<EnvironmentDaemonSessionCapabilities> | undefined,
): EnvironmentDaemonSessionCapabilities {
  return {
    commands: uniqueInOrder(
      (capabilities?.commands ?? []).filter((value): value is EnvironmentDaemonSessionCapabilityCommand =>
        typeof value === "string" && isKnownCommand(value)
      ),
    ),
    features: uniqueInOrder(
      (capabilities?.features ?? []).filter((value): value is EnvironmentDaemonSessionCapabilityFeature =>
        typeof value === "string" && isKnownFeature(value)
      ),
    ),
  };
}

export function negotiateEnvironmentDaemonSessionCapabilities(args: {
  requested?: Partial<EnvironmentDaemonSessionCapabilities>;
  fallback: {
    worker?: EnvironmentDaemonSessionWorkerMetadata;
    providers?: EnvironmentDaemonSessionProviderMetadata[];
    controlEndpoint?: EnvironmentDaemonSessionControlEndpoint;
  };
}): EnvironmentDaemonSessionCapabilities {
  const advertised = args.requested
    ? normalizeEnvironmentDaemonSessionCapabilities(args.requested)
    : inferEnvironmentDaemonSessionCapabilities(args.fallback);
  return {
    commands: advertised.commands.filter((command) =>
      ENVIRONMENT_DAEMON_SESSION_CAPABILITY_COMMANDS.includes(command),
    ),
    features: advertised.features.filter((feature) =>
      ENVIRONMENT_DAEMON_SESSION_CAPABILITY_FEATURES.includes(feature),
    ),
  };
}

export interface EnvironmentDaemonSessionHeartbeatChannel {
  channelId: string;
  lastSent?: EnvironmentDaemonSessionCursor;
  lastAcked?: EnvironmentDaemonSessionCursor;
}

export interface EnvironmentDaemonSessionHeartbeatPayload {
  agentObservedAt: number;
  outboxDepth: number;
  channels: EnvironmentDaemonSessionHeartbeatChannel[];
}

export interface EnvironmentDaemonSessionEventBatchItem<
  TEvent extends EnvironmentDaemonEvent = EnvironmentDaemonEvent,
> {
  sequence: number;
  eventId: string;
  emittedAt: number;
  event: TEvent;
}

export interface EnvironmentDaemonSessionEventBatchChannel<
  TEvent extends EnvironmentDaemonEvent = EnvironmentDaemonEvent,
> {
  channelId: string;
  generation: number;
  events: EnvironmentDaemonSessionEventBatchItem<TEvent>[];
}

export interface EnvironmentDaemonSessionEventBatchPayload<
  TEvent extends EnvironmentDaemonEvent = EnvironmentDaemonEvent,
> {
  batches: EnvironmentDaemonSessionEventBatchChannel<TEvent>[];
}

export interface EnvironmentDaemonSessionEventAckChannel {
  channelId: string;
  ackedThrough: EnvironmentDaemonSessionCursor;
}

export interface EnvironmentDaemonSessionEventAckPayload {
  channels: EnvironmentDaemonSessionEventAckChannel[];
}

export interface EnvironmentDaemonSessionCommandBatchItem<
  TCommand extends EnvironmentDaemonCommand = EnvironmentDaemonCommand,
> {
  channelId: string;
  commandCursor: number;
  commandId: string;
  createdAt: number;
  command: TCommand;
}

export interface EnvironmentDaemonSessionCommandBatchPayload<
  TCommand extends EnvironmentDaemonCommand = EnvironmentDaemonCommand,
> {
  commands: EnvironmentDaemonSessionCommandBatchItem<TCommand>[];
}

export type EnvironmentDaemonSessionCommandAckState =
  | "received"
  | "duplicate";

export interface EnvironmentDaemonSessionCommandAckItem {
  commandId: string;
  channelId: string;
  state: EnvironmentDaemonSessionCommandAckState;
}

export interface EnvironmentDaemonSessionCommandAckPayload {
  commands: EnvironmentDaemonSessionCommandAckItem[];
}

export type EnvironmentDaemonSessionCommandResultState =
  | "started"
  | "completed"
  | "failed";

export interface EnvironmentDaemonSessionCommandResultPayload {
  commandId: string;
  channelId: string;
  state: EnvironmentDaemonSessionCommandResultState;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export interface EnvironmentDaemonSessionProviderRequestPayload {
  requestId: string | number;
  method: string;
  params?: unknown;
  providerId?: string;
  normalizedMethod?: string;
  toolCall?: ProviderToolCallRequest;
  /** When set, the server routes this request to the specified thread
   *  instead of the URL-path thread. Used for shared-environment sessions
   *  where the originating provider child belongs to a sibling thread. */
  channelId?: string;
}

export interface EnvironmentDaemonSessionProviderResponsePayload {
  requestId: string | number;
  ok: boolean;
  result?: unknown;
  toolCallResponse?: ProviderToolCallResponse;
  errorCode?: string;
  errorMessage?: string;
}

export interface EnvironmentDaemonSessionClosePayload {
  reason: EnvironmentDaemonSessionCloseReason;
}

export interface EnvironmentDaemonSessionReplacedPayload {
  reason: "newer_session";
}

interface EnvironmentDaemonSessionMessageBase {
  protocol: typeof ENVIRONMENT_DAEMON_SESSION_PROTOCOL;
  messageId: string;
  sentAt: number;
}

interface EnvironmentDaemonSessionBoundMessageBase
  extends EnvironmentDaemonSessionMessageBase {
  sessionId: string;
}

export interface EnvironmentDaemonSessionOpenMessage
  extends EnvironmentDaemonSessionMessageBase {
  type: "session_open";
  payload: EnvironmentDaemonSessionOpenPayload;
}

export interface EnvironmentDaemonSessionWelcomeMessage
  extends EnvironmentDaemonSessionBoundMessageBase {
  type: "session_welcome";
  payload: EnvironmentDaemonSessionWelcomePayload;
}

export interface EnvironmentDaemonSessionHeartbeatMessage
  extends EnvironmentDaemonSessionBoundMessageBase {
  type: "heartbeat";
  payload: EnvironmentDaemonSessionHeartbeatPayload;
}

export interface EnvironmentDaemonSessionEventBatchMessage<
  TEvent extends EnvironmentDaemonEvent = EnvironmentDaemonEvent,
> extends EnvironmentDaemonSessionBoundMessageBase {
  type: "event_batch";
  payload: EnvironmentDaemonSessionEventBatchPayload<TEvent>;
}

export interface EnvironmentDaemonSessionEventAckMessage
  extends EnvironmentDaemonSessionBoundMessageBase {
  type: "event_ack";
  payload: EnvironmentDaemonSessionEventAckPayload;
}

export interface EnvironmentDaemonSessionCommandBatchMessage<
  TCommand extends EnvironmentDaemonCommand = EnvironmentDaemonCommand,
> extends EnvironmentDaemonSessionBoundMessageBase {
  type: "command_batch";
  payload: EnvironmentDaemonSessionCommandBatchPayload<TCommand>;
}

export interface EnvironmentDaemonSessionCommandAckMessage
  extends EnvironmentDaemonSessionBoundMessageBase {
  type: "command_ack";
  payload: EnvironmentDaemonSessionCommandAckPayload;
}

export interface EnvironmentDaemonSessionCommandResultMessage
  extends EnvironmentDaemonSessionBoundMessageBase {
  type: "command_result";
  payload: EnvironmentDaemonSessionCommandResultPayload;
}

export interface EnvironmentDaemonSessionProviderRequestMessage
  extends EnvironmentDaemonSessionBoundMessageBase {
  type: "provider_request";
  payload: EnvironmentDaemonSessionProviderRequestPayload;
}

export interface EnvironmentDaemonSessionProviderResponseMessage
  extends EnvironmentDaemonSessionBoundMessageBase {
  type: "provider_response";
  payload: EnvironmentDaemonSessionProviderResponsePayload;
}

export interface EnvironmentDaemonSessionCloseMessage
  extends EnvironmentDaemonSessionBoundMessageBase {
  type: "session_close";
  payload: EnvironmentDaemonSessionClosePayload;
}

export interface EnvironmentDaemonSessionReplacedMessage
  extends EnvironmentDaemonSessionBoundMessageBase {
  type: "session_replaced";
  payload: EnvironmentDaemonSessionReplacedPayload;
}

export type EnvironmentDaemonSessionClientMessage =
  | EnvironmentDaemonSessionOpenMessage
  | EnvironmentDaemonSessionHeartbeatMessage
  | EnvironmentDaemonSessionEventBatchMessage
  | EnvironmentDaemonSessionCommandAckMessage
  | EnvironmentDaemonSessionCommandResultMessage
  | EnvironmentDaemonSessionProviderRequestMessage
  | EnvironmentDaemonSessionCloseMessage;

export type EnvironmentDaemonSessionServerMessage =
  | EnvironmentDaemonSessionWelcomeMessage
  | EnvironmentDaemonSessionEventAckMessage
  | EnvironmentDaemonSessionCommandBatchMessage
  | EnvironmentDaemonSessionProviderResponseMessage
  | EnvironmentDaemonSessionSessionControlMessage;

export type EnvironmentDaemonSessionSessionControlMessage =
  | EnvironmentDaemonSessionCloseMessage
  | EnvironmentDaemonSessionReplacedMessage;

export type EnvironmentDaemonSessionMessage =
  | EnvironmentDaemonSessionClientMessage
  | EnvironmentDaemonSessionServerMessage;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasBaseMessageFields(
  value: unknown,
): value is Record<string, unknown> & {
  protocol: typeof ENVIRONMENT_DAEMON_SESSION_PROTOCOL;
  messageId: string;
  sentAt: number;
  type: string;
} {
  const record = asRecord(value);
  if (!record) return false;
  return (
    record.protocol === ENVIRONMENT_DAEMON_SESSION_PROTOCOL &&
    typeof record.messageId === "string" &&
    record.messageId.length > 0 &&
    typeof record.sentAt === "number" &&
    Number.isFinite(record.sentAt) &&
    typeof record.type === "string"
  );
}

export function isEnvironmentDaemonSessionCursor(
  value: unknown,
): value is EnvironmentDaemonSessionCursor {
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

export function compareEnvironmentDaemonSessionCursors(
  left: EnvironmentDaemonSessionCursor,
  right: EnvironmentDaemonSessionCursor,
): number {
  if (left.generation !== right.generation) {
    return left.generation - right.generation;
  }
  return left.sequence - right.sequence;
}

export function isEnvironmentDaemonSessionMessage(
  value: unknown,
): value is EnvironmentDaemonSessionMessage {
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

export function isEnvironmentDaemonSessionClientMessage(
  value: unknown,
): value is EnvironmentDaemonSessionClientMessage {
  if (!isEnvironmentDaemonSessionMessage(value)) return false;
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

export function isEnvironmentDaemonSessionServerMessage(
  value: unknown,
): value is EnvironmentDaemonSessionServerMessage {
  if (!isEnvironmentDaemonSessionMessage(value)) return false;
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
