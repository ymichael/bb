// Re-export all session protocol types and schemas from the contract package.
// The contract is the single source of truth for session wire types.
//
// Generic batch types and message unions are re-exported with daemon-specific
// defaults (EnvironmentDaemonEvent / EnvironmentDaemonCommand) so that internal
// code that omits the type parameter keeps working.
import type {
  EnvironmentDaemonSessionEventBatchItem as _EventBatchItem,
  EnvironmentDaemonSessionEventBatchChannel as _EventBatchChannel,
  EnvironmentDaemonSessionEventBatchPayload as _EventBatchPayload,
  EnvironmentDaemonSessionEventBatchMessage as _EventBatchMessage,
  EnvironmentDaemonSessionCommandBatchItem as _CommandBatchItem,
  EnvironmentDaemonSessionCommandBatchPayload as _CommandBatchPayload,
  EnvironmentDaemonSessionCommandBatchMessage as _CommandBatchMessage,
  EnvironmentDaemonSessionOpenMessage,
  EnvironmentDaemonSessionHeartbeatMessage,
  EnvironmentDaemonSessionCommandAckMessage,
  EnvironmentDaemonSessionCommandResultMessage,
  EnvironmentDaemonSessionProviderRequestMessage,
  EnvironmentDaemonSessionCloseMessage,
  EnvironmentDaemonSessionWelcomeMessage,
  EnvironmentDaemonSessionEventAckMessage,
  EnvironmentDaemonSessionProviderResponseMessage,
  EnvironmentDaemonSessionReplacedMessage,
  EnvironmentDaemonSessionSessionControlMessage,
} from "@bb/env-daemon-contract";
import type { EnvironmentDaemonCommand, EnvironmentDaemonEvent } from "./protocol.js";

export {
  ENVIRONMENT_DAEMON_SESSION_PROTOCOL,
  ENVIRONMENT_DAEMON_SESSION_PROTOCOL_VERSION,
  ENVIRONMENT_DAEMON_SESSION_SUPPORTED_PROTOCOL_VERSIONS,
  ENVIRONMENT_DAEMON_SESSION_CAPABILITY_COMMANDS,
  ENVIRONMENT_DAEMON_SESSION_CAPABILITY_FEATURES,
  createEnvironmentDaemonSessionCapabilities,
  inferEnvironmentDaemonSessionCapabilities,
  normalizeEnvironmentDaemonSessionCapabilities,
  negotiateEnvironmentDaemonSessionCapabilities,
  selectEnvironmentDaemonSessionProtocolVersion,
  compareEnvironmentDaemonSessionCursors,
  environmentDaemonSessionCursorSchema,
  environmentDaemonSessionChannelBootstrapSchema,
  environmentDaemonSessionCapabilitiesSchema,
  environmentDaemonSessionOpenPayloadSchema,
  environmentDaemonSessionWelcomePayloadSchema,
  environmentDaemonSessionHeartbeatPayloadSchema,
  environmentDaemonSessionEventBatchPayloadSchema,
  environmentDaemonSessionEventAckPayloadSchema,
  environmentDaemonSessionCommandBatchPayloadSchema,
  environmentDaemonSessionCommandAckPayloadSchema,
  environmentDaemonSessionCommandResultPayloadSchema,
  environmentDaemonSessionProviderRequestPayloadSchema,
  environmentDaemonSessionProviderResponsePayloadSchema,
  environmentDaemonSessionClosePayloadSchema,
  environmentDaemonSessionReplacedPayloadSchema,
  environmentDaemonSessionOpenMessageSchema,
  environmentDaemonSessionClientMessageSchema,
  isEnvironmentDaemonSessionCursor,
  isEnvironmentDaemonSessionMessage,
  isEnvironmentDaemonSessionClientMessage,
  isEnvironmentDaemonSessionServerMessage,
} from "@bb/env-daemon-contract";

