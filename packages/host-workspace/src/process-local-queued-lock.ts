import { AsyncLocalStorage } from "node:async_hooks";

const DEFAULT_PROCESS_LOCAL_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

export type ProcessLocalQueuedLockWork<T> = () => Promise<T>;

export type ProcessLocalQueuedLockSpec = {
  key: string;
  timeoutMs?: number;
};

interface ProcessLocalQueuedLockTimeoutArgs {
  key: string;
  timeoutMs: number;
}

type WithProcessLocalQueuedLocksArgs<T> = {
  locks: ProcessLocalQueuedLockSpec[];
  signal?: AbortSignal;
  work: ProcessLocalQueuedLockWork<T>;
};

type WithProcessLocalQueuedLocksAtIndexArgs<T> = {
  locks: ProcessLocalQueuedLockSpec[];
  index: number;
  signal: AbortSignal | undefined;
  work: ProcessLocalQueuedLockWork<T>;
};

type WithProcessLocalQueuedLockArgs<T> = {
  lock: ProcessLocalQueuedLockSpec;
  signal: AbortSignal | undefined;
  work: ProcessLocalQueuedLockWork<T>;
};

export class ProcessLocalQueuedLockTimeoutError extends Error {
  readonly key: string;
  readonly timeoutMs: number;

  constructor(args: ProcessLocalQueuedLockTimeoutArgs) {
    super(`Timed out waiting for process-local lock ${args.key}`);
    this.name = "ProcessLocalQueuedLockTimeoutError";
    this.key = args.key;
    this.timeoutMs = args.timeoutMs;
  }
}

export async function withProcessLocalQueuedLocks<T>(
  args: WithProcessLocalQueuedLocksArgs<T>,
): Promise<T> {
  const locks = normalizeProcessLocalLockSpecs(args.locks);
  return withProcessLocalQueuedLocksAtIndex({
    locks,
    index: 0,
    signal: args.signal,
    work: args.work,
  });
}

const heldLocks = new AsyncLocalStorage<Set<string>>();
const lockQueues = new Map<string, Promise<void>>();

function normalizeProcessLocalLockSpecs(
  locks: ProcessLocalQueuedLockSpec[],
): ProcessLocalQueuedLockSpec[] {
  const locksByKey = new Map<string, ProcessLocalQueuedLockSpec>();
  for (const lock of locks) {
    if (!locksByKey.has(lock.key)) {
      locksByKey.set(lock.key, lock);
    }
  }
  return Array.from(locksByKey.values()).sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

function withProcessLocalQueuedLocksAtIndex<T>(
  args: WithProcessLocalQueuedLocksAtIndexArgs<T>,
): Promise<T> {
  const lock = args.locks[args.index];
  if (!lock) {
    return args.work();
  }

  return withProcessLocalQueuedLock({
    lock,
    work: () =>
      withProcessLocalQueuedLocksAtIndex({
        locks: args.locks,
        index: args.index + 1,
        signal: args.signal,
        work: args.work,
      }),
    signal: args.signal,
  });
}

function withProcessLocalQueuedLock<T>(
  args: WithProcessLocalQueuedLockArgs<T>,
): Promise<T> {
  const held = heldLocks.getStore();
  if (held?.has(args.lock.key)) {
    return args.work();
  }

  return runInProcessQueue(
    args.lock.key,
    () => heldLocks.run(new Set([...(held ?? []), args.lock.key]), args.work),
    args.lock.timeoutMs ?? DEFAULT_PROCESS_LOCAL_LOCK_TIMEOUT_MS,
    args.signal,
  );
}

function lockAbortError(key: string, signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new Error(`Aborted waiting for process-local lock ${key}`);
}

function runInProcessQueue<T>(
  key: string,
  work: ProcessLocalQueuedLockWork<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(lockAbortError(key, signal));
  }

  const previous = lockQueues.get(key) ?? Promise.resolve();
  let started = false;
  let aborted = false;
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (removeAbortListener) {
        removeAbortListener();
        removeAbortListener = undefined;
      }
      if (aborted && signal) {
        throw lockAbortError(key, signal);
      }
      if (timedOut) {
        throw new ProcessLocalQueuedLockTimeoutError({ key, timeoutMs });
      }
      started = true;
      return work();
    });
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  lockQueues.set(key, settled);
  void settled.then(() => {
    if (lockQueues.get(key) === settled) {
      lockQueues.delete(key);
    }
  });
  if (timeoutMs <= 0) {
    return next;
  }

  return new Promise<T>((resolve, reject) => {
    timeout = setTimeout(() => {
      if (started) {
        return;
      }
      timedOut = true;
      reject(
        new ProcessLocalQueuedLockTimeoutError({
          key,
          timeoutMs,
        }),
      );
    }, timeoutMs);

    if (signal) {
      const onAbort = () => {
        if (started) {
          return;
        }
        aborted = true;
        reject(lockAbortError(key, signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => {
        signal.removeEventListener("abort", onAbort);
      };
    }

    next.then(
      (value) => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        if (removeAbortListener) {
          removeAbortListener();
          removeAbortListener = undefined;
        }
        resolve(value);
      },
      (error: unknown) => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        if (removeAbortListener) {
          removeAbortListener();
          removeAbortListener = undefined;
        }
        reject(error);
      },
    );
  });
}
