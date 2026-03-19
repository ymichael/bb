import type { EnvironmentDaemonCommand } from "./protocol.js";
import type {
  EnvironmentDaemonSessionCloseReason,
  EnvironmentDaemonSessionCursor,
} from "./session-protocol.js";

export type EnvironmentDaemonSessionStoreCommandReceiptState =
  | "received"
  | "started"
  | "completed"
  | "failed";

export type EnvironmentDaemonSessionStoreSessionStatus =
  | "active"
  | "expired"
  | "closed"
  | "replaced";

export interface EnvironmentDaemonSessionStateRecord {
  threadId: string;
  agentId: string;
  agentInstanceId: string;
  sessionId?: string;
  generation: number;
  nextSequence: number;
  lastAcked?: EnvironmentDaemonSessionCursor;
  lastDeliveredCommandCursor?: number;
  createdAt: number;
  updatedAt: number;
}

export interface EnvironmentDaemonOutboxEventRecord {
  threadId: string;
  generation: number;
  sequence: number;
  eventId: string;
  payload: unknown;
  emittedAt: number;
  ackedAt?: number;
}

export interface EnvironmentDaemonCommandReceiptRecord {
  commandId: string;
  threadId: string;
  commandCursor: number;
  commandType: EnvironmentDaemonCommand["type"] | string;
  state: EnvironmentDaemonSessionStoreCommandReceiptState;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
  ackReportedAt?: number;
  lastResultReportedState?: EnvironmentDaemonSessionStoreCommandReceiptState;
  lastResultReportedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface EnvironmentDaemonPersistedSessionRecord {
  id: string;
  threadId: string;
  agentId: string;
  agentInstanceId: string;
  protocolVersion: number;
  status: EnvironmentDaemonSessionStoreSessionStatus;
  leaseExpiresAt: number;
  lastHeartbeatAt?: number;
  closedAt?: number;
  closeReason?: EnvironmentDaemonSessionCloseReason | "newer_session";
  createdAt: number;
  updatedAt: number;
}

export interface InitializeEnvironmentDaemonThreadStateInput {
  threadId: string;
  agentId: string;
  agentInstanceId: string;
  generation: number;
  now?: number;
}

export interface AppendEnvironmentDaemonOutboxEventInput {
  threadId: string;
  payload: unknown;
  eventId?: string;
  emittedAt?: number;
}

export interface AckEnvironmentDaemonOutboxThroughInput {
  threadId: string;
  generation: number;
  sequence: number;
  ackedAt?: number;
}

export interface RecordEnvironmentDaemonCommandReceivedInput {
  commandId: string;
  threadId: string;
  commandCursor: number;
  commandType: EnvironmentDaemonCommand["type"] | string;
  now?: number;
}

export interface CompleteEnvironmentDaemonCommandReceiptInput {
  commandId: string;
  result?: unknown;
  now?: number;
}

export interface FailEnvironmentDaemonCommandReceiptInput {
  commandId: string;
  errorCode?: string;
  errorMessage?: string;
  now?: number;
}

export interface BindEnvironmentDaemonSessionInput {
  threadId: string;
  sessionId: string;
  now?: number;
}

export interface ClearEnvironmentDaemonSessionInput {
  threadId: string;
  now?: number;
}

export interface SetEnvironmentDaemonLastDeliveredCommandCursorInput {
  threadId: string;
  commandCursor: number;
  now?: number;
}

export interface ReconcileEnvironmentDaemonEventCursorInput {
  threadId: string;
  cursor: EnvironmentDaemonSessionCursor;
  now?: number;
}

export interface EnvironmentDaemonSessionStore {
  listThreadIds(): string[];
  loadSessionState(threadId: string): EnvironmentDaemonSessionStateRecord | undefined;
  initializeThreadState(
    input: InitializeEnvironmentDaemonThreadStateInput,
  ): EnvironmentDaemonSessionStateRecord;
  bindSession(input: BindEnvironmentDaemonSessionInput): EnvironmentDaemonSessionStateRecord;
  clearSession(input: ClearEnvironmentDaemonSessionInput): EnvironmentDaemonSessionStateRecord;
  bumpGeneration(threadId: string, now?: number): EnvironmentDaemonSessionStateRecord;
  appendOutboxEvent(
    input: AppendEnvironmentDaemonOutboxEventInput,
  ): EnvironmentDaemonOutboxEventRecord;
  listUnackedOutbox(args: {
    threadId: string;
    limit?: number;
  }): EnvironmentDaemonOutboxEventRecord[];
  ackOutboxThrough(input: AckEnvironmentDaemonOutboxThroughInput): number;
  reconcileEventCursor(
    input: ReconcileEnvironmentDaemonEventCursorInput,
  ): EnvironmentDaemonSessionStateRecord;
  recordCommandReceived(
    input: RecordEnvironmentDaemonCommandReceivedInput,
  ): EnvironmentDaemonCommandReceiptRecord;
  getCommandReceipt(commandId: string): EnvironmentDaemonCommandReceiptRecord | undefined;
  listPendingCommandAcks(threadId: string): EnvironmentDaemonCommandReceiptRecord[];
  markCommandAckReported(
    commandId: string,
    now?: number,
  ): EnvironmentDaemonCommandReceiptRecord | undefined;
  markCommandStarted(
    commandId: string,
    now?: number,
  ): EnvironmentDaemonCommandReceiptRecord | undefined;
  listPendingCommandResults(threadId: string): EnvironmentDaemonCommandReceiptRecord[];
  markCommandResultReported(args: {
    commandId: string;
    state: EnvironmentDaemonSessionStoreCommandReceiptState;
    now?: number;
  }): EnvironmentDaemonCommandReceiptRecord | undefined;
  markCommandCompleted(
    input: CompleteEnvironmentDaemonCommandReceiptInput,
  ): EnvironmentDaemonCommandReceiptRecord | undefined;
  markCommandFailed(
    input: FailEnvironmentDaemonCommandReceiptInput,
  ): EnvironmentDaemonCommandReceiptRecord | undefined;
  setLastDeliveredCommandCursor(
    input: SetEnvironmentDaemonLastDeliveredCommandCursorInput,
  ): EnvironmentDaemonSessionStateRecord;
  alignLastDeliveredCommandCursor(
    input: SetEnvironmentDaemonLastDeliveredCommandCursorInput,
  ): EnvironmentDaemonSessionStateRecord;
}