export type {
  EnvironmentDaemonSessionCloseReason,
  EnvironmentDaemonSessionCursor,
  EnvironmentDaemonSessionCursorExclusive,
  EnvironmentDaemonSessionChannelBootstrap,
  EnvironmentDaemonSessionControlEndpoint,
  EnvironmentDaemonSessionWorkerMetadata,
  EnvironmentDaemonSessionProviderMetadata,
  EnvironmentDaemonSessionCapabilityCommand,
  EnvironmentDaemonSessionCapabilityFeature,
  EnvironmentDaemonSessionCapabilities,
  EnvironmentDaemonSessionProtocolVersion,
  EnvironmentDaemonSessionOpenPayload,
  EnvironmentDaemonSessionWelcomeChannel,
  EnvironmentDaemonSessionWelcomePayload,
  EnvironmentDaemonSessionHeartbeatChannel,
  EnvironmentDaemonSessionHeartbeatPayload,
  EnvironmentDaemonSessionEventAckChannel,
  EnvironmentDaemonSessionEventAckPayload,
  EnvironmentDaemonSessionCommandAckState,
  EnvironmentDaemonSessionCommandAckItem,
  EnvironmentDaemonSessionCommandAckPayload,
  EnvironmentDaemonSessionCommandResultState,
  EnvironmentDaemonSessionCommandResultPayload,
  EnvironmentDaemonSessionProviderRequestPayload,
  EnvironmentDaemonSessionProviderResponsePayload,
  EnvironmentDaemonSessionClosePayload,
  EnvironmentDaemonSessionReplacedPayload,
  EnvironmentDaemonSessionOpenMessage,
  EnvironmentDaemonSessionWelcomeMessage,
  EnvironmentDaemonSessionHeartbeatMessage,
  EnvironmentDaemonSessionEventAckMessage,
  EnvironmentDaemonSessionCommandAckMessage,
  EnvironmentDaemonSessionCommandResultMessage,
  EnvironmentDaemonSessionProviderRequestMessage,
  EnvironmentDaemonSessionProviderResponseMessage,
  EnvironmentDaemonSessionCloseMessage,
  EnvironmentDaemonSessionReplacedMessage,
  EnvironmentDaemonSessionSessionControlMessage,
} from "@bb/env-daemon-contract";

// ---------------------------------------------------------------------------
// Re-export generic batch types with daemon-specific defaults so callers
// that omit the type parameter get EnvironmentDaemonEvent / EnvironmentDaemonCommand
// instead of Record<string, unknown>.
// ---------------------------------------------------------------------------

export type EnvironmentDaemonSessionEventBatchItem<
  TEvent = EnvironmentDaemonEvent,
> = _EventBatchItem<TEvent>;

export type EnvironmentDaemonSessionEventBatchChannel<
  TEvent = EnvironmentDaemonEvent,
> = _EventBatchChannel<TEvent>;

export type EnvironmentDaemonSessionEventBatchPayload<
  TEvent = EnvironmentDaemonEvent,
> = _EventBatchPayload<TEvent>;

export type EnvironmentDaemonSessionEventBatchMessage<
  TEvent = EnvironmentDaemonEvent,
> = _EventBatchMessage<TEvent>;

export type EnvironmentDaemonSessionCommandBatchItem<
  TCommand = EnvironmentDaemonCommand,
> = _CommandBatchItem<TCommand>;

export type EnvironmentDaemonSessionCommandBatchPayload<
  TCommand = EnvironmentDaemonCommand,
> = _CommandBatchPayload<TCommand>;

export type EnvironmentDaemonSessionCommandBatchMessage<
  TCommand = EnvironmentDaemonCommand,
> = _CommandBatchMessage<TCommand>;

// ---------------------------------------------------------------------------
// Re-specialize message unions with daemon-specific batch types.
// ---------------------------------------------------------------------------

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

export type EnvironmentDaemonSessionMessage =
  | EnvironmentDaemonSessionClientMessage
  | EnvironmentDaemonSessionServerMessage;
