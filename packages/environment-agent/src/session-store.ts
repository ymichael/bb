import type { EnvironmentAgentCommand } from "./protocol.js";
import type {
  EnvironmentAgentSessionCloseReason,
  EnvironmentAgentSessionCursor,
} from "./session-protocol.js";

export type EnvironmentAgentSessionStoreCommandReceiptState =
  | "received"
  | "started"
  | "completed"
  | "failed";

export type EnvironmentAgentSessionStoreSessionStatus =
  | "active"
  | "expired"
  | "closed"
  | "replaced";

export interface EnvironmentAgentSessionStateRecord {
  threadId: string;
  agentId: string;
  agentInstanceId: string;
  sessionId?: string;
  generation: number;
  nextSequence: number;
  lastAcked?: EnvironmentAgentSessionCursor;
  lastDeliveredCommandCursor?: number;
  createdAt: number;
  updatedAt: number;
}

export interface EnvironmentAgentOutboxEventRecord {
  threadId: string;
  generation: number;
  sequence: number;
  eventId: string;
  payload: unknown;
  emittedAt: number;
  ackedAt?: number;
}

export interface EnvironmentAgentCommandReceiptRecord {
  commandId: string;
  threadId: string;
  commandCursor: number;
  commandType: EnvironmentAgentCommand["type"] | string;
  state: EnvironmentAgentSessionStoreCommandReceiptState;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
  ackReportedAt?: number;
  lastResultReportedState?: EnvironmentAgentSessionStoreCommandReceiptState;
  lastResultReportedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface EnvironmentAgentPersistedSessionRecord {
  id: string;
  threadId: string;
  agentId: string;
  agentInstanceId: string;
  protocolVersion: number;
  status: EnvironmentAgentSessionStoreSessionStatus;
  leaseExpiresAt: number;
  lastHeartbeatAt?: number;
  closedAt?: number;
  closeReason?: EnvironmentAgentSessionCloseReason | "newer_session";
  createdAt: number;
  updatedAt: number;
}

export interface InitializeEnvironmentAgentThreadStateInput {
  threadId: string;
  agentId: string;
  agentInstanceId: string;
  generation: number;
  now?: number;
}

export interface AppendEnvironmentAgentOutboxEventInput {
  threadId: string;
  payload: unknown;
  eventId?: string;
  emittedAt?: number;
}

export interface AckEnvironmentAgentOutboxThroughInput {
  threadId: string;
  generation: number;
  sequence: number;
  ackedAt?: number;
}

export interface RecordEnvironmentAgentCommandReceivedInput {
  commandId: string;
  threadId: string;
  commandCursor: number;
  commandType: EnvironmentAgentCommand["type"] | string;
  now?: number;
}

export interface CompleteEnvironmentAgentCommandReceiptInput {
  commandId: string;
  result?: unknown;
  now?: number;
}

export interface FailEnvironmentAgentCommandReceiptInput {
  commandId: string;
  errorCode?: string;
  errorMessage?: string;
  now?: number;
}

export interface BindEnvironmentAgentSessionInput {
  threadId: string;
  sessionId: string;
  now?: number;
}

export interface ClearEnvironmentAgentSessionInput {
  threadId: string;
  now?: number;
}

export interface SetEnvironmentAgentLastDeliveredCommandCursorInput {
  threadId: string;
  commandCursor: number;
  now?: number;
}

export interface ReconcileEnvironmentAgentEventCursorInput {
  threadId: string;
  cursor: EnvironmentAgentSessionCursor;
  now?: number;
}

export interface EnvironmentAgentSessionStore {
  loadSessionState(threadId: string): EnvironmentAgentSessionStateRecord | undefined;
  initializeThreadState(
    input: InitializeEnvironmentAgentThreadStateInput,
  ): EnvironmentAgentSessionStateRecord;
  bindSession(input: BindEnvironmentAgentSessionInput): EnvironmentAgentSessionStateRecord;
  clearSession(input: ClearEnvironmentAgentSessionInput): EnvironmentAgentSessionStateRecord;
  bumpGeneration(threadId: string, now?: number): EnvironmentAgentSessionStateRecord;
  appendOutboxEvent(
    input: AppendEnvironmentAgentOutboxEventInput,
  ): EnvironmentAgentOutboxEventRecord;
  listUnackedOutbox(args: {
    threadId: string;
    limit?: number;
  }): EnvironmentAgentOutboxEventRecord[];
  ackOutboxThrough(input: AckEnvironmentAgentOutboxThroughInput): number;
  reconcileEventCursor(
    input: ReconcileEnvironmentAgentEventCursorInput,
  ): EnvironmentAgentSessionStateRecord;
  recordCommandReceived(
    input: RecordEnvironmentAgentCommandReceivedInput,
  ): EnvironmentAgentCommandReceiptRecord;
  getCommandReceipt(commandId: string): EnvironmentAgentCommandReceiptRecord | undefined;
  listPendingCommandAcks(threadId: string): EnvironmentAgentCommandReceiptRecord[];
  markCommandAckReported(
    commandId: string,
    now?: number,
  ): EnvironmentAgentCommandReceiptRecord | undefined;
  markCommandStarted(
    commandId: string,
    now?: number,
  ): EnvironmentAgentCommandReceiptRecord | undefined;
  listPendingCommandResults(threadId: string): EnvironmentAgentCommandReceiptRecord[];
  markCommandResultReported(args: {
    commandId: string;
    state: EnvironmentAgentSessionStoreCommandReceiptState;
    now?: number;
  }): EnvironmentAgentCommandReceiptRecord | undefined;
  markCommandCompleted(
    input: CompleteEnvironmentAgentCommandReceiptInput,
  ): EnvironmentAgentCommandReceiptRecord | undefined;
  markCommandFailed(
    input: FailEnvironmentAgentCommandReceiptInput,
  ): EnvironmentAgentCommandReceiptRecord | undefined;
  setLastDeliveredCommandCursor(
    input: SetEnvironmentAgentLastDeliveredCommandCursorInput,
  ): EnvironmentAgentSessionStateRecord;
  alignLastDeliveredCommandCursor(
    input: SetEnvironmentAgentLastDeliveredCommandCursorInput,
  ): EnvironmentAgentSessionStateRecord;
}
