export type {
  EnvironmentAgentConnectionTarget,
  EnvironmentAgentTransportKind,
  EnvironmentAgentDaemonConnectionConfig,
  EnvironmentAgentCommand,
  EnvironmentAgentCommandMetadata,
  EnvironmentAgentCommandEnvelope,
  EnvironmentAgentCommandAck,
  EnvironmentAgentCommandDeliveryState,
  EnvironmentAgentEvent,
  EnvironmentAgentEventEnvelope,
  EnvironmentAgentReplayCursor,
  EnvironmentAgentReplayRequest,
  EnvironmentAgentReplayResponse,
  EnvironmentAgentAckRequest,
  EnvironmentAgentAckResponse,
  EnvironmentAgentStatusSnapshot,
  EnvironmentAgentControlRequest,
  EnvironmentAgentControlResponse,
} from "./protocol.js";
export { ENVIRONMENT_AGENT_PROTOCOL_VERSION } from "./protocol.js";
export {
  isEnvironmentAgentControlRequest,
  isEnvironmentAgentControlResponse,
} from "./protocol.js";

export type {
  JsonLineTransport,
  JsonLineTransportHandlers,
} from "./transport.js";
export {
  createChildProcessJsonLineTransport,
} from "./transport.js";

export type { EnvironmentAgentRuntimeOptions } from "./runtime.js";
export {
  EnvironmentAgentRuntime,
  connectionTargetFromRuntimeOptions,
} from "./runtime.js";

export type { EnvironmentAgentClient } from "./client.js";
export {
  EnvironmentAgentClientError,
  createEnvironmentAgentClient,
  createChildProcessEnvironmentAgentClient,
} from "./client.js";
