import { useCallback, useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useLocation, useNavigate } from "react-router-dom";
import { createLocalStorageSyncStorage } from "./browser-storage";

const THREAD_SECONDARY_PANEL_QUERY_KEY = "secondaryPanel";
const THREAD_SECONDARY_PANEL_STORAGE_KEY = "bb.thread.secondaryPanel";
const THREAD_DIFF_PANEL_QUERY_VALUE = "git-diff";
const THREAD_INFO_PANEL_QUERY_VALUE = "thread-info";

export type ThreadSecondaryPanel = "git-diff" | "thread-info";

function decodeThreadSecondaryPanel(
  value: string | null,
): ThreadSecondaryPanel | null {
  switch (value) {
    case THREAD_DIFF_PANEL_QUERY_VALUE:
      return "git-diff";
    case THREAD_INFO_PANEL_QUERY_VALUE:
      return "thread-info";
    default:
      return null;
  }
}

const storedThreadSecondaryPanelBaseStorage =
  createLocalStorageSyncStorage<ThreadSecondaryPanel | null>({
    parse: (storedValue, initialValue) =>
      decodeThreadSecondaryPanel(storedValue) ?? initialValue,
    serialize: (value) => value ?? "",
  });

const storedThreadSecondaryPanelStorage = {
  getItem: storedThreadSecondaryPanelBaseStorage.getItem,
  setItem: (key: string, value: ThreadSecondaryPanel | null) => {
    if (value === null) {
      storedThreadSecondaryPanelBaseStorage.removeItem(key);
      return;
    }

    storedThreadSecondaryPanelBaseStorage.setItem(key, value);
  },
  removeItem: storedThreadSecondaryPanelBaseStorage.removeItem,
  subscribe: storedThreadSecondaryPanelBaseStorage.subscribe,
};

/**
 * Active secondary panel for the thread detail view. Backed by localStorage so
 * the last-selected tab persists across reloads. On navigation, the URL query
 * parameter overrides the stored value (see useThreadSecondaryPanelUrlSync).
 */
export const activeSecondaryPanelAtom =
  atomWithStorage<ThreadSecondaryPanel | null>(
    THREAD_SECONDARY_PANEL_STORAGE_KEY,
    null,
    storedThreadSecondaryPanelStorage,
    { getOnInit: true },
  );

export const isSecondaryPanelOpenAtom = atom(
  (get) => get(activeSecondaryPanelAtom) !== null,
);

export function getThreadSecondaryPanel(
  search: string,
): ThreadSecondaryPanel | null {
  const params = new URLSearchParams(search);
  return decodeThreadSecondaryPanel(
    params.get(THREAD_SECONDARY_PANEL_QUERY_KEY),
  );
}

export function withThreadSecondaryPanel(
  search: string,
  panel: ThreadSecondaryPanel | null,
): string {
  const params = new URLSearchParams(search);
  if (panel) {
    params.set(THREAD_SECONDARY_PANEL_QUERY_KEY, panel);
  } else {
    params.delete(THREAD_SECONDARY_PANEL_QUERY_KEY);
  }
  return params.toString();
}

/**
 * Mirrors the current URL query parameter into activeSecondaryPanelAtom when a
 * value is present. Mount once at the root of ThreadDetailView — do not call
 * from multiple components.
 */
export function useThreadSecondaryPanelUrlSync(): void {
  const location = useLocation();
  const setActive = useSetAtom(activeSecondaryPanelAtom);
  useEffect(() => {
    const fromUrl = getThreadSecondaryPanel(location.search);
    if (fromUrl !== null) {
      setActive((current) => (current === fromUrl ? current : fromUrl));
    }
  }, [location.search, setActive]);
}

/**
 * Returns a setter that updates both the atom (and localStorage via
 * atomWithStorage) and the URL query parameter so the change is persisted,
 * shareable, and visible to every subscriber of activeSecondaryPanelAtom.
 */
export function useSetThreadSecondaryPanel(): (
  panel: ThreadSecondaryPanel | null,
) => void {
  const setActive = useSetAtom(activeSecondaryPanelAtom);
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;
  return useCallback(
    (panel: ThreadSecondaryPanel | null) => {
      setActive(panel);
      const loc = locationRef.current;
      const nextSearch = withThreadSecondaryPanel(loc.search, panel);
      navigate(
        {
          pathname: loc.pathname,
          search: nextSearch.length > 0 ? `?${nextSearch}` : "",
        },
        { replace: true },
      );
    },
    [navigate, setActive],
  );
}

export function useActiveSecondaryPanel(): ThreadSecondaryPanel | null {
  return useAtomValue(activeSecondaryPanelAtom);
}

export function useIsSecondaryPanelOpen(): boolean {
  return useAtomValue(isSecondaryPanelOpenAtom);
}
