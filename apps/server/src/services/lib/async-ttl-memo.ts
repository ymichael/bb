export interface AsyncTtlMemo<TKey, TValue> {
  clear(): void;
  run(key: TKey, task: () => Promise<TValue>): Promise<TValue>;
}

interface CreateAsyncTtlMemoOptions {
  ttlMs: number;
  now?: () => number;
}

interface MemoEntry<TValue> {
  expiresAt: number;
  value: TValue;
}

export function createAsyncTtlMemo<TKey, TValue>({
  ttlMs,
  now = Date.now,
}: CreateAsyncTtlMemoOptions): AsyncTtlMemo<TKey, TValue> {
  const settledByKey = new Map<TKey, MemoEntry<TValue>>();
  const pendingByKey = new Map<TKey, Promise<TValue>>();

  function pruneExpired(currentTime: number): void {
    for (const [key, entry] of settledByKey) {
      if (entry.expiresAt <= currentTime) {
        settledByKey.delete(key);
      }
    }
  }

  return {
    clear() {
      settledByKey.clear();
      pendingByKey.clear();
    },
    run(key, task) {
      const currentTime = now();
      const settled = settledByKey.get(key);
      if (settled !== undefined) {
        if (settled.expiresAt > currentTime) {
          return Promise.resolve(settled.value);
        }
        settledByKey.delete(key);
      }
      const pending = pendingByKey.get(key);
      if (pending !== undefined) {
        return pending;
      }
      const started = task()
        .then((value) => {
          const settledAt = now();
          pruneExpired(settledAt);
          settledByKey.set(key, { value, expiresAt: settledAt + ttlMs });
          return value;
        })
        .finally(() => {
          if (pendingByKey.get(key) === started) {
            pendingByKey.delete(key);
          }
        });
      pendingByKey.set(key, started);
      return started;
    },
  };
}
