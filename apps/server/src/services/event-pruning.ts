import {
  getLatestThreadSequence,
  pruneResolvedAgentMessageDeltas,
  pruneThreadEventsBeforeSequence,
} from "@bb/db";
import type { ThreadEventType } from "@bb/domain";
import type { AppDeps } from "../types.js";

export type ThreadEventPruningMode = "active" | "archived" | "idle";

export interface PruneThreadEventHistoryArgs {
  mode: ThreadEventPruningMode;
  threadId: string;
}

export interface ThreadEventPruningResult {
  latestSequence: number;
  removedAgePrunableEvents: number;
  removedResolvedAgentMessageDeltas: number;
  sequenceCutoff: number;
  totalRemoved: number;
}

export const ACTIVE_THREAD_EVENT_KEEP_RECENT = 1_000;
export const IDLE_THREAD_EVENT_KEEP_RECENT = 300;
export const ARCHIVED_THREAD_EVENT_KEEP_RECENT = 120;

export const AGE_PRUNABLE_THREAD_EVENT_TYPES: readonly ThreadEventType[] = [
  "thread/tokenUsage/updated",
  "turn/diff/updated",
] as const;

const KEEP_RECENT_BY_MODE: Record<ThreadEventPruningMode, number> = {
  active: ACTIVE_THREAD_EVENT_KEEP_RECENT,
  idle: IDLE_THREAD_EVENT_KEEP_RECENT,
  archived: ARCHIVED_THREAD_EVENT_KEEP_RECENT,
};

const agePrunableThreadEventTypeSet = new Set<ThreadEventType>(
  AGE_PRUNABLE_THREAD_EVENT_TYPES,
);

export function isAgePrunableThreadEventType(
  eventType: ThreadEventType,
): boolean {
  return agePrunableThreadEventTypeSet.has(eventType);
}

export function pruneThreadEventHistory(
  deps: Pick<AppDeps, "db">,
  args: PruneThreadEventHistoryArgs,
): ThreadEventPruningResult {
  const latestSequence = getLatestThreadSequence(deps.db, {
    threadId: args.threadId,
  });
  const keepRecent = KEEP_RECENT_BY_MODE[args.mode];
  const sequenceCutoff = Math.max(0, latestSequence - keepRecent);
  const removedAgePrunableEvents = pruneThreadEventsBeforeSequence(deps.db, {
    threadId: args.threadId,
    sequenceCutoff,
    types: AGE_PRUNABLE_THREAD_EVENT_TYPES,
  });
  const removedResolvedAgentMessageDeltas = pruneResolvedAgentMessageDeltas(
    deps.db,
    {
      threadId: args.threadId,
    },
  );

  return {
    latestSequence,
    removedAgePrunableEvents,
    removedResolvedAgentMessageDeltas,
    sequenceCutoff,
    totalRemoved:
      removedAgePrunableEvents + removedResolvedAgentMessageDeltas,
  };
}

export function pruneThreadEventHistoryBestEffort(
  deps: Pick<AppDeps, "db" | "logger">,
  args: PruneThreadEventHistoryArgs,
): ThreadEventPruningResult | null {
  try {
    return pruneThreadEventHistory(deps, args);
  } catch (error) {
    deps.logger.warn(
      {
        err: error,
        mode: args.mode,
        threadId: args.threadId,
      },
      "Failed to prune thread event history",
    );
    return null;
  }
}
