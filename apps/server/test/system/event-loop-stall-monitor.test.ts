import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockEventLoopDelayHistogram {
  disable: () => void;
  enable: () => void;
  max: number;
  mean: number;
  percentile: (percentile: number) => number;
  reset: () => void;
}

const perfHooksMock = vi.hoisted(() => {
  const state: { histogram: MockEventLoopDelayHistogram | null } = {
    histogram: null,
  };

  return {
    monitorEventLoopDelay: vi.fn(() => {
      if (state.histogram === null) {
        throw new Error("Expected test histogram to be installed");
      }
      return state.histogram;
    }),
    state,
  };
});

vi.mock("node:perf_hooks", () => ({
  monitorEventLoopDelay: perfHooksMock.monitorEventLoopDelay,
}));

import { startEventLoopStallMonitor } from "../../src/services/system/event-loop-stall-monitor.js";

const EVENT_LOOP_STALL_MONITOR_INTERVAL_MS = 5_000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

interface InstallHistogramArgs {
  maxDelayMs: number;
  meanDelayMs: number;
  p99DelayMs: number;
}

function millisecondsToNanoseconds(durationMs: number): number {
  return durationMs * NANOSECONDS_PER_MILLISECOND;
}

function installHistogram(
  args: InstallHistogramArgs,
): MockEventLoopDelayHistogram {
  const histogram = {
    disable: vi.fn(),
    enable: vi.fn(),
    max: millisecondsToNanoseconds(args.maxDelayMs),
    mean: millisecondsToNanoseconds(args.meanDelayMs),
    percentile: vi.fn(() => millisecondsToNanoseconds(args.p99DelayMs)),
    reset: vi.fn(),
  };
  perfHooksMock.state.histogram = histogram;
  return histogram;
}

describe("event loop stall monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    perfHooksMock.monitorEventLoopDelay.mockClear();
    perfHooksMock.state.histogram = null;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("logs and resets when the max event loop delay reaches the threshold", () => {
    const histogram = installHistogram({
      maxDelayMs: 500,
      meanDelayMs: 25,
      p99DelayMs: 450,
    });
    const logger = { debug: vi.fn() };

    const monitor = startEventLoopStallMonitor({ logger });
    vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);

    expect(perfHooksMock.monitorEventLoopDelay).toHaveBeenCalledWith({
      resolution: 20,
    });
    expect(histogram.enable).toHaveBeenCalledTimes(1);
    expect(histogram.percentile).toHaveBeenCalledWith(99);
    expect(histogram.reset).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      {
        intervalMs: 5_000,
        maxDelayMs: 500,
        meanDelayMs: 25,
        p99DelayMs: 450,
        resolutionMs: 20,
        thresholdMs: 500,
      },
      "Event loop stalled",
    );

    monitor.stop();
  });

  it("does not log below the threshold", () => {
    const histogram = installHistogram({
      maxDelayMs: 499,
      meanDelayMs: 25,
      p99DelayMs: 450,
    });
    const logger = { debug: vi.fn() };

    const monitor = startEventLoopStallMonitor({ logger });
    vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);

    expect(logger.debug).not.toHaveBeenCalled();
    expect(histogram.reset).toHaveBeenCalledTimes(1);

    monitor.stop();
  });

  it("stops sampling after stop", () => {
    const histogram = installHistogram({
      maxDelayMs: 500,
      meanDelayMs: 25,
      p99DelayMs: 450,
    });
    const logger = { debug: vi.fn() };

    const monitor = startEventLoopStallMonitor({ logger });
    monitor.stop();
    vi.advanceTimersByTime(EVENT_LOOP_STALL_MONITOR_INTERVAL_MS);

    expect(histogram.disable).toHaveBeenCalledTimes(1);
    expect(histogram.reset).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
