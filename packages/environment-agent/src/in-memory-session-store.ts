import { randomUUID } from "node:crypto";
import type {
  AckEnvironmentAgentOutboxThroughInput,
  AppendEnvironmentAgentOutboxEventInput,
  BindEnvironmentAgentSessionInput,
  ClearEnvironmentAgentSessionInput,
  CompleteEnvironmentAgentCommandReceiptInput,
  EnvironmentAgentCommandReceiptRecord,
  EnvironmentAgentOutboxEventRecord,
  EnvironmentAgentSessionStateRecord,
  EnvironmentAgentSessionStore,
  EnvironmentAgentSessionStoreCommandReceiptState,
  FailEnvironmentAgentCommandReceiptInput,
  InitializeEnvironmentAgentThreadStateInput,
  RecordEnvironmentAgentCommandReceivedInput,
  SetEnvironmentAgentLastDeliveredCommandCursorInput,
} from "./session-store.js";
import type { EnvironmentAgentSessionCursor } from "./session-protocol.js";

function cloneCursor(
  cursor: EnvironmentAgentSessionCursor | undefined,
): EnvironmentAgentSessionCursor | undefined {
  if (!cursor) return undefined;
  return { generation: cursor.generation, sequence: cursor.sequence };
}

function cloneSessionState(
  record: EnvironmentAgentSessionStateRecord,
): EnvironmentAgentSessionStateRecord {
  return {
    ...record,
    ...(record.lastAcked ? { lastAcked: cloneCursor(record.lastAcked)! } : {}),
  };
}

function cloneOutboxRecord(
  record: EnvironmentAgentOutboxEventRecord,
): EnvironmentAgentOutboxEventRecord {
  return { ...record };
}

function cloneReceipt(
  record: EnvironmentAgentCommandReceiptRecord,
): EnvironmentAgentCommandReceiptRecord {
  return {
    ...record,
    ...(record.result !== undefined ? { result: record.result } : {}),
  };
}

function compareCursors(
  left: EnvironmentAgentSessionCursor,
  right: EnvironmentAgentSessionCursor,
): number {
  if (left.generation !== right.generation) {
    return left.generation - right.generation;
  }
  return left.sequence - right.sequence;
}

function resolveCommandReceiptTransition(
  current: EnvironmentAgentSessionStoreCommandReceiptState,
  target: EnvironmentAgentSessionStoreCommandReceiptState,
): "apply" | "noop" | "conflict" {
  if (current === target) {
    return "noop";
  }
  switch (current) {
    case "received":
      return target === "started" || target === "completed" || target === "failed"
        ? "apply"
        : "conflict";
    case "started":
      return target === "completed" || target === "failed" ? "apply" : "conflict";
    case "completed":
    case "failed":
      return target === "started" ? "noop" : "conflict";
    default:
      return current satisfies never;
  }
}

