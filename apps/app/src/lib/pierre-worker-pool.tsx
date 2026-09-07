import {
  getOrCreateWorkerPoolSingleton,
  terminateWorkerPoolSingleton,
  type WorkerPoolManager,
} from "@pierre/diffs/worker";
import { createDiffWorker, getDiffWorkerPoolSize } from "./diff-worker-pool";
import {
  useSyncPierreWorkerPoolTheme,
  type CodeThemePair,
} from "./pierre-worker-pool-theme";

const WORKER_POOL_OPTIONS = {
  workerFactory: createDiffWorker,
  poolSize: getDiffWorkerPoolSize(),
};

export function acquirePierreWorkerPool(
  theme: CodeThemePair,
): WorkerPoolManager {
  return getOrCreateWorkerPoolSingleton({
    poolOptions: WORKER_POOL_OPTIONS,
    highlighterOptions: { theme },
  });
}

export function releasePierreWorkerPool(): void {
  terminateWorkerPoolSingleton();
}

export function PierreWorkerPoolThemeSync({
  pool,
  constructedTheme,
}: {
  pool: WorkerPoolManager;
  constructedTheme: CodeThemePair;
}) {
  useSyncPierreWorkerPoolTheme(pool, constructedTheme);
  return null;
}
