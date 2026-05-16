import { useCallback, useEffect, useRef } from "react";
import { atom } from "jotai";
import { useAtomValue, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomFamily } from "jotai-family";
import { createLocalStorageSyncStorage } from "./browser-storage";
import {
  EMPTY_THREAD_TERMINAL_PANEL_STATE,
  getThreadTerminalPanelStateStorageKey,
  parseThreadTerminalPanelState,
  pruneThreadTerminalPanelStorage,
  serializeThreadTerminalPanelState,
  type ThreadTerminalPanelState,
} from "./thread-terminal-panel-state";

const THREAD_TERMINAL_PANEL_TOUCH_THROTTLE_MS = 60 * 1000;

type ThreadTerminalPanelThreadId = string | null | undefined;

export type ThreadTerminalPanelStateUpdater = (
  state: ThreadTerminalPanelState,
) => ThreadTerminalPanelState;

interface LastThreadTerminalPanelTouch {
  threadId: ThreadTerminalPanelThreadId;
  touchedAt: number;
}

function hasThreadId(threadId: string | null | undefined): threadId is string {
  return threadId !== null && threadId !== undefined && threadId.length > 0;
}

function touchThreadTerminalPanelState(
  state: ThreadTerminalPanelState,
  now: number,
): ThreadTerminalPanelState {
  return {
    ...state,
    lastUsedAt: now,
  };
}

const threadTerminalPanelStateStorage =
  createLocalStorageSyncStorage<ThreadTerminalPanelState>({
    parse: (storedValue, initialValue) =>
      parseThreadTerminalPanelState({
        initialValue,
        now: Date.now(),
        storedValue,
      }),
    serialize: (state) => serializeThreadTerminalPanelState({ state }),
  });

const disabledThreadTerminalPanelStateAtom = atom(
  EMPTY_THREAD_TERMINAL_PANEL_STATE,
);

const threadTerminalPanelStateAtomFamily = atomFamily((threadId: string) =>
  atomWithStorage<ThreadTerminalPanelState>(
    getThreadTerminalPanelStateStorageKey({ threadId }),
    EMPTY_THREAD_TERMINAL_PANEL_STATE,
    threadTerminalPanelStateStorage,
    { getOnInit: true },
  ),
);

function getThreadTerminalPanelStateAtom(
  threadId: string | null | undefined,
) {
  return hasThreadId(threadId)
    ? threadTerminalPanelStateAtomFamily(threadId)
    : disabledThreadTerminalPanelStateAtom;
}

function setThreadTerminalPanelOpen(
  open: boolean,
): ThreadTerminalPanelStateUpdater {
  return (current) => {
    if (current.isOpen === open) {
      return current;
    }
    return {
      ...current,
      isOpen: open,
    };
  };
}

export function useThreadTerminalPanelStorageMaintenance(
  threadId: ThreadTerminalPanelThreadId,
): void {
  useEffect(() => {
    pruneThreadTerminalPanelStorage({ now: Date.now() });
  }, [threadId]);
}

export function useThreadTerminalPanelState(
  threadId: string | null | undefined,
): ThreadTerminalPanelState {
  return useAtomValue(getThreadTerminalPanelStateAtom(threadId));
}

export function useUpdateThreadTerminalPanelState(
  threadId: string | null | undefined,
): (update: ThreadTerminalPanelStateUpdater) => void {
  const setState = useSetAtom(getThreadTerminalPanelStateAtom(threadId));
  return useCallback(
    (update: ThreadTerminalPanelStateUpdater) => {
      if (!hasThreadId(threadId)) return;
      const now = Date.now();
      setState((current) => {
        const next = update(current);
        if (next === current) {
          return current;
        }
        return touchThreadTerminalPanelState(next, now);
      });
    },
    [setState, threadId],
  );
}

export function useSetThreadTerminalPanelOpen(
  threadId: string | null | undefined,
): (open: boolean) => void {
  const updateState = useUpdateThreadTerminalPanelState(threadId);
  return useCallback(
    (open: boolean) => {
      updateState(setThreadTerminalPanelOpen(open));
    },
    [updateState],
  );
}

export function useToggleThreadTerminalPanel(
  threadId: string | null | undefined,
): () => void {
  const updateState = useUpdateThreadTerminalPanelState(threadId);
  return useCallback(() => {
    updateState((current) => ({
      ...current,
      isOpen: !current.isOpen,
    }));
  }, [updateState]);
}

export function useTouchThreadTerminalPanelState(
  threadId: string | null | undefined,
): () => void {
  const updateState = useUpdateThreadTerminalPanelState(threadId);
  const lastTouchRef = useRef<LastThreadTerminalPanelTouch | null>(null);
  return useCallback(() => {
    const now = Date.now();
    if (
      lastTouchRef.current !== null &&
      lastTouchRef.current.threadId === threadId &&
      now - lastTouchRef.current.touchedAt <
        THREAD_TERMINAL_PANEL_TOUCH_THROTTLE_MS
    ) {
      return;
    }
    lastTouchRef.current = {
      threadId,
      touchedAt: now,
    };
    updateState((current) => {
      if (
        !current.isOpen ||
        now - current.lastUsedAt < THREAD_TERMINAL_PANEL_TOUCH_THROTTLE_MS
      ) {
        return current;
      }
      return { ...current };
    });
  }, [threadId, updateState]);
}

export function useIsThreadTerminalPanelOpen(
  threadId: string | null | undefined,
): boolean {
  return useThreadTerminalPanelState(threadId).isOpen;
}
