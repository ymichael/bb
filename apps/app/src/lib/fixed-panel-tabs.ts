import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { atom } from "jotai";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomFamily } from "jotai-family";
import type { TerminalCreateTarget } from "@bb/server-contract";
import { createLocalStorageSyncStorage } from "./browser-storage";
import { useThreadTabs } from "@/hooks/queries/thread-tabs-query";
import {
  closeSecondaryPanelTabInState,
  reconcileFixedPanelViewTabsInState,
} from "@bb/client-core";
import {
  EMPTY_FIXED_PANEL_TABS_STATE,
  createGitDiffFixedPanelTab,
  createTerminalFixedPanelTab,
  createThreadInfoFixedPanelTab,
  ensureOpenFixedPanelHasActiveTab,
  getFixedPanelTabsStateStorageKey,
  parseFixedPanelTabsState,
  pruneFixedPanelTabsStorage,
  serializeFixedPanelTabsState,
  type FixedPanelTab,
  type FixedPanelTabsState,
  type FixedPanelViewTab,
  type TerminalFixedPanelTab,
} from "./fixed-panel-tabs-state";
import { type ThreadSecondaryPanel } from "./thread-secondary-panel";
import {
  areThreadTabListsEquivalent,
  hasPendingThreadTabsWrite,
  reconcileFixedPanelTabsState,
  scheduleLocalThreadTabsMigration,
  scheduleThreadTabsPersistence,
} from "./thread-tabs-sync";

const FIXED_PANEL_TABS_TOUCH_THROTTLE_MS = 60 * 1000;

type FixedPanelTabsPanelStateId = string | null | undefined;
type FixedPanelTabsSyncThreadId = string | null | undefined;

type FixedPanelTabsStateUpdater = (
  state: FixedPanelTabsState,
) => FixedPanelTabsState;

interface LastFixedPanelTabsTouch {
  threadId: FixedPanelTabsPanelStateId;
  touchedAt: number;
}

type FixedPanelSecondaryPanelSetter = (panel: ThreadSecondaryPanel) => void;
type FixedPanelSecondaryPanelOpener = () => void;
type FixedPanelSecondaryPanelCloser = () => void;
type FixedPanelTerminalIdSetter = (terminalId: string | null) => void;
type FixedPanelTerminalIdRemover = (terminalId: string) => void;

function hasThreadId(threadId: string | null | undefined): threadId is string {
  return threadId !== null && threadId !== undefined && threadId.length > 0;
}

function touchFixedPanelTabsState(
  state: FixedPanelTabsState,
  now: number,
): FixedPanelTabsState {
  return {
    ...state,
    lastUsedAt: now,
  };
}

const fixedPanelTabsStateStorage =
  createLocalStorageSyncStorage<FixedPanelTabsState>({
    parse: (storedValue, initialValue) =>
      parseFixedPanelTabsState({
        initialValue,
        now: Date.now(),
        storedValue,
      }),
    serialize: (state) => serializeFixedPanelTabsState({ state }),
  });

const disabledFixedPanelTabsStateAtom = atom(EMPTY_FIXED_PANEL_TABS_STATE);

const fixedPanelTabsStateAtomFamily = atomFamily((threadId: string) =>
  atomWithStorage<FixedPanelTabsState>(
    getFixedPanelTabsStateStorageKey({ threadId }),
    EMPTY_FIXED_PANEL_TABS_STATE,
    fixedPanelTabsStateStorage,
    { getOnInit: true },
  ),
);

export function resetFixedPanelTabsStateForTest(): void {
  fixedPanelTabsStateAtomFamily.setShouldRemove(() => true);
  fixedPanelTabsStateAtomFamily.setShouldRemove(null);
}

function getFixedPanelTabsStateAtom(threadId: string | null | undefined) {
  return hasThreadId(threadId)
    ? fixedPanelTabsStateAtomFamily(threadId)
    : disabledFixedPanelTabsStateAtom;
}

function buildSecondaryPanelTab(panel: ThreadSecondaryPanel): FixedPanelTab {
  if (panel === "git-diff") return createGitDiffFixedPanelTab();
  return createThreadInfoFixedPanelTab();
}

function getSecondaryPanelTabId(panel: ThreadSecondaryPanel): string {
  return buildSecondaryPanelTab(panel).id;
}

function findActiveTerminalTab(
  state: FixedPanelTabsState,
): TerminalFixedPanelTab | null {
  const activeTabId = state.secondary.activeTabId;
  if (activeTabId === null) {
    return null;
  }

  const activeTab = state.secondary.tabs.find((tab) => tab.id === activeTabId);
  return activeTab?.kind === "terminal" ? activeTab : null;
}

