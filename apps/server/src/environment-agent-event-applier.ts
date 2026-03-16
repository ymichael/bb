import type {
  EnvironmentAgentCursorPosition,
  EnvironmentAgentCursorRepository,
} from "@bb/db";
import {
  ENVIRONMENT_AGENT_PROTOCOL_VERSION,
  compareEnvironmentAgentSessionCursors,
  type EnvironmentAgentEventEnvelope,
  type EnvironmentAgentSessionEventBatchChannel,
} from "@bb/environment-daemon";

export type EnvironmentAgentEventApplyBlockedReason =
  | "invalid_channel"
  | "gap";

export interface EnvironmentAgentEventApplyResult {
  acknowledgedCursor?: EnvironmentAgentCursorPosition;
  appliedCount: number;
  duplicateCount: number;
  blockedReason?: EnvironmentAgentEventApplyBlockedReason;
  blockedAt?: EnvironmentAgentCursorPosition;
}

export interface EnvironmentAgentEventIngestor {
  ingestReplayedEnvironmentAgentEvents(args: {
    threadId: string;
    events: EnvironmentAgentEventEnvelope[];
  }): Promise<void>;
}

function isNextCursor(
  current: EnvironmentAgentCursorPosition | undefined,
  next: EnvironmentAgentCursorPosition,
): boolean {
  if (!current) {
    return next.generation >= 0 && next.sequence >= 0;
  }
  if (next.generation < current.generation) return false;
  if (next.generation === current.generation) {
    return next.sequence === current.sequence + 1;
  }
  return next.generation === current.generation + 1 && next.sequence >= 0;
}

export class EnvironmentAgentEventApplier {
  constructor(
    private readonly cursors: EnvironmentAgentCursorRepository,
    private readonly ingester: EnvironmentAgentEventIngestor,
  ) {}

  async applyChannelBatch(args: {
    threadId: string;
    batch: EnvironmentAgentSessionEventBatchChannel;
    now?: number;
  }): Promise<EnvironmentAgentEventApplyResult> {
    if (args.batch.channelId !== args.threadId) {
      const current = this.cursors.getByThreadId(args.threadId);
      return {
        acknowledgedCursor: current
          ? { generation: current.generation, sequence: current.sequence }
          : undefined,
        appliedCount: 0,
        duplicateCount: 0,
        blockedReason: "invalid_channel",
      };
    }

    const now = args.now ?? Date.now();
    const storedCursor = this.cursors.getByThreadId(args.threadId);
    const startingCursor = storedCursor
      ? { generation: storedCursor.generation, sequence: storedCursor.sequence }
      : undefined;
    let acknowledgedCursor = startingCursor;
    let duplicateCount = 0;
    const newEvents: EnvironmentAgentEventEnvelope[] = [];

    for (const item of args.batch.events) {
      const nextCursor = {
        generation: args.batch.generation,
        sequence: item.sequence,
      } satisfies EnvironmentAgentCursorPosition;

      if (
        acknowledgedCursor &&
        compareEnvironmentAgentSessionCursors(nextCursor, acknowledgedCursor) <= 0
      ) {
        duplicateCount += 1;
        continue;
      }

      if (!isNextCursor(acknowledgedCursor, nextCursor)) {
        return {
          acknowledgedCursor,
          appliedCount: 0,
          duplicateCount,
          blockedReason: "gap",
          blockedAt: nextCursor,
        };
      }

      acknowledgedCursor = nextCursor;
      newEvents.push({
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        sequence: item.sequence,
        emittedAt: item.emittedAt,
        threadId: args.threadId,
        event: item.event,
      });
    }

    if (newEvents.length === 0) {
      return {
        acknowledgedCursor,
        appliedCount: 0,
        duplicateCount,
      };
    }

    await this.ingester.ingestReplayedEnvironmentAgentEvents({
      threadId: args.threadId,
      events: newEvents,
    });

    this.cursors.upsert(args.threadId, acknowledgedCursor!, now);
    return {
      acknowledgedCursor,
      appliedCount: newEvents.length,
      duplicateCount,
    };
  }
}
