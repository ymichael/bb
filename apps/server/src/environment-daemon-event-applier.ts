import type {
  EnvironmentDaemonCursorPosition,
  EnvironmentDaemonCursorRepository,
} from "@bb/db";
import {
  ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
  compareEnvironmentDaemonSessionCursors,
  type EnvironmentDaemonEventEnvelope,
  type EnvironmentDaemonSessionEventBatchChannel,
} from "@bb/environment-daemon";

export type EnvironmentDaemonEventApplyBlockedReason =
  | "invalid_channel"
  | "gap";

export interface EnvironmentDaemonEventApplyResult {
  acknowledgedCursor?: EnvironmentDaemonCursorPosition;
  appliedCount: number;
  duplicateCount: number;
  blockedReason?: EnvironmentDaemonEventApplyBlockedReason;
  blockedAt?: EnvironmentDaemonCursorPosition;
}

export interface EnvironmentDaemonEventIngestor {
  ingestReplayedEnvironmentDaemonEvents(args: {
    threadId: string;
    events: EnvironmentDaemonEventEnvelope[];
  }): Promise<void>;
}

function isNextCursor(
  current: EnvironmentDaemonCursorPosition | undefined,
  next: EnvironmentDaemonCursorPosition,
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

export class EnvironmentDaemonEventApplier {
  constructor(
    private readonly cursors: EnvironmentDaemonCursorRepository,
    private readonly ingester: EnvironmentDaemonEventIngestor,
  ) {}

  async applyChannelBatch(args: {
    threadId: string;
    batch: EnvironmentDaemonSessionEventBatchChannel;
    now?: number;
  }): Promise<EnvironmentDaemonEventApplyResult> {
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
    const newEvents: EnvironmentDaemonEventEnvelope[] = [];

    for (const item of args.batch.events) {
      const nextCursor = {
        generation: args.batch.generation,
        sequence: item.sequence,
      } satisfies EnvironmentDaemonCursorPosition;

      if (
        acknowledgedCursor &&
        compareEnvironmentDaemonSessionCursors(nextCursor, acknowledgedCursor) <= 0
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
        protocolVersion: ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
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

    await this.ingester.ingestReplayedEnvironmentDaemonEvents({
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
