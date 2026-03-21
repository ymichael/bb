import type {
  CompleteEnvironmentDaemonCommandReceiptInput,
  EnvironmentDaemonCommandReceiptRecord,
  EnvironmentDaemonOutboxEventRecord,
  EnvironmentDaemonSessionStateRecord,
  EnvironmentDaemonSessionStore,
  FailEnvironmentDaemonCommandReceiptInput,
  RecordEnvironmentDaemonCommandReceivedInput,
} from "./session-store.js";
import type {
  EnvironmentDaemonEvent,
} from "./protocol.js";
import type {
  EnvironmentDaemonSessionCommandAckState,
  EnvironmentDaemonSessionCursor,
  EnvironmentDaemonSessionEventBatchChannel,
} from "./session-protocol.js";

export interface EnvironmentDaemonSessionRuntimeOptions {
  store: EnvironmentDaemonSessionStore;
  clock?: () => number;
}

export interface RecordEnvironmentDaemonSessionEventInput {
  threadId: string;
  event: EnvironmentDaemonEvent;
  eventId?: string;
  emittedAt?: number;
}

export interface ReceiveEnvironmentDaemonSessionCommandResult {
  ackState: EnvironmentDaemonSessionCommandAckState;
  receipt: EnvironmentDaemonCommandReceiptRecord;
}

export interface EnvironmentDaemonSessionDrainSnapshot {
  hasBoundSession: boolean;
  pendingEventCount: number;
  pendingCommandAckCount: number;
  pendingCommandResultCount: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isEnvironmentDaemonEvent(value: unknown): value is EnvironmentDaemonEvent {
  const record = asRecord(value);
  if (!record) return false;
  if (typeof record.type !== "string" || typeof record.threadId !== "string") {
    return false;
  }

  switch (record.type) {
    case "environment.ready":
    case "thread.stopped":
    case "workspace.status.changed":
      return true;
    case "environment.degraded":
      return typeof record.message === "string";
    case "thread.started":
      return typeof record.providerThreadId === "string";
    case "turn.started":
    case "turn.completed":
      return (
        record.turnId === undefined ||
        typeof record.turnId === "string"
      );
    case "provider.event":
      return typeof record.method === "string";
    case "provider.stderr":
      return typeof record.line === "string";
    case "provider.rpc_error":
      return (
        (typeof record.requestId === "string" ||
          typeof record.requestId === "number") &&
        typeof record.message === "string"
      );
    default:
      return false;
  }
}

export class EnvironmentDaemonSessionRuntime {
  private readonly clock: () => number;

