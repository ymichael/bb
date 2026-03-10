import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const PERF_DEBUG_ENABLED = process.env.BEANBAG_DEBUG_PERF === "1";

const eventLoopDelayMonitor = monitorEventLoopDelay({ resolution: 20 });
if (PERF_DEBUG_ENABLED) {
  eventLoopDelayMonitor.enable();
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function eventLoopDelaySummary() {
  if (!PERF_DEBUG_ENABLED) {
    return undefined;
  }
  return {
    eventLoopMeanMs: roundMs(eventLoopDelayMonitor.mean / 1_000_000),
    eventLoopMaxMs: roundMs(eventLoopDelayMonitor.max / 1_000_000),
  };
}

export function isPerfDebugEnabled(): boolean {
  return PERF_DEBUG_ENABLED;
}

export function logPerf(label: string, fields?: Record<string, unknown>): void {
  if (!PERF_DEBUG_ENABLED) {
    return;
  }
  console.info(
    JSON.stringify({
      scope: "daemon-perf",
      label,
      ...(fields ?? {}),
      ...(eventLoopDelaySummary() ?? {}),
    }),
  );
}

export function measureSync<T>(
  label: string,
  fn: () => T,
  fields?: Record<string, unknown>,
): T {
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    logPerf(label, {
      durationMs: roundMs(performance.now() - startedAt),
      ...(fields ?? {}),
    });
  }
}

export async function measureAsync<T>(
  label: string,
  fn: () => Promise<T>,
  fields?: Record<string, unknown>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    logPerf(label, {
      durationMs: roundMs(performance.now() - startedAt),
      ...(fields ?? {}),
    });
  }
}
