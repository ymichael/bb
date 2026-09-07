import type { ServerLogger } from "../../types.js";
import type { ThreadTimelineBuildProfile } from "./timeline.js";

const SLOW_THREAD_TIMELINE_BUILD_LOG_THRESHOLD_MS = 150;

const SLOW_THREAD_TIMELINE_BUILD_LOG_INTERVAL_MS = 30_000;

const SLOW_THREAD_TIMELINE_BUILD_LOG_MAX_TRACKED_THREADS = 256;

interface LogSlowThreadTimelineBuildArgs {
  profile: ThreadTimelineBuildProfile;
  threadId: string;
}

interface SlowThreadTimelineBuildLogger {
  log(args: LogSlowThreadTimelineBuildArgs): void;
}

interface CreateSlowThreadTimelineBuildLoggerOptions {
  logger: Pick<ServerLogger, "info">;
  now?: () => number;
}

export function createSlowThreadTimelineBuildLogger(
  options: CreateSlowThreadTimelineBuildLoggerOptions,
): SlowThreadTimelineBuildLogger {
  const now = options.now ?? (() => Date.now());
  const lastLoggedAtByThread = new Map<string, number>();
  const suppressedByThread = new Map<string, number>();

  return {
    log({ profile, threadId }) {
      if (
        profile.totalDurationMs < SLOW_THREAD_TIMELINE_BUILD_LOG_THRESHOLD_MS
      ) {
        return;
      }
      const at = now();
      const lastLoggedAt = lastLoggedAtByThread.get(threadId);
      if (
        lastLoggedAt !== undefined &&
        at - lastLoggedAt < SLOW_THREAD_TIMELINE_BUILD_LOG_INTERVAL_MS
      ) {
        suppressedByThread.set(
          threadId,
          (suppressedByThread.get(threadId) ?? 0) + 1,
        );
        return;
      }

      const suppressedSinceLastLog = suppressedByThread.get(threadId) ?? 0;
      suppressedByThread.delete(threadId);
      lastLoggedAtByThread.delete(threadId);
      lastLoggedAtByThread.set(threadId, at);
      while (
        lastLoggedAtByThread.size >
        SLOW_THREAD_TIMELINE_BUILD_LOG_MAX_TRACKED_THREADS
      ) {
        const oldest = lastLoggedAtByThread.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        lastLoggedAtByThread.delete(oldest);
        suppressedByThread.delete(oldest);
      }

      options.logger.info(
        {
          threadId,
          totalDurationMs: profile.totalDurationMs,
          thresholdMs: SLOW_THREAD_TIMELINE_BUILD_LOG_THRESHOLD_MS,
          suppressedSinceLastLog,
          selectionStrategy: profile.selectionStrategy,
          pageKind: profile.pageKind,
          segmentLimit: profile.segmentLimit,
          eventRowCount: profile.eventRowCount,
          eventDataBytes: profile.eventDataBytes,
          decodedEventCount: profile.decodedEventCount,
          projectedRowCount: profile.projectedRowCount,
          responseRowCount: profile.responseRowCount,
          stageTimings: profile.stageTimings,
        },
        "Thread timeline build blocked the event loop",
      );
    },
  };
}
