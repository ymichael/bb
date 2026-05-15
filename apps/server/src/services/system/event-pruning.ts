import { performance } from "node:perf_hooks";
import {
  getThread,
  getLatestThreadSequence,
  pruneContextWindowUsageEventsBeforeSequence,
  pruneResolvedItemDeltas,
  pruneTokenUsageEventsBeforeSequence,
  pruneThreadEventsBeforeSequence,
} from "@bb/db";
import type { ThreadEventType } from "@bb/domain";
import { roundDurationMs } from "../lib/duration.js";
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

type ThreadEventPruningStep =
  | "get_latest_thread_sequence"
  | "prune_context_window_usage"
  | "prune_generic_age_prunable_events"
  | "prune_resolved_item_deltas"
  | "prune_token_usage";

class ThreadEventPruningStepError extends Error {
  readonly step: ThreadEventPruningStep;

  constructor(step: ThreadEventPruningStep, cause: ErrorOptions["cause"]) {
    super(`Thread event pruning step failed: ${step}`, { cause });
    this.name = "ThreadEventPruningStepError";
    this.step = step;
  }
}

export const ACTIVE_THREAD_EVENT_KEEP_RECENT = 1_000;
export const IDLE_THREAD_EVENT_KEEP_RECENT = 300;
export const ARCHIVED_THREAD_EVENT_KEEP_RECENT = 120;
export const ACTIVE_THREAD_EVENT_PRUNE_MIN_SEQUENCE_DELTA = 250;
export const ACTIVE_THREAD_EVENT_PRUNE_MIN_INTERVAL_MS = 30_000;
const SLOW_THREAD_EVENT_PRUNE_LOG_THRESHOLD_MS = 1_000;

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
const activeThreadPruneStateByThreadId = new Map<
  string,
  ActiveThreadPruneState
>();

function getThreadEventPruningFailureStep(
  error: ErrorOptions["cause"],
): ThreadEventPruningStep | "unknown" {
  if (error instanceof ThreadEventPruningStepError) {
    return error.step;
  }
  return "unknown";
}

function runThreadEventPruningStep<TValue>(
  step: ThreadEventPruningStep,
  work: () => TValue,
): TValue {
  try {
    return work();
  } catch (error) {
    throw new ThreadEventPruningStepError(step, error);
  }
}

export function isAgePrunableThreadEventType(
  eventType: ThreadEventType,
): boolean {
  return agePrunableThreadEventTypeSet.has(eventType);
}

export function pruneThreadEventHistory(
  deps: Pick<AppDeps, "db">,
  args: PruneThreadEventHistoryArgs,
): ThreadEventPruningResult {
  const latestSequence = runThreadEventPruningStep(
    "get_latest_thread_sequence",
    () =>
      getLatestThreadSequence(deps.db, {
        threadId: args.threadId,
      }),
  );
  const keepRecent = KEEP_RECENT_BY_MODE[args.mode];
  const sequenceCutoff = Math.max(0, latestSequence - keepRecent);
  const removedAgePrunableEvents =
    runThreadEventPruningStep("prune_context_window_usage", () =>
      pruneContextWindowUsageEventsBeforeSequence(deps.db, {
        threadId: args.threadId,
        sequenceCutoff,
      }),
    ) +
    runThreadEventPruningStep("prune_token_usage", () =>
      pruneTokenUsageEventsBeforeSequence(deps.db, {
        threadId: args.threadId,
        sequenceCutoff,
      }),
    ) +
    runThreadEventPruningStep("prune_generic_age_prunable_events", () =>
      pruneThreadEventsBeforeSequence(deps.db, {
        threadId: args.threadId,
        sequenceCutoff,
        types: GENERIC_AGE_PRUNABLE_THREAD_EVENT_TYPES,
      }),
    );
  const removedResolvedItemDeltas = runThreadEventPruningStep(
    "prune_resolved_item_deltas",
    () =>
      pruneResolvedItemDeltas(deps.db, {
        threadId: args.threadId,
      }),
  );

  return {
    latestSequence,
    removedAgePrunableEvents,
    removedResolvedItemDeltas,
    sequenceCutoff,
    totalRemoved: removedAgePrunableEvents + removedResolvedItemDeltas,
  };
}

export function pruneThreadEventHistoryBestEffort(
  deps: Pick<AppDeps, "db" | "logger">,
  args: PruneThreadEventHistoryArgs,
): ThreadEventPruningResult | null {
  const startedAt = performance.now();
  try {
    const result = pruneThreadEventHistory(deps, args);
    const durationMs = performance.now() - startedAt;
    if (durationMs >= SLOW_THREAD_EVENT_PRUNE_LOG_THRESHOLD_MS) {
      deps.logger.debug(
        {
          durationMs: roundDurationMs(durationMs),
          latestSequence: result.latestSequence,
          mode: args.mode,
          threadId: args.threadId,
          totalRemoved: result.totalRemoved,
        },
        "Slow thread event pruning",
      );
    }
    return result;
  } catch (error) {
    deps.logger.warn(
      {
        durationMs: roundDurationMs(performance.now() - startedAt),
        err: error,
        mode: args.mode,
        step: getThreadEventPruningFailureStep(error),
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
