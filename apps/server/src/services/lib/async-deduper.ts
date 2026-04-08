export interface AsyncDeduper<TKey, TValue> {
  run(key: TKey, task: () => Promise<TValue>): Promise<TValue>;
}

export function createAsyncDeduper<TKey, TValue>(): AsyncDeduper<TKey, TValue> {
  const pendingByKey = new Map<TKey, Promise<TValue>>();

  return {
    run(key, task) {
      const pendingTask = pendingByKey.get(key);
      if (pendingTask) {
        return pendingTask;
      }

      const startedTask = task().finally(() => {
        if (pendingByKey.get(key) === startedTask) {
          pendingByKey.delete(key);
        }
      });
      pendingByKey.set(key, startedTask);
      return startedTask;
    },
  };
}
