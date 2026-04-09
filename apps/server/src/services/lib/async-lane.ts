export interface AsyncLane<TKey> {
  clear(): void;
  size(): number;
  run<TValue>(key: TKey, task: () => Promise<TValue>): Promise<TValue>;
}

export function createAsyncLane<TKey>(): AsyncLane<TKey> {
  const tailByKey = new Map<TKey, Promise<void>>();

  return {
    clear() {
      tailByKey.clear();
    },
    size() {
      return tailByKey.size;
    },
    async run(key, task) {
      const previous = tailByKey.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.catch(() => undefined).then(() => current);
      tailByKey.set(key, tail);

      try {
        await previous.catch(() => undefined);
        return await task();
      } finally {
        release();
        if (tailByKey.get(key) === tail) {
          tailByKey.delete(key);
        }
      }
    },
  };
}
