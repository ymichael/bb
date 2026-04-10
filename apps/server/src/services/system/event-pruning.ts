import {
  getThread,
  getLatestThreadSequence,
  pruneContextWindowUsageEventsBeforeSequence,
  pruneResolvedItemDeltas,
  pruneTokenUsageEventsBeforeSequence,
  pruneThreadEventsBeforeSequence,
} from "@bb/db";
import type { ThreadEventType } from "@bb/domain";
import type { AppDeps } from "../../types.js";

export type ThreadEventPruningMode = "active" | "archived" | "idle";

export interface PruneThreadEventHistoryArgs {
  mode: ThreadEventPruningMode;
  threadId: string;
}

export interface ThreadEventPruningResult {
  latestSequence: number;
  removedAgePrunableEvents: number;
  removedResolvedItemDeltas: number;
  sequenceCutoff: number;
  totalRemoved: number;
}

export interface MaybePruneActiveThreadEventHistoryArgs {
  latestPrunableSequence: number;
  threadId: string;
}

interface ActiveThreadPruneState {
  lastPrunedAt: number;
  lastPrunedSequence: number;
}

export const ACTIVE_THREAD_EVENT_KEEP_RECENT = 1_000;
export const IDLE_THREAD_EVENT_KEEP_RECENT = 300;
export const ARCHIVED_THREAD_EVENT_KEEP_RECENT = 120;
export const ACTIVE_THREAD_EVENT_PRUNE_MIN_SEQUENCE_DELTA = 250;
export const ACTIVE_THREAD_EVENT_PRUNE_MIN_INTERVAL_MS = 30_000;

export const AGE_PRUNABLE_THREAD_EVENT_TYPES: readonly ThreadEventType[] = [
  "thread/contextWindowUsage/updated",
  "thread/tokenUsage/updated",
  "turn/diff/updated",
] as const;

const GENERIC_AGE_PRUNABLE_THREAD_EVENT_TYPES: readonly ThreadEventType[] = [
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
const activeThreadPruneStateByThreadId = new Map<string, ActiveThreadPruneState>();

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
  const removedAgePrunableEvents =
    pruneContextWindowUsageEventsBeforeSequence(deps.db, {
      threadId: args.threadId,
      sequenceCutoff,
    }) +
    pruneTokenUsageEventsBeforeSequence(deps.db, {
      threadId: args.threadId,
      sequenceCutoff,
    }) +
    pruneThreadEventsBeforeSequence(deps.db, {
      threadId: args.threadId,
      sequenceCutoff,
      types: GENERIC_AGE_PRUNABLE_THREAD_EVENT_TYPES,
    });
  const removedResolvedItemDeltas = pruneResolvedItemDeltas(
    deps.db,
    {
      threadId: args.threadId,
    },
  );

  return {
    latestSequence,
    removedAgePrunableEvents,
    removedResolvedItemDeltas,
    sequenceCutoff,
    totalRemoved:
      removedAgePrunableEvents + removedResolvedItemDeltas,
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

export function maybePruneActiveThreadEventHistory(
  deps: Pick<AppDeps, "db" | "logger">,
  args: MaybePruneActiveThreadEventHistoryArgs,
): ThreadEventPruningResult | null {
  const thread = getThread(deps.db, args.threadId);
  if (!thread || thread.status !== "active" || thread.archivedAt !== null) {
    return null;
  }

  const lastState = activeThreadPruneStateByThreadId.get(args.threadId);
  const lastPrunedSequence = lastState?.lastPrunedSequence ?? 0;
  if (
    args.latestPrunableSequence - lastPrunedSequence <
    ACTIVE_THREAD_EVENT_PRUNE_MIN_SEQUENCE_DELTA
  ) {
    return null;
  }

  const now = Date.now();
  const lastPrunedAt = lastState?.lastPrunedAt ?? 0;
  if (now - lastPrunedAt < ACTIVE_THREAD_EVENT_PRUNE_MIN_INTERVAL_MS) {
    return null;
  }

  activeThreadPruneStateByThreadId.set(args.threadId, {
    lastPrunedAt: now,
    lastPrunedSequence: args.latestPrunableSequence,
  });

  return pruneThreadEventHistoryBestEffort(deps, {
    mode: "active",
    threadId: args.threadId,
  });
}

export function resetActiveThreadEventPruningState(threadId: string): void {
  activeThreadPruneStateByThreadId.delete(threadId);
}
