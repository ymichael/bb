import { useSyncExternalStore } from "react";

export const MOBILE_QUERY = "(max-width: 767px)";

// One MediaQueryList per query, shared across every useIsMobile() caller.
// (usehooks-ts's useMediaQuery allocates a new listener per component, which
// becomes a measurable cost once many rows, tooltips, and menus subscribe.)
type MediaQueryRef = {
  mql: MediaQueryList;
  subscribe: (notify: () => void) => () => void;
};

const mediaQueryCache = new Map<string, MediaQueryRef>();

function getMediaQuery(query: string): MediaQueryRef | null {
  if (typeof window === "undefined") return null;
  let ref = mediaQueryCache.get(query);
  if (ref) return ref;
  const mql = window.matchMedia(query);
  const listeners = new Set<() => void>();
  const onChange = () => {
    for (const listener of listeners) listener();
  };
  mql.addEventListener("change", onChange);
  ref = {
    mql,
    subscribe(notify) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
  };
  mediaQueryCache.set(query, ref);
  return ref;
}

export function useIsMobile(): boolean {
  const ref = getMediaQuery(MOBILE_QUERY);
  return useSyncExternalStore(
    (notify) => ref?.subscribe(notify) ?? (() => {}),
    () => ref?.mql.matches ?? false,
    () => false,
  );
}