export class InMemoryEnvironmentAgentSessionStore
  implements EnvironmentAgentSessionStore {
  private readonly threadStates = new Map<string, EnvironmentAgentSessionStateRecord>();
  private readonly outboxByThread = new Map<string, EnvironmentAgentOutboxEventRecord[]>();
  private readonly commandReceipts = new Map<string, EnvironmentAgentCommandReceiptRecord>();

  loadSessionState(threadId: string): EnvironmentAgentSessionStateRecord | undefined {
    const state = this.threadStates.get(threadId);
    return state ? cloneSessionState(state) : undefined;
  }

  initializeThreadState(
    input: InitializeEnvironmentAgentThreadStateInput,
  ): EnvironmentAgentSessionStateRecord {
    const now = input.now ?? Date.now();
    const existing = this.threadStates.get(input.threadId);
    const next: EnvironmentAgentSessionStateRecord = {
      threadId: input.threadId,
      agentId: input.agentId,
      agentInstanceId: input.agentInstanceId,
      ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
      generation: input.generation,
      nextSequence: 1,
      ...(existing?.lastAcked ? { lastAcked: cloneCursor(existing.lastAcked)! } : {}),
      ...(existing?.lastDeliveredCommandCursor !== undefined
        ? { lastDeliveredCommandCursor: existing.lastDeliveredCommandCursor }
        : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.threadStates.set(input.threadId, next);
    return cloneSessionState(next);
  }

  bindSession(input: BindEnvironmentAgentSessionInput): EnvironmentAgentSessionStateRecord {
    const existing = this.requireThreadState(input.threadId);
    const updated = {
      ...existing,
      sessionId: input.sessionId,
      updatedAt: input.now ?? Date.now(),
    };
    this.threadStates.set(input.threadId, updated);
    return cloneSessionState(updated);
  }

  clearSession(input: ClearEnvironmentAgentSessionInput): EnvironmentAgentSessionStateRecord {
    const existing = this.requireThreadState(input.threadId);
    const updated = {
      threadId: existing.threadId,
      agentId: existing.agentId,
      agentInstanceId: existing.agentInstanceId,
      generation: existing.generation,
      nextSequence: existing.nextSequence,
      ...(existing.lastAcked ? { lastAcked: cloneCursor(existing.lastAcked)! } : {}),
      ...(existing.lastDeliveredCommandCursor !== undefined
        ? { lastDeliveredCommandCursor: existing.lastDeliveredCommandCursor }
        : {}),
      createdAt: existing.createdAt,
      updatedAt: input.now ?? Date.now(),
    } satisfies EnvironmentAgentSessionStateRecord;
    this.threadStates.set(input.threadId, updated);
    return cloneSessionState(updated);
  }

  bumpGeneration(threadId: string, now: number = Date.now()): EnvironmentAgentSessionStateRecord {
    const existing = this.requireThreadState(threadId);
    const updated = {
      ...existing,
      generation: existing.generation + 1,
      nextSequence: 1,
      updatedAt: now,
    };
    this.threadStates.set(threadId, updated);
    return cloneSessionState(updated);
  }

  appendOutboxEvent(
    input: AppendEnvironmentAgentOutboxEventInput,
  ): EnvironmentAgentOutboxEventRecord {
    const state = this.requireThreadState(input.threadId);
    const emittedAt = input.emittedAt ?? Date.now();
    const record: EnvironmentAgentOutboxEventRecord = {
      threadId: input.threadId,
      generation: state.generation,
      sequence: state.nextSequence,
      eventId: input.eventId ?? randomUUID(),
      payload: input.payload,
      emittedAt,
    };
    const outbox = this.outboxByThread.get(input.threadId) ?? [];
    outbox.push(record);
    this.outboxByThread.set(input.threadId, outbox);
    this.threadStates.set(input.threadId, {
      ...state,
      nextSequence: state.nextSequence + 1,
      updatedAt: emittedAt,
    });
    return cloneOutboxRecord(record);
  }

  listUnackedOutbox(args: {
    threadId: string;
    limit?: number;
  }): EnvironmentAgentOutboxEventRecord[] {
    const outbox = (this.outboxByThread.get(args.threadId) ?? [])
      .filter((record) => record.ackedAt === undefined)
      .sort((left, right) => {
        if (left.generation !== right.generation) {
          return left.generation - right.generation;
        }
        return left.sequence - right.sequence;
      });
    const limited = args.limit !== undefined ? outbox.slice(0, args.limit) : outbox;
    return limited.map(cloneOutboxRecord);
  }

  ackOutboxThrough(input: AckEnvironmentAgentOutboxThroughInput): number {
    const state = this.requireThreadState(input.threadId);
    const ackedAt = input.ackedAt ?? Date.now();
    const ackCursor = { generation: input.generation, sequence: input.sequence };
    let ackedCount = 0;
    const nextOutbox = (this.outboxByThread.get(input.threadId) ?? []).map((record) => {
      const recordCursor = { generation: record.generation, sequence: record.sequence };
      if (record.ackedAt !== undefined || compareCursors(recordCursor, ackCursor) > 0) {
        return record;
      }
      ackedCount += 1;
      return { ...record, ackedAt };
    });
    this.outboxByThread.set(input.threadId, nextOutbox);
    const lastAcked =
      !state.lastAcked || compareCursors(state.lastAcked, ackCursor) < 0
        ? ackCursor
        : state.lastAcked;
    this.threadStates.set(input.threadId, {
      ...state,
      lastAcked,
      updatedAt: ackedAt,
    });
    return ackedCount;
  }

  recordCommandReceived(
    input: RecordEnvironmentAgentCommandReceivedInput,
  ): EnvironmentAgentCommandReceiptRecord {
    const now = input.now ?? Date.now();
    const receipt: EnvironmentAgentCommandReceiptRecord = {
      commandId: input.commandId,
      threadId: input.threadId,
      commandCursor: input.commandCursor,
      commandType: input.commandType,
      state: "received",
      createdAt: now,
      updatedAt: now,
    };
    this.commandReceipts.set(input.commandId, receipt);
    return cloneReceipt(receipt);
  }

  getCommandReceipt(commandId: string): EnvironmentAgentCommandReceiptRecord | undefined {
    const receipt = this.commandReceipts.get(commandId);
    return receipt ? cloneReceipt(receipt) : undefined;
  }

  listPendingCommandAcks(threadId: string): EnvironmentAgentCommandReceiptRecord[] {
    return [...this.commandReceipts.values()]
      .filter((receipt) => receipt.threadId === threadId && receipt.ackReportedAt === undefined)
      .sort((left, right) => left.commandCursor - right.commandCursor)
      .map(cloneReceipt);
  }

  markCommandAckReported(
    commandId: string,
    now: number = Date.now(),
  ): EnvironmentAgentCommandReceiptRecord | undefined {
    const receipt = this.commandReceipts.get(commandId);
    if (!receipt) return undefined;
    const updated = { ...receipt, ackReportedAt: now, updatedAt: now };
    this.commandReceipts.set(commandId, updated);
    return cloneReceipt(updated);
  }

  markCommandStarted(
    commandId: string,
    now: number = Date.now(),
  ): EnvironmentAgentCommandReceiptRecord | undefined {
    return this.transitionCommand(commandId, "started", { now });
  }

  listPendingCommandResults(threadId: string): EnvironmentAgentCommandReceiptRecord[] {
    return [...this.commandReceipts.values()]
      .filter((receipt) => {
        if (receipt.threadId !== threadId) return false;
        if (receipt.state === "received") return false;
        return receipt.lastResultReportedState !== receipt.state;
      })
      .sort((left, right) => left.commandCursor - right.commandCursor)
      .map(cloneReceipt);
  }

  markCommandResultReported(args: {
    commandId: string;
    state: EnvironmentAgentSessionStoreCommandReceiptState;
    now?: number;
  }): EnvironmentAgentCommandReceiptRecord | undefined {
    const receipt = this.commandReceipts.get(args.commandId);
    if (!receipt) return undefined;
    const now = args.now ?? Date.now();
    const updated = {
      ...receipt,
      lastResultReportedState: args.state,
      lastResultReportedAt: now,
      updatedAt: now,
    };
    this.commandReceipts.set(args.commandId, updated);
    return cloneReceipt(updated);
  }

  markCommandCompleted(
    input: CompleteEnvironmentAgentCommandReceiptInput,
  ): EnvironmentAgentCommandReceiptRecord | undefined {
    return this.transitionCommand(input.commandId, "completed", {
      now: input.now ?? Date.now(),
      ...(input.result !== undefined ? { result: input.result } : {}),
    });
  }

  markCommandFailed(
    input: FailEnvironmentAgentCommandReceiptInput,
  ): EnvironmentAgentCommandReceiptRecord | undefined {
    return this.transitionCommand(input.commandId, "failed", {
      now: input.now ?? Date.now(),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
    });
  }

  setLastDeliveredCommandCursor(
    input: SetEnvironmentAgentLastDeliveredCommandCursorInput,
  ): EnvironmentAgentSessionStateRecord {
    const state = this.requireThreadState(input.threadId);
    const nextCursor = state.lastDeliveredCommandCursor === undefined
      ? input.commandCursor
      : Math.max(state.lastDeliveredCommandCursor, input.commandCursor);
    const updated = {
      ...state,
      lastDeliveredCommandCursor: nextCursor,
      updatedAt: input.now ?? Date.now(),
    };
    this.threadStates.set(input.threadId, updated);
    return cloneSessionState(updated);
  }

  private requireThreadState(threadId: string): EnvironmentAgentSessionStateRecord {
    const state = this.threadStates.get(threadId);
    if (!state) {
      throw new Error(`Missing environment-agent thread state for ${threadId}`);
    }
    return state;
  }

  private transitionCommand(
    commandId: string,
    target: EnvironmentAgentSessionStoreCommandReceiptState,
    args: {
      now: number;
      result?: unknown;
      errorCode?: string;
      errorMessage?: string;
    },
  ): EnvironmentAgentCommandReceiptRecord | undefined {
    const existing = this.commandReceipts.get(commandId);
    if (!existing) return undefined;
    const transition = resolveCommandReceiptTransition(existing.state, target);
    if (transition === "noop") {
      return cloneReceipt(existing);
    }
    if (transition === "conflict") {
      throw new Error(
        `Invalid environment-agent command receipt transition: ${existing.state} -> ${target}`,
      );
    }
    const updated: EnvironmentAgentCommandReceiptRecord = {
      ...existing,
      state: target,
      updatedAt: args.now,
      ...(target === "completed"
        ? { result: args.result, errorCode: undefined, errorMessage: undefined }
        : {}),
      ...(target === "failed"
        ? {
            ...(args.errorCode !== undefined ? { errorCode: args.errorCode } : {}),
            ...(args.errorMessage !== undefined ? { errorMessage: args.errorMessage } : {}),
          }
        : {}),
    };
    this.commandReceipts.set(commandId, updated);
    return cloneReceipt(updated);
  }
}
