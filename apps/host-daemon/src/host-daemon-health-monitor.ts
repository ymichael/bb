import fs from "node:fs";
import type { HostDaemonLogger } from "./logger.js";

interface HostDaemonHealthMonitorTimer {
  clear(): void;
  unref(): void;
}

type HostDaemonHealthMonitorIntervalFn = (
  callback: () => void,
  intervalMs: number,
) => HostDaemonHealthMonitorTimer;

interface HostDaemonWatchCounts {
  workspaceWatches: number;
  threadStorageTargets: number;
}

export interface HostDaemonResourceUsage {
  rssBytes: number;
  openFds: number | null;
  inotifyInstances: number | null;
  threads: number | null;
}

interface HostDaemonHealthMonitorOptions {
  logger: Pick<HostDaemonLogger, "warn">;
  getWatchCounts: () => HostDaemonWatchCounts;
  readResourceUsage?: () => HostDaemonResourceUsage;
  setIntervalFn?: HostDaemonHealthMonitorIntervalFn;
  intervalMs?: number;
  inotifyInstanceWarnThreshold?: number;
}

interface HostDaemonHealthMonitor {
  stop(): void;
}

const DEFAULT_HEALTH_MONITOR_INTERVAL_MS = 60_000;
const DEFAULT_INOTIFY_INSTANCE_WARN_THRESHOLD = 8;

function countInotifyInstances(fds: string[]): number {
  let count = 0;
  for (const fd of fds) {
    try {
      if (fs.readlinkSync(`/proc/self/fd/${fd}`).includes("inotify")) {
        count += 1;
      }
    } catch {}
  }
  return count;
}

function defaultReadResourceUsage(): HostDaemonResourceUsage {
  const rssBytes = process.memoryUsage().rss;
  let openFds: number | null = null;
  let inotifyInstances: number | null = null;
  let threads: number | null = null;
  try {
    const fds = fs.readdirSync("/proc/self/fd");
    openFds = fds.length;
    inotifyInstances = countInotifyInstances(fds);
  } catch {}
  try {
    threads = fs.readdirSync("/proc/self/task").length;
  } catch {}
  return { rssBytes, openFds, inotifyInstances, threads };
}

export function startHostDaemonHealthMonitor(
  options: HostDaemonHealthMonitorOptions,
): HostDaemonHealthMonitor {
  const intervalMs = options.intervalMs ?? DEFAULT_HEALTH_MONITOR_INTERVAL_MS;
  const inotifyInstanceWarnThreshold =
    options.inotifyInstanceWarnThreshold ??
    DEFAULT_INOTIFY_INSTANCE_WARN_THRESHOLD;
  const readResourceUsage =
    options.readResourceUsage ?? defaultReadResourceUsage;
  const setIntervalFn: HostDaemonHealthMonitorIntervalFn =
    options.setIntervalFn ??
    ((callback, ms) => {
      const timer = setInterval(callback, ms);
      return {
        clear: () => clearInterval(timer),
        unref: () => timer.unref(),
      };
    });

  const timer = setIntervalFn(() => {
    const usage = readResourceUsage();
    if (
      usage.inotifyInstances !== null &&
      usage.inotifyInstances > inotifyInstanceWarnThreshold
    ) {
      const watchCounts = options.getWatchCounts();
      options.logger.warn(
        {
          rssBytes: usage.rssBytes,
          openFds: usage.openFds,
          inotifyInstances: usage.inotifyInstances,
          threads: usage.threads,
          workspaceWatches: watchCounts.workspaceWatches,
          threadStorageTargets: watchCounts.threadStorageTargets,
          warnThreshold: inotifyInstanceWarnThreshold,
        },
        "Host daemon inotify instance count is high; filesystem watchers are likely leaking (dead backends after poll interruptions)",
      );
    }
  }, intervalMs);
  timer.unref();

  return {
    stop() {
      timer.clear();
    },
  };
}
