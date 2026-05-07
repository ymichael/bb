const DIFF_WORKER_POOL_MAX_SIZE = 8;
const DIFF_WORKER_POOL_MIN_SIZE = 1;

export function getDiffWorkerPoolSize(): number {
  const hardwareConcurrency =
    typeof navigator !== "undefined"
      ? navigator.hardwareConcurrency
      : undefined;
  if (hardwareConcurrency === undefined || hardwareConcurrency <= 2) {
    return DIFF_WORKER_POOL_MIN_SIZE;
  }
  return Math.max(
    DIFF_WORKER_POOL_MIN_SIZE,
    Math.min(DIFF_WORKER_POOL_MAX_SIZE, hardwareConcurrency - 1),
  );
}

export function createDiffWorker(): Worker {
  return new Worker(
    new URL("@pierre/diffs/worker/worker-portable.js", import.meta.url),
    { name: "pierre-diffs-worker" },
  );
}
