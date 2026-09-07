import { monitorEventLoopDelay } from "node:perf_hooks";
import { roundDurationMs } from "../lib/duration.js";
import type { ServerLogger } from "../../types.js";
import { takeEventLoopWorkWindowSnapshot } from "./event-loop-work.js";

export interface EventLoopStallMonitorOptions {
  logger: Pick<ServerLogger, "info">;
  now?: () => number;
}

export interface EventLoopStallMonitor {
  stop: () => void;
}

const DEFAULT_EVENT_LOOP_STALL_LOG_THRESHOLD_MS = 500;
const DEFAULT_EVENT_LOOP_STALL_MONITOR_INTERVAL_MS = 5_000;
const DEFAULT_EVENT_LOOP_STALL_MONITOR_RESOLUTION_MS = 20;
const LIKELY_SYSTEM_SUSPENSION_MIN_DELAY_MS = 60_000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

function nanosecondsToMilliseconds(durationNs: number): number {
  return durationNs / NANOSECONDS_PER_MILLISECOND;
}

export function startEventLoopStallMonitor(
  options: EventLoopStallMonitorOptions,
): EventLoopStallMonitor {
  const now = options.now ?? (() => Date.now());
  const histogram = monitorEventLoopDelay({
    resolution: DEFAULT_EVENT_LOOP_STALL_MONITOR_RESOLUTION_MS,
  });
  histogram.enable();
  let lastSampleAt = now();

  const interval = setInterval(() => {
    const sampledAt = now();
    const sampleGapMs = sampledAt - lastSampleAt;
    lastSampleAt = sampledAt;
    const maxDelayMs = nanosecondsToMilliseconds(histogram.max);
    const work = takeEventLoopWorkWindowSnapshot();
    const resumedAfterLikelySystemSuspension =
      sampleGapMs - DEFAULT_EVENT_LOOP_STALL_MONITOR_INTERVAL_MS >=
      LIKELY_SYSTEM_SUSPENSION_MIN_DELAY_MS;
    if (
      !resumedAfterLikelySystemSuspension &&
      maxDelayMs >= DEFAULT_EVENT_LOOP_STALL_LOG_THRESHOLD_MS
    ) {
      options.logger.info(
        {
          intervalMs: DEFAULT_EVENT_LOOP_STALL_MONITOR_INTERVAL_MS,
          maxDelayMs: roundDurationMs(maxDelayMs),
          meanDelayMs: roundDurationMs(
            nanosecondsToMilliseconds(histogram.mean),
          ),
          p99DelayMs: roundDurationMs(
            nanosecondsToMilliseconds(histogram.percentile(99)),
          ),
          resolutionMs: DEFAULT_EVENT_LOOP_STALL_MONITOR_RESOLUTION_MS,
          thresholdMs: DEFAULT_EVENT_LOOP_STALL_LOG_THRESHOLD_MS,
          ...work,
        },
        "Event loop stalled",
      );
    }
    histogram.reset();
  }, DEFAULT_EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);
  interval.unref();

  return {
    stop: () => {
      clearInterval(interval);
      histogram.disable();
    },
  };
}
