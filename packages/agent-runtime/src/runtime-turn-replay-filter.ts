import type { ThreadEvent } from "@bb/domain";
import { requireThreadEventScopeTurnId } from "@bb/domain";

export type RuntimeTurnReplayFilterResult =
  | { kind: "emit"; event: ThreadEvent }
  | { kind: "drop-replayed-turn-start"; threadId: string; turnId: string };

/**
 * Filters provider reconnect replays that resend a completed turn/started
 * without replay metadata. This runs before runtime state mutation and before
 * consumer emission so duplicate starts never escape the runtime boundary.
 */
export class RuntimeTurnReplayFilter {
  private readonly completedTurnIdsByThreadId = new Map<string, Set<string>>();

  clear(): void {
    this.completedTurnIdsByThreadId.clear();
  }

  clearThread(threadId: string): void {
    this.completedTurnIdsByThreadId.delete(threadId);
  }

  observe(event: ThreadEvent): RuntimeTurnReplayFilterResult {
    if (event.type === "turn/started") {
      const turnId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });
      if (this.hasCompletedTurn(event.threadId, turnId)) {
        return {
          kind: "drop-replayed-turn-start",
          threadId: event.threadId,
          turnId,
        };
      }
      return { kind: "emit", event };
    }

    if (event.type === "turn/completed") {
      this.recordCompletedTurn(
        event.threadId,
        requireThreadEventScopeTurnId({
          type: event.type,
          scope: event.scope,
        }),
      );
    }
    return { kind: "emit", event };
  }

  private recordCompletedTurn(threadId: string, turnId: string): void {
    const completedTurnIds =
      this.completedTurnIdsByThreadId.get(threadId) ?? new Set<string>();
    completedTurnIds.add(turnId);
    this.completedTurnIdsByThreadId.set(threadId, completedTurnIds);
  }

  private hasCompletedTurn(threadId: string, turnId: string): boolean {
    return this.completedTurnIdsByThreadId.get(threadId)?.has(turnId) ?? false;
  }
}
