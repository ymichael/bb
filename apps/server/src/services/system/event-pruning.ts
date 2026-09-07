import { performance } from "node:perf_hooks";
import {
  getThread,
  getLatestThreadSequence,
  pruneBackgroundTaskProgressEvents,
  pruneContextWindowUsageEventsBeforeSequence,
  pruneResolvedItemDeltas,
  pruneTokenUsageEventsBeforeSequence,
  pruneThreadEventsBeforeSequence,
} from "@bb/db";
import type { ThreadEventType } from "@bb/domain";
import { roundDurationMs } from "../lib/duration.js";
import type { AppDeps } from "../../types.js";

type ThreadEventPruningMode = "active" | "archived" | "idle";

interface PruneThreadEventHistoryArgs {
  mode: ThreadEventPruningMode;
  threadId: string;
}

interface ThreadEventPruningResult {
  latestSequence: number;
  removedAgePrunableEvents: number;
  removedBackgroundTaskProgressEvents: number;
  removedResolvedItemDeltas: number;
  sequenceCutoff: number;
  totalRemoved: number;
}

interface MaybePruneActiveThreadEventHistoryArgs {
  latestPrunableSequence: number;
  threadId: string;
}

interface ActiveThreadPruneState {
  lastPrunedAt: number;
  lastPrunedSequence: number;
}

type ThreadEventPruningStep =
  | "get_latest_thread_sequence"
  | "prune_background_task_progress"
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

const ACTIVE_THREAD_EVENT_KEEP_RECENT = 1_000;
const IDLE_THREAD_EVENT_KEEP_RECENT = 300;
const ARCHIVED_THREAD_EVENT_KEEP_RECENT = 120;
const ACTIVE_THREAD_EVENT_PRUNE_MIN_SEQUENCE_DELTA = 250;
const ACTIVE_THREAD_EVENT_PRUNE_MIN_INTERVAL_MS = 30_000;
const SLOW_THREAD_EVENT_PRUNE_LOG_THRESHOLD_MS = 1_000;

const AGE_PRUNABLE_THREAD_EVENT_TYPES: readonly ThreadEventType[] = [
  "thread/contextWindowUsage/updated",
  "thread/tokenUsage/updated",
  "turn/diff/updated",
] as const;

const ACTIVE_PRUNE_TRIGGER_THREAD_EVENT_TYPES: readonly ThreadEventType[] = [
  ...AGE_PRUNABLE_THREAD_EVENT_TYPES,
  "item/backgroundTask/progress",
] as const;

const GENERIC_AGE_PRUNABLE_THREAD_EVENT_TYPES: readonly ThreadEventType[] = [
  "turn/diff/updated",
] as const;

const KEEP_RECENT_BY_MODE: Record<ThreadEventPruningMode, number> = {
  active: ACTIVE_THREAD_EVENT_KEEP_RECENT,
  idle: IDLE_THREAD_EVENT_KEEP_RECENT,
  archived: ARCHIVED_THREAD_EVENT_KEEP_RECENT,
};

const activePruneTriggerThreadEventTypeSet = new Set<ThreadEventType>(
  ACTIVE_PRUNE_TRIGGER_THREAD_EVENT_TYPES,
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

export function isActivePruneTriggerThreadEventType(
  eventType: ThreadEventType,
): boolean {
  return activePruneTriggerThreadEventTypeSet.has(eventType);
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
  const removedBackgroundTaskProgressEvents = runThreadEventPruningStep(
    "prune_background_task_progress",
    () =>
      pruneBackgroundTaskProgressEvents(deps.db, {
        threadId: args.threadId,
      }),
  );

  return {
    latestSequence,
    removedAgePrunableEvents,
    removedBackgroundTaskProgressEvents,
    removedResolvedItemDeltas,
    sequenceCutoff,
    totalRemoved:
      removedAgePrunableEvents +
      removedBackgroundTaskProgressEvents +
      removedResolvedItemDeltas,
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
        mode: args.mode,
        step: getThreadEventPruningFailureStep(error),
        threadId: args.threadId,
        err: error,
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
  if (
    !thread ||
    (thread.status !== "active" && thread.status !== "idle") ||
    thread.archivedAt !== null
  ) {
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
    mode: thread.status === "active" ? "active" : "idle",
    threadId: args.threadId,
  });
}

export function resetActiveThreadEventPruningState(threadId: string): void {
  activeThreadPruneStateByThreadId.delete(threadId);
}
