import { useCallback, useEffect, useRef } from "react";
import { atom } from "jotai";
import { useAtomValue, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomFamily } from "jotai-family";
import { useLocation, useNavigate } from "react-router-dom";
import { createLocalStorageSyncStorage } from "./browser-storage";
import {
  EMPTY_THREAD_SECONDARY_PANEL_STATE,
  getThreadSecondaryPanelStateStorageKey,
  parseThreadSecondaryPanelState,
  pruneThreadSecondaryPanelStorage,
  serializeThreadSecondaryPanelState,
  type ThreadSecondaryPanelState,
} from "./thread-secondary-panel-state";

const THREAD_SECONDARY_PANEL_QUERY_KEY = "secondaryPanel";
const THREAD_DIFF_PANEL_QUERY_VALUE = "git-diff";
const THREAD_INFO_PANEL_QUERY_VALUE = "thread-info";
const THREAD_SECONDARY_PANEL_TOUCH_THROTTLE_MS = 60 * 1000;

export type ThreadSecondaryPanel = "git-diff" | "thread-info";

type ThreadSecondaryPanelThreadId = string | null | undefined;

export type ThreadSecondaryPanelStateUpdater = (
  state: ThreadSecondaryPanelState,
) => ThreadSecondaryPanelState;

interface LastThreadSecondaryPanelTouch {
  threadId: ThreadSecondaryPanelThreadId;
  touchedAt: number;
}

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

function hasThreadId(threadId: string | null | undefined): threadId is string {
  return threadId !== null && threadId !== undefined && threadId.length > 0;
}

function touchThreadSecondaryPanelState(
  state: ThreadSecondaryPanelState,
  now: number,
): ThreadSecondaryPanelState {
  return {
    ...state,
    lastUsedAt: now,
  };
}

const threadSecondaryPanelStateStorage =
  createLocalStorageSyncStorage<ThreadSecondaryPanelState>({
    parse: (storedValue, initialValue) =>
      parseThreadSecondaryPanelState({
        initialValue,
        now: Date.now(),
        storedValue,
      }),
    serialize: (state) => serializeThreadSecondaryPanelState({ state }),
  });

const disabledThreadSecondaryPanelStateAtom = atom(
  EMPTY_THREAD_SECONDARY_PANEL_STATE,
);

const threadSecondaryPanelStateAtomFamily = atomFamily((threadId: string) =>
  atomWithStorage<ThreadSecondaryPanelState>(
    getThreadSecondaryPanelStateStorageKey({ threadId }),
    EMPTY_THREAD_SECONDARY_PANEL_STATE,
    threadSecondaryPanelStateStorage,
    { getOnInit: true },
  ),
);

function getThreadSecondaryPanelStateAtom(
  threadId: string | null | undefined,
) {
  return hasThreadId(threadId)
    ? threadSecondaryPanelStateAtomFamily(threadId)
    : disabledThreadSecondaryPanelStateAtom;
}

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

export function useThreadSecondaryPanelStorageMaintenance(
  threadId: ThreadSecondaryPanelThreadId,
): void {
  useEffect(() => {
    pruneThreadSecondaryPanelStorage({ now: Date.now() });
  }, [threadId]);
}

export function useThreadSecondaryPanelState(
  threadId: string | null | undefined,
): ThreadSecondaryPanelState {
  return useAtomValue(getThreadSecondaryPanelStateAtom(threadId));
}

export function useUpdateThreadSecondaryPanelState(
  threadId: string | null | undefined,
): (update: ThreadSecondaryPanelStateUpdater) => void {
  const setState = useSetAtom(getThreadSecondaryPanelStateAtom(threadId));
  return useCallback(
    (update: ThreadSecondaryPanelStateUpdater) => {
      if (!hasThreadId(threadId)) return;
      const now = Date.now();
      setState((current) => {
        const next = update(current);
        if (next === current) {
          return current;
        }
        return touchThreadSecondaryPanelState(next, now);
      });
    },
    [setState, threadId],
  );
}

/**
 * Applies the current URL query parameter as a one-shot override for the
 * current thread's secondary panel state, then removes the query so it cannot
 * bleed into later thread navigation. Mount once at the root of
 * ThreadDetailView; do not call from multiple components.
 */
export function useThreadSecondaryPanelUrlSync(
  threadId: string | null | undefined,
): void {
  const location = useLocation();
  const navigate = useNavigate();
  const updateState = useUpdateThreadSecondaryPanelState(threadId);
  useEffect(() => {
    const fromUrl = getThreadSecondaryPanel(location.search);
    if (fromUrl === null) {
      return;
    }

    updateState((current) => {
      if (current.activePanel === fromUrl) {
        return current;
      }
      return {
        ...current,
        activePanel: fromUrl,
      };
    });

    const nextSearch = withThreadSecondaryPanel(location.search, null);
    navigate(
      {
        pathname: location.pathname,
        search: nextSearch.length > 0 ? `?${nextSearch}` : "",
      },
      { replace: true },
    );
  }, [location.pathname, location.search, navigate, updateState]);
}

function clearThreadSecondaryPanelSearch(search: string): string {
  return withThreadSecondaryPanel(search, null);
}

function setThreadSecondaryPanelState(
  panel: ThreadSecondaryPanel | null,
): ThreadSecondaryPanelStateUpdater {
  return (current) => {
    if (current.activePanel === panel) {
      return current;
    }
    return {
      ...current,
      activePanel: panel,
    };
  };
}

/**
 * Returns a setter that updates the current thread state and clears any
 * one-shot URL override query left behind by an inbound link.
 */
export function useSetThreadSecondaryPanel(
  threadId: string | null | undefined,
): (panel: ThreadSecondaryPanel | null) => void {
  const updateState = useUpdateThreadSecondaryPanelState(threadId);
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;
  return useCallback(
    (panel: ThreadSecondaryPanel | null) => {
      if (!hasThreadId(threadId)) return;
      updateState(setThreadSecondaryPanelState(panel));
      const loc = locationRef.current;
      const nextSearch = clearThreadSecondaryPanelSearch(loc.search);
      navigate(
        {
          pathname: loc.pathname,
          search: nextSearch.length > 0 ? `?${nextSearch}` : "",
        },
        { replace: true },
      );
    },
    [navigate, threadId, updateState],
  );
}

export function useTouchThreadSecondaryPanelState(
  threadId: string | null | undefined,
): () => void {
  const updateState = useUpdateThreadSecondaryPanelState(threadId);
  const lastTouchRef = useRef<LastThreadSecondaryPanelTouch | null>(null);
  return useCallback(() => {
    const now = Date.now();
    if (
      lastTouchRef.current !== null &&
      lastTouchRef.current.threadId === threadId &&
      now - lastTouchRef.current.touchedAt <
        THREAD_SECONDARY_PANEL_TOUCH_THROTTLE_MS
    ) {
      return;
    }
    lastTouchRef.current = {
      threadId,
      touchedAt: now,
    };
    updateState((current) => {
      if (
        current.activePanel === null ||
        now - current.lastUsedAt < THREAD_SECONDARY_PANEL_TOUCH_THROTTLE_MS
      ) {
        return current;
      }
      return { ...current };
    });
  }, [threadId, updateState]);
}

export function useActiveSecondaryPanel(
  threadId: string | null | undefined,
): ThreadSecondaryPanel | null {
  return useThreadSecondaryPanelState(threadId).activePanel;
}

export function useIsSecondaryPanelOpen(
  threadId: string | null | undefined,
): boolean {
  return useActiveSecondaryPanel(threadId) !== null;
}
