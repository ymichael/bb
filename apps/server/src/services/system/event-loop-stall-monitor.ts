import { monitorEventLoopDelay } from "node:perf_hooks";
import { roundDurationMs } from "../lib/duration.js";
import type { ServerLogger } from "../../types.js";

export interface EventLoopStallMonitorOptions {
  logger: Pick<ServerLogger, "warn">;
}

export interface EventLoopStallMonitor {
  stop: () => void;
}

const DEFAULT_EVENT_LOOP_STALL_LOG_THRESHOLD_MS = 500;
const DEFAULT_EVENT_LOOP_STALL_MONITOR_INTERVAL_MS = 5_000;
const DEFAULT_EVENT_LOOP_STALL_MONITOR_RESOLUTION_MS = 20;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

function nanosecondsToMilliseconds(durationNs: number): number {
  return durationNs / NANOSECONDS_PER_MILLISECOND;
}

export function startEventLoopStallMonitor(
  options: EventLoopStallMonitorOptions,
): EventLoopStallMonitor {
  const histogram = monitorEventLoopDelay({
    resolution: DEFAULT_EVENT_LOOP_STALL_MONITOR_RESOLUTION_MS,
  });
  histogram.enable();

  const interval = setInterval(() => {
    const maxDelayMs = nanosecondsToMilliseconds(histogram.max);
    if (maxDelayMs >= DEFAULT_EVENT_LOOP_STALL_LOG_THRESHOLD_MS) {
      options.logger.warn(
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