  constructor(private readonly options: EnvironmentDaemonSessionRuntimeOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  listThreadIds(): string[] {
    return this.options.store.listThreadIds();
  }

  loadThreadState(threadId: string): EnvironmentDaemonSessionStateRecord | undefined {
    return this.options.store.loadSessionState(threadId);
  }

  getDrainSnapshot(threadId: string): EnvironmentDaemonSessionDrainSnapshot {
    const state = this.options.store.loadSessionState(threadId);
    return {
      hasBoundSession: Boolean(state?.sessionId),
      pendingEventCount: this.options.store.listUnackedOutbox({ threadId }).length,
      pendingCommandAckCount: this.options.store.listPendingCommandAcks(threadId).length,
      pendingCommandResultCount: this.options.store.listPendingCommandResults(threadId).length,
    };
  }

  initializeThread(args: {
    threadId: string;
    environmentDaemonId: string;
    environmentDaemonInstanceId: string;
    generation: number;
    now?: number;
  }): EnvironmentDaemonSessionStateRecord {
    return this.options.store.initializeThreadState({
      ...args,
      now: args.now ?? this.clock(),
    });
  }

  bindSession(args: {
    threadId: string;
    sessionId: string;
    now?: number;
  }): EnvironmentDaemonSessionStateRecord {
    return this.options.store.bindSession({
      ...args,
      now: args.now ?? this.clock(),
    });
  }

  clearSession(
    threadId: string,
    now: number = this.clock(),
  ): EnvironmentDaemonSessionStateRecord {
    return this.options.store.clearSession({
      threadId,
      now,
    });
  }

  bumpGeneration(
    threadId: string,
    now: number = this.clock(),
  ): EnvironmentDaemonSessionStateRecord {
    return this.options.store.bumpGeneration(threadId, now);
  }

  recordEvent(
    input: RecordEnvironmentDaemonSessionEventInput,
  ): EnvironmentDaemonOutboxEventRecord {
    return this.options.store.appendOutboxEvent({
      threadId: input.threadId,
      payload: input.event,
      ...(input.eventId ? { eventId: input.eventId } : {}),
      emittedAt: input.emittedAt ?? this.clock(),
    });
  }

  getPendingEventBatch(args: {
    threadId: string;
    limit?: number;
  }): EnvironmentDaemonSessionEventBatchChannel | undefined {
    const pending = this.options.store.listUnackedOutbox({
      threadId: args.threadId,
      limit: args.limit,
    });
    if (pending.length === 0) {
      return undefined;
    }

    const generation = pending[0]!.generation;
    const events = pending
      .filter((event) => event.generation === generation)
      .map((event) => {
        if (!isEnvironmentDaemonEvent(event.payload)) {
          throw new Error(
            `Invalid persisted environment-daemon outbox payload for thread ${args.threadId}`,
          );
        }
        return {
          sequence: event.sequence,
          eventId: event.eventId,
          emittedAt: event.emittedAt,
          event: event.payload,
        };
      });

    return {
      channelId: args.threadId,
      generation,
      events,
    };
  }

  acknowledgeEvents(args: {
    threadId: string;
    generation: number;
    sequence: number;
    ackedAt?: number;
  }): number {
    return this.options.store.ackOutboxThrough({
      ...args,
      ackedAt: args.ackedAt ?? this.clock(),
    });
  }

  alignEventCursor(
    threadId: string,
    cursor: EnvironmentDaemonSessionCursor,
    now: number = this.clock(),
  ): EnvironmentDaemonSessionStateRecord {
    return this.options.store.reconcileEventCursor({
      threadId,
      cursor,
      now,
    });
  }

  receiveCommand(
    input: RecordEnvironmentDaemonCommandReceivedInput,
  ): ReceiveEnvironmentDaemonSessionCommandResult {
    const existing = this.options.store.getCommandReceipt(input.commandId);
    if (existing) {
      return {
        ackState: "duplicate",
        receipt: existing,
      };
    }

    return {
      ackState: "received",
      receipt: this.options.store.recordCommandReceived({
        ...input,
        now: input.now ?? this.clock(),
      }),
    };
  }

  getPendingCommandAcks(threadId: string): EnvironmentDaemonCommandReceiptRecord[] {
    return this.options.store.listPendingCommandAcks(threadId);
  }

  markCommandAckReported(
    commandId: string,
    now: number = this.clock(),
  ): EnvironmentDaemonCommandReceiptRecord | undefined {
    return this.options.store.markCommandAckReported(commandId, now);
  }

  markCommandStarted(
    commandId: string,
    now: number = this.clock(),
  ): EnvironmentDaemonCommandReceiptRecord | undefined {
    return this.options.store.markCommandStarted(commandId, now);
  }

  markCommandCompleted(
    input: CompleteEnvironmentDaemonCommandReceiptInput,
  ): EnvironmentDaemonCommandReceiptRecord | undefined {
    return this.options.store.markCommandCompleted({
      ...input,
      now: input.now ?? this.clock(),
    });
  }

  markCommandFailed(
    input: FailEnvironmentDaemonCommandReceiptInput,
  ): EnvironmentDaemonCommandReceiptRecord | undefined {
    return this.options.store.markCommandFailed({
      ...input,
      now: input.now ?? this.clock(),
    });
  }

  getPendingCommandResults(threadId: string): EnvironmentDaemonCommandReceiptRecord[] {
    return this.options.store.listPendingCommandResults(threadId);
  }

  markCommandResultReported(args: {
    commandId: string;
    state: EnvironmentDaemonCommandReceiptRecord["state"];
    now?: number;
  }): EnvironmentDaemonCommandReceiptRecord | undefined {
    return this.options.store.markCommandResultReported({
      ...args,
      now: args.now ?? this.clock(),
    });
  }

  setLastDeliveredCommandCursor(args: {
    threadId: string;
    commandCursor: number;
    now?: number;
  }): EnvironmentDaemonSessionStateRecord {
    return this.options.store.setLastDeliveredCommandCursor({
      ...args,
      now: args.now ?? this.clock(),
    });
  }

  alignLastDeliveredCommandCursor(
    threadId: string,
    commandCursor: number,
    now: number = this.clock(),
  ): EnvironmentDaemonSessionStateRecord {
    return this.options.store.alignLastDeliveredCommandCursor({
      threadId,
      commandCursor,
      now,
    });
  }
}