export function upsertTerminalTab(
  tabs: readonly FixedPanelTab[],
  terminalId: string,
  target?: TerminalCreateTarget,
): readonly FixedPanelTab[] {
  const nextTab = createTerminalFixedPanelTab({ terminalId, target });
  const existingTab = tabs.find((tab) => tab.id === nextTab.id);
  if (existingTab === undefined) return [...tabs, nextTab];
  if (
    target === undefined ||
    (existingTab.kind === "terminal" && existingTab.target === target)
  ) {
    return tabs;
  }
  return tabs.map((tab) => (tab.id === nextTab.id ? nextTab : tab));
}

export function removeFixedRightTerminalTabInState(
  state: FixedPanelTabsState,
  terminalId: string,
): FixedPanelTabsState {
  return closeSecondaryPanelTabInState(
    state,
    createTerminalFixedPanelTab({ terminalId }).id,
  );
}

function ensureSecondaryPanelTab(
  tabs: readonly FixedPanelTab[],
  panel: ThreadSecondaryPanel,
): readonly FixedPanelTab[] {
  const tabId = getSecondaryPanelTabId(panel);
  return tabs.some((tab) => tab.id === tabId)
    ? tabs
    : [...tabs, buildSecondaryPanelTab(panel)];
}

function hasSecondaryPanelTab(
  tabs: readonly FixedPanelTab[],
  activeTabId: string | null,
): boolean {
  return activeTabId !== null && tabs.some((tab) => tab.id === activeTabId);
}

function openFixedSecondaryPanelState(
  current: FixedPanelTabsState,
): FixedPanelTabsState {
  if (
    hasSecondaryPanelTab(current.secondary.tabs, current.secondary.activeTabId)
  ) {
    if (current.secondary.isOpen) {
      return current;
    }
    return {
      ...current,
      secondary: {
        ...current.secondary,
        isOpen: true,
      },
    };
  }

  const panel: ThreadSecondaryPanel = "thread-info";
  const tabs = ensureSecondaryPanelTab(current.secondary.tabs, panel);
  const activeTabId = getSecondaryPanelTabId(panel);
  return {
    ...current,
    secondary: {
      tabs,
      activeTabId,
      isOpen: true,
    },
  };
}

function closeFixedSecondaryPanelState(
  current: FixedPanelTabsState,
): FixedPanelTabsState {
  if (!current.secondary.isOpen) {
    return current;
  }
  return {
    ...current,
    secondary: {
      ...current.secondary,
      isOpen: false,
    },
  };
}

let hasScheduledFixedPanelTabsStoragePrune = false;

export function useFixedPanelTabsStorageMaintenance(): void {
  useEffect(() => {
    if (hasScheduledFixedPanelTabsStoragePrune) {
      return;
    }
    hasScheduledFixedPanelTabsStoragePrune = true;
    scheduleIdleFixedPanelTabsStoragePrune();
  }, []);
}

const FIXED_PANEL_TABS_STORAGE_PRUNE_IDLE_TIMEOUT_MS = 5_000;
const FIXED_PANEL_TABS_STORAGE_PRUNE_FALLBACK_DELAY_MS = 1_500;

function scheduleIdleFixedPanelTabsStoragePrune(): void {
  const run = () => {
    try {
      pruneFixedPanelTabsStorage({ now: Date.now() });
    } catch {}
  };
  if (typeof window === "undefined") {
    return;
  }
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, {
      timeout: FIXED_PANEL_TABS_STORAGE_PRUNE_IDLE_TIMEOUT_MS,
    });
    return;
  }
  window.setTimeout(run, FIXED_PANEL_TABS_STORAGE_PRUNE_FALLBACK_DELAY_MS);
}

export function resetFixedPanelTabsStorageMaintenanceForTest(): void {
  hasScheduledFixedPanelTabsStoragePrune = false;
}

