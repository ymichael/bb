import { AsyncLocalStorage } from "node:async_hooks";

const DEFAULT_PROCESS_LOCAL_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

export type ProcessLocalQueuedLockWork<T> = () => Promise<T>;

export type ProcessLocalQueuedLockSpec = {
  key: string;
  timeoutMs?: number;
};

export interface ProcessLocalQueuedLockTimeoutArgs {
  key: string;
  timeoutMs: number;
}

export type WithProcessLocalQueuedLocksArgs<T> = {
  locks: ProcessLocalQueuedLockSpec[];
  work: ProcessLocalQueuedLockWork<T>;
};

type WithProcessLocalQueuedLocksAtIndexArgs<T> = {
  locks: ProcessLocalQueuedLockSpec[];
  index: number;
  work: ProcessLocalQueuedLockWork<T>;
};

type WithProcessLocalQueuedLockArgs<T> = {
  lock: ProcessLocalQueuedLockSpec;
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

/**
 * Serializes work only within the current Node.js process. This intentionally
 * does not protect against another host-daemon process mutating the same path.
 */
export async function withProcessLocalQueuedLocks<T>(
  args: WithProcessLocalQueuedLocksArgs<T>,
): Promise<T> {
  const locks = normalizeProcessLocalLockSpecs(args.locks);
  return withProcessLocalQueuedLocksAtIndex({
    locks,
    index: 0,
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
        work: args.work,
      }),
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
  );
}

function runInProcessQueue<T>(
  key: string,
  work: ProcessLocalQueuedLockWork<T>,
  timeoutMs: number,
): Promise<T> {
  const previous = lockQueues.get(key) ?? Promise.resolve();
  // Queue nodes stay in the chain even when their public promise times out.
  // When the timed-out node reaches the head, it observes timedOut and skips
  // work. This preserves FIFO ordering for later waiters instead of letting a
  // timed-out caller punch a hole in the queue. Once work has started, timeout
  // no longer cancels it; ownership has transferred to the caller's critical
  // section, and cancellation would leave the protected git operation midway.
  let started = false;
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
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
  // Only the current tail may remove itself. A newer waiter can append while
  // this node is still running; deleting unconditionally would erase that newer
  // tail and allow later callers to bypass it.
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

    next.then(
      (value) => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        resolve(value);
      },
      (error: unknown) => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        reject(error);
      },
    );
  });
}
