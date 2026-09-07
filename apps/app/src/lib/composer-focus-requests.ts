type ComposerFocusListener = () => void;

const listenersByStorageKey = new Map<string, Set<ComposerFocusListener>>();

export function subscribeComposerFocusRequests(
  storageKey: string | null,
  listener: ComposerFocusListener,
): () => void {
  if (storageKey === null) return () => {};
  let listeners = listenersByStorageKey.get(storageKey);
  if (!listeners) {
    listeners = new Set();
    listenersByStorageKey.set(storageKey, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      listenersByStorageKey.delete(storageKey);
    }
  };
}

export function requestComposerFocus(storageKey: string | null): void {
  if (storageKey === null) return;
  const listeners = listenersByStorageKey.get(storageKey);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    listener();
  }
}