export function useFixedPanelTabsState(
  panelStateId: FixedPanelTabsPanelStateId,
  syncThreadId: FixedPanelTabsSyncThreadId,
): FixedPanelTabsState {
  const stateAtom = getFixedPanelTabsStateAtom(panelStateId);
  const store = useStore();
  const state = useAtomValue(stateAtom);
  const setState = useSetAtom(stateAtom);
  const queryClient = useQueryClient();
  const resolvedThreadId = hasThreadId(syncThreadId) ? syncThreadId : null;
  const tabsQuery = useThreadTabs(resolvedThreadId ?? "", {
    enabled: resolvedThreadId !== null,
  });

  useEffect(() => {
    if (resolvedThreadId === null || tabsQuery.data === undefined) {
      return;
    }
    if (hasPendingThreadTabsWrite(queryClient, resolvedThreadId)) {
      return;
    }
    if (tabsQuery.data.revision === 0 && state.secondary.tabs.length > 0) {
      scheduleLocalThreadTabsMigration({
        queryClient,
        tabs: state.secondary.tabs,
        threadId: resolvedThreadId,
      });
      return;
    }
    const current = store.get(stateAtom);
    const next = ensureOpenFixedPanelHasActiveTab(
      reconcileFixedPanelTabsState(current, tabsQuery.data.tabs),
    );
    if (next !== current) {
      setState(next);
    }
  }, [
    queryClient,
    resolvedThreadId,
    setState,
    state.secondary.tabs,
    stateAtom,
    store,
    tabsQuery.data,
  ]);

  return state;
}

export function useUpdateFixedPanelTabsState(
  panelStateId: FixedPanelTabsPanelStateId,
  syncThreadId: FixedPanelTabsSyncThreadId,
): (update: FixedPanelTabsStateUpdater) => void {
  const stateAtom = getFixedPanelTabsStateAtom(panelStateId);
  const store = useStore();
  const setState = useSetAtom(stateAtom);
  const queryClient = useQueryClient();
  return useCallback(
    (update: FixedPanelTabsStateUpdater) => {
      if (!hasThreadId(panelStateId)) return;
      const now = Date.now();
      const current = store.get(stateAtom);
      const next = ensureOpenFixedPanelHasActiveTab(update(current));
      if (next === current) {
        return;
      }
      const touched = touchFixedPanelTabsState(next, now);
      setState(touched);
      if (
        hasThreadId(syncThreadId) &&
        !areThreadTabListsEquivalent(
          current.secondary.tabs,
          touched.secondary.tabs,
        )
      ) {
        scheduleThreadTabsPersistence({
          tabs: touched.secondary.tabs,
          queryClient,
          threadId: syncThreadId,
        });
      }
    },
    [panelStateId, queryClient, setState, stateAtom, store, syncThreadId],
  );
}

export function useReconciledFixedPanelTabsState({
  fixedTabs,
  isAuthoritative = true,
  openFirstFixedTabWhenEmpty = false,
  panelStateId,
  syncThreadId,
}: {
  fixedTabs: readonly FixedPanelViewTab[];
  isAuthoritative?: boolean;
  openFirstFixedTabWhenEmpty?: boolean;
  panelStateId: FixedPanelTabsPanelStateId;
  syncThreadId: FixedPanelTabsSyncThreadId;
}): FixedPanelTabsState {
  const state = useFixedPanelTabsState(panelStateId, syncThreadId);
  const updateState = useUpdateFixedPanelTabsState(panelStateId, syncThreadId);
  const reconciledState = useMemo(
    () =>
      isAuthoritative
        ? reconcileFixedPanelViewTabsInState({
            fixedTabs,
            openFirstFixedTabWhenEmpty,
            state,
          })
        : state,
    [fixedTabs, isAuthoritative, openFirstFixedTabWhenEmpty, state],
  );

  useLayoutEffect(() => {
    if (!isAuthoritative || reconciledState === state) return;
    updateState((current) =>
      reconcileFixedPanelViewTabsInState({
        fixedTabs,
        openFirstFixedTabWhenEmpty,
        state: current,
      }),
    );
  }, [
    fixedTabs,
    isAuthoritative,
    openFirstFixedTabWhenEmpty,
    reconciledState,
    state,
    updateState,
  ]);

  return reconciledState;
}

export function useTouchFixedPanelTabsState(
  panelStateId: FixedPanelTabsPanelStateId,
  syncThreadId: FixedPanelTabsSyncThreadId,
): () => void {
  const updateState = useUpdateFixedPanelTabsState(panelStateId, syncThreadId);
  const lastTouchRef = useRef<LastFixedPanelTabsTouch | null>(null);
  return useCallback(() => {
    const now = Date.now();
    if (
      lastTouchRef.current !== null &&
      lastTouchRef.current.threadId === panelStateId &&
      now - lastTouchRef.current.touchedAt < FIXED_PANEL_TABS_TOUCH_THROTTLE_MS
    ) {
      return;
    }
    lastTouchRef.current = {
      threadId: panelStateId,
      touchedAt: now,
    };
    updateState((current) => {
      if (!current.secondary.isOpen && current.secondary.tabs.length === 0) {
        return current;
      }
      if (now - current.lastUsedAt < FIXED_PANEL_TABS_TOUCH_THROTTLE_MS) {
        return current;
      }
      return { ...current };
    });
  }, [panelStateId, updateState]);
}

