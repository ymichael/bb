import { useSyncExternalStore } from "react";

// One MediaQueryList per query, shared across every caller. This avoids adding
// a browser listener for each row, tooltip, or overlay that subscribes.
type MediaQueryRef = {
  mql: MediaQueryList;
  subscribe: (notify: () => void) => () => void;
};

const mediaQueryCache = new Map<string, MediaQueryRef>();

function createMediaQueryRef(query: string): MediaQueryRef | null {
  if (typeof window === "undefined") return null;

  let ref = mediaQueryCache.get(query);
  if (ref) return ref;

  const mql = window.matchMedia(query);
  const listeners = new Set<() => void>();
  const onChange = () => {
    for (const listener of listeners) listener();
  };

  ref = {
    mql,
    subscribe(notify) {
      const wasEmpty = listeners.size === 0;
      listeners.add(notify);
      if (wasEmpty) {
        mql.addEventListener("change", onChange);
      }
      return () => {
        listeners.delete(notify);
        if (listeners.size === 0) {
          mql.removeEventListener("change", onChange);
          mediaQueryCache.delete(query);
        }
      };
    },
  };
  mediaQueryCache.set(query, ref);
  return ref;
}

function subscribeMediaQuery(
  query: string,
  notify: () => void,
): () => void {
  return createMediaQueryRef(query)?.subscribe(notify) ?? (() => {});
}

function getMediaQuerySnapshot(query: string): boolean {
  if (typeof window === "undefined") return false;

  return (
    mediaQueryCache.get(query)?.mql.matches ?? window.matchMedia(query).matches
  );
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => subscribeMediaQuery(query, notify),
    () => getMediaQuerySnapshot(query),
    () => false,
  );
}