export function useSetFixedSecondaryPanelTab(
  panelStateId: FixedPanelTabsPanelStateId,
  syncThreadId: FixedPanelTabsSyncThreadId,
): FixedPanelSecondaryPanelSetter {
  const updateState = useUpdateFixedPanelTabsState(panelStateId, syncThreadId);
  return useCallback(
    (panel: ThreadSecondaryPanel) => {
      updateState((current) => {
        const tabs = ensureSecondaryPanelTab(current.secondary.tabs, panel);
        const activeTabId = getSecondaryPanelTabId(panel);
        if (
          tabs === current.secondary.tabs &&
          current.secondary.activeTabId === activeTabId &&
          current.secondary.isOpen
        ) {
          return current;
        }
        return {
          ...current,
          secondary: {
            tabs,
            activeTabId,
            isOpen: true,
          },
        };
      });
    },
    [updateState],
  );
}

export function useCloseFixedSecondaryPanel(
  panelStateId: FixedPanelTabsPanelStateId,
  syncThreadId: FixedPanelTabsSyncThreadId,
): FixedPanelSecondaryPanelCloser {
  const updateState = useUpdateFixedPanelTabsState(panelStateId, syncThreadId);
  return useCallback(() => {
    updateState(closeFixedSecondaryPanelState);
  }, [updateState]);
}

export function useOpenFixedSecondaryPanel(
  panelStateId: FixedPanelTabsPanelStateId,
  syncThreadId: FixedPanelTabsSyncThreadId,
): FixedPanelSecondaryPanelOpener {
  const updateState = useUpdateFixedPanelTabsState(panelStateId, syncThreadId);
  return useCallback(() => {
    updateState(openFixedSecondaryPanelState);
  }, [updateState]);
}

export function useActiveFixedRightTerminalId(
  panelStateId: FixedPanelTabsPanelStateId,
  syncThreadId: FixedPanelTabsSyncThreadId,
): string | null {
  const state = useFixedPanelTabsState(panelStateId, syncThreadId);
  return findActiveTerminalTab(state)?.terminalId ?? null;
}

export function useSetFixedRightTerminalActiveTerminal(
  panelStateId: FixedPanelTabsPanelStateId,
  syncThreadId: FixedPanelTabsSyncThreadId,
  target?: TerminalCreateTarget,
): FixedPanelTerminalIdSetter {
  const updateState = useUpdateFixedPanelTabsState(panelStateId, syncThreadId);
  return useCallback(
    (terminalId: string | null) => {
      updateState((current) => {
        if (terminalId === null) {
          const activeTerminalTab = findActiveTerminalTab(current);
          if (activeTerminalTab === null) {
            return current;
          }
          return {
            ...current,
            secondary: {
              ...current.secondary,
              activeTabId: null,
            },
          };
        }

        const tabs = upsertTerminalTab(
          current.secondary.tabs,
          terminalId,
          target,
        );
        const activeTabId = createTerminalFixedPanelTab({
          terminalId,
          target,
        }).id;
        if (
          tabs === current.secondary.tabs &&
          current.secondary.activeTabId === activeTabId &&
          current.secondary.isOpen
        ) {
          return current;
        }
        return {
          ...current,
          secondary: {
            tabs,
            activeTabId,
            isOpen: true,
          },
        };
      });
    },
    [target, updateState],
  );
}

export function useRemoveFixedRightTerminalTab(
  panelStateId: FixedPanelTabsPanelStateId,
  syncThreadId: FixedPanelTabsSyncThreadId,
  onCloseLastTab?: () => void,
): FixedPanelTerminalIdRemover {
  const updateState = useUpdateFixedPanelTabsState(panelStateId, syncThreadId);
  return useCallback(
    (terminalId: string) => {
      let didCloseLastTab = false;
      updateState((current) => {
        const next = removeFixedRightTerminalTabInState(current, terminalId);
        didCloseLastTab =
          next !== current && next.secondary.tabs.length === 0;
        return next;
      });
      if (didCloseLastTab) onCloseLastTab?.();
    },
    [onCloseLastTab, updateState],
  );
}
