import { useCallback, useEffect, useRef } from "react";
import type { ThreadType } from "@bb/domain";
import {
  useFixedPanelTabsState,
  useUpdateFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs";
import {
  areFixedPanelTabsEquivalent,
  createHostFilePreviewFixedPanelTab,
  createThreadStorageFilePreviewFixedPanelTab,
  createWorkspaceFilePreviewFixedPanelTab,
  type FixedPanelTab,
  type FixedPanelTabsState,
  type HostFilePreviewFixedPanelTab,
  type ThreadStorageFilePreviewFixedPanelTab,
  type WorkspaceFilePreviewFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import {
  areEnvironmentFilePreviewSourcesEqual,
  type HostFileTabState,
  type WorkspaceFileTabState,
} from "@/lib/file-preview";
import {
  isManagerStatusStorageFilePath,
  resolvePinnedManagerStorageFilePath,
} from "./managerStorage";

interface UseThreadFileTabsParams {
  threadId: string | null | undefined;
  environmentId: string | null | undefined;
  threadType: ThreadType | undefined;
  storageFiles: readonly { path: string }[] | undefined;
}

interface SetSecondaryTabsArgs {
  activeTabId: string | null;
  isOpen: boolean;
  state: FixedPanelTabsState;
  tabs: readonly FixedPanelTab[];
}

function isWorkspaceFilePreviewTab(
  tab: FixedPanelTab,
): tab is WorkspaceFilePreviewFixedPanelTab {
  return tab.kind === "workspace-file-preview";
}

function isHostFilePreviewTab(
  tab: FixedPanelTab,
): tab is HostFilePreviewFixedPanelTab {
  return tab.kind === "host-file-preview";
}

function isStorageFilePreviewTab(
  tab: FixedPanelTab,
): tab is ThreadStorageFilePreviewFixedPanelTab {
  return tab.kind === "thread-storage-file-preview";
}

function isWorkspaceFilePreviewTabForEnvironment(
  tab: FixedPanelTab,
  environmentId: string | null,
): tab is WorkspaceFilePreviewFixedPanelTab {
  return isWorkspaceFilePreviewTab(tab) && tab.environmentId === environmentId;
}

function getActiveSecondaryTab(
  state: FixedPanelTabsState,
): FixedPanelTab | null {
  const activeTabId = state.secondary.activeTabId;
  if (activeTabId === null) {
    return null;
  }
  return state.secondary.tabs.find((tab) => tab.id === activeTabId) ?? null;
}

function setSecondaryTabs({
  activeTabId,
  isOpen,
  state,
  tabs,
}: SetSecondaryTabsArgs): FixedPanelTabsState {
  if (
    tabs === state.secondary.tabs &&
    activeTabId === state.secondary.activeTabId &&
    isOpen === state.secondary.isOpen
  ) {
    return state;
  }

  return {
    ...state,
    secondary: {
      tabs,
      activeTabId,
      isOpen,
    },
  };
}

function removeMismatchedManagerStatusTabs(
  tabs: readonly FixedPanelTab[],
  pinnedStorageFilePath: string,
): readonly FixedPanelTab[] {
  const nextTabs = tabs.filter(
    (tab) =>
      !isStorageFilePreviewTab(tab) ||
      tab.path === pinnedStorageFilePath ||
      !isManagerStatusStorageFilePath(tab.path),
  );
  return nextTabs.length === tabs.length ? tabs : nextTabs;
}

function upsertSecondaryTab(
  tabs: readonly FixedPanelTab[],
  nextTab: FixedPanelTab,
): readonly FixedPanelTab[] {
  const existingTabIndex = tabs.findIndex((tab) => tab.id === nextTab.id);
  if (existingTabIndex === -1) {
    return [...tabs, nextTab];
  }

  const existingTab = tabs[existingTabIndex];
  if (existingTab && areFixedPanelTabsEquivalent(existingTab, nextTab)) {
    return tabs;
  }

  return tabs.map((tab) => (tab.id === nextTab.id ? nextTab : tab));
}

function removeSecondaryTab(
  tabs: readonly FixedPanelTab[],
  tabId: string,
): readonly FixedPanelTab[] {
  const nextTabs = tabs.filter((tab) => tab.id !== tabId);
  return nextTabs.length === tabs.length ? tabs : nextTabs;
}

function removeWorkspaceTabsForOtherEnvironments(
  tabs: readonly FixedPanelTab[],
  environmentId: string | null,
): readonly FixedPanelTab[] {
  const nextTabs = tabs.filter(
    (tab) =>
      !isWorkspaceFilePreviewTab(tab) || tab.environmentId === environmentId,
  );
  return nextTabs.length === tabs.length ? tabs : nextTabs;
}

function removeStorageTabs(
  tabs: readonly FixedPanelTab[],
): readonly FixedPanelTab[] {
  const nextTabs = tabs.filter((tab) => !isStorageFilePreviewTab(tab));
  return nextTabs.length === tabs.length ? tabs : nextTabs;
}

function pruneStorageTabs(
  tabs: readonly FixedPanelTab[],
  knownPaths: ReadonlySet<string>,
): readonly FixedPanelTab[] {
  const nextTabs = tabs.filter(
    (tab) => !isStorageFilePreviewTab(tab) || knownPaths.has(tab.path),
  );
  return nextTabs.length === tabs.length ? tabs : nextTabs;
}

function isActiveTabStillOpen(
  tabs: readonly FixedPanelTab[],
  activeTabId: string | null,
): boolean {
  return activeTabId !== null && tabs.some((tab) => tab.id === activeTabId);
}

function createStorageTab(
  path: string,
  pinnedStorageFilePath: string,
): ThreadStorageFilePreviewFixedPanelTab {
  return createThreadStorageFilePreviewFixedPanelTab({
    isPinned: path === pinnedStorageFilePath,
    path,
  });
}

function getManagerDefaultActiveTabId(
  tabs: readonly FixedPanelTab[],
  pinnedStorageFilePath: string,
): string {
  const pinnedTab = findStorageFileTab(tabs, pinnedStorageFilePath);
  return (
    pinnedTab?.id ??
    createStorageTab(pinnedStorageFilePath, pinnedStorageFilePath).id
  );
}

function findWorkspaceTab(
  tabs: readonly FixedPanelTab[],
  path: string,
): WorkspaceFilePreviewFixedPanelTab | null {
  for (const tab of tabs) {
    if (isWorkspaceFilePreviewTab(tab) && tab.path === path) {
      return tab;
    }
  }
  return null;
}

function findHostFileTab(
  tabs: readonly FixedPanelTab[],
  path: string,
): HostFilePreviewFixedPanelTab | null {
  for (const tab of tabs) {
    if (isHostFilePreviewTab(tab) && tab.path === path) {
      return tab;
    }
  }
  return null;
}

function findStorageFileTab(
  tabs: readonly FixedPanelTab[],
  path: string,
): ThreadStorageFilePreviewFixedPanelTab | null {
  for (const tab of tabs) {
    if (isStorageFilePreviewTab(tab) && tab.path === path) {
      return tab;
    }
  }
  return null;
}

function toWorkspaceFileTabState(
  tab: WorkspaceFilePreviewFixedPanelTab,
): WorkspaceFileTabState {
  return {
    lineNumber: tab.lineNumber,
    path: tab.path,
    source: tab.source,
    statusLabel: tab.statusLabel,
  };
}

function toHostFileTabState(
  tab: HostFilePreviewFixedPanelTab,
): HostFileTabState {
  return {
    lineNumber: tab.lineNumber,
    path: tab.path,
  };
}

function orderStorageTabs(
  tabs: readonly ThreadStorageFilePreviewFixedPanelTab[],
): readonly ThreadStorageFilePreviewFixedPanelTab[] {
  const pinnedTabs = tabs.filter((tab) => tab.isPinned);
  const unpinnedTabs = tabs.filter((tab) => !tab.isPinned);
  return [...pinnedTabs, ...unpinnedTabs];
}

export function useThreadFileTabs({
  threadId,
  environmentId,
  threadType,
  storageFiles,
}: UseThreadFileTabsParams) {
  const fixedPanelTabsState = useFixedPanelTabsState(threadId);
  const updateFixedPanelTabsState = useUpdateFixedPanelTabsState(threadId);
  const isThreadResolved = threadType !== undefined;
  const isManagerThread = threadType === "manager";
  const pinnedStorageFilePath =
    resolvePinnedManagerStorageFilePath(storageFiles);
  const resolvedEnvironmentId = isThreadResolved
    ? (environmentId ?? null)
    : undefined;

  useEffect(() => {
    if (resolvedEnvironmentId === undefined) return;
    updateFixedPanelTabsState((state) => {
      const tabs = removeWorkspaceTabsForOtherEnvironments(
        state.secondary.tabs,
        resolvedEnvironmentId,
      );
      const activeTabId = isActiveTabStillOpen(
        tabs,
        state.secondary.activeTabId,
      )
        ? state.secondary.activeTabId
        : null;
      return setSecondaryTabs({
        activeTabId,
        isOpen: state.secondary.isOpen,
        state,
        tabs,
      });
    });
  }, [resolvedEnvironmentId, updateFixedPanelTabsState]);

  useEffect(() => {
    if (!isThreadResolved) return;
    if (isManagerThread) {
      return;
    }
    updateFixedPanelTabsState((state) => {
      const tabs = removeStorageTabs(state.secondary.tabs);
      const activeTabId = isActiveTabStillOpen(
        tabs,
        state.secondary.activeTabId,
      )
        ? state.secondary.activeTabId
        : null;
      return setSecondaryTabs({
        activeTabId,
        isOpen: state.secondary.isOpen,
        state,
        tabs,
      });
    });
  }, [isManagerThread, isThreadResolved, updateFixedPanelTabsState]);

  const lastAppliedPinnedStorageFilePath = useRef<string | null>(null);
  useEffect(() => {
    if (!isManagerThread) {
      lastAppliedPinnedStorageFilePath.current = null;
      return;
    }
    const pinnedPathChanged =
      lastAppliedPinnedStorageFilePath.current !== pinnedStorageFilePath;
    lastAppliedPinnedStorageFilePath.current = pinnedStorageFilePath;
    updateFixedPanelTabsState((state) => {
      const pinnedTab = createStorageTab(
        pinnedStorageFilePath,
        pinnedStorageFilePath,
      );
      const baseTabs = pinnedPathChanged
        ? removeMismatchedManagerStatusTabs(
            state.secondary.tabs,
            pinnedStorageFilePath,
          )
        : state.secondary.tabs;
      const tabs = upsertSecondaryTab(baseTabs, pinnedTab);
      const activeTabId = isActiveTabStillOpen(
        tabs,
        state.secondary.activeTabId,
      )
        ? state.secondary.activeTabId
        : pinnedTab.id;
      return setSecondaryTabs({
        activeTabId,
        isOpen: state.secondary.isOpen,
        state,
        tabs,
      });
    });
  }, [
    fixedPanelTabsState.secondary.activeTabId,
    isManagerThread,
    pinnedStorageFilePath,
    updateFixedPanelTabsState,
  ]);

  useEffect(() => {
    if (!isThreadResolved || !storageFiles) return;
    if (!isManagerThread) return;
    updateFixedPanelTabsState((state) => {
      const knownPaths = new Set([
        pinnedStorageFilePath,
        ...storageFiles.map((file) => file.path),
      ]);
      const tabs = pruneStorageTabs(state.secondary.tabs, knownPaths);
      const activeTabId = isActiveTabStillOpen(
        tabs,
        state.secondary.activeTabId,
      )
        ? state.secondary.activeTabId
        : getManagerDefaultActiveTabId(tabs, pinnedStorageFilePath);
      return setSecondaryTabs({
        activeTabId,
        isOpen: state.secondary.isOpen,
        state,
        tabs,
      });
    });
  }, [
    isManagerThread,
    isThreadResolved,
    pinnedStorageFilePath,
    storageFiles,
    updateFixedPanelTabsState,
  ]);

  const openWorkspaceFile = useCallback(
    ({ lineNumber, path, source, statusLabel }: WorkspaceFileTabState) => {
      if (resolvedEnvironmentId === undefined) return;
      const nextTab = createWorkspaceFilePreviewFixedPanelTab({
        environmentId: resolvedEnvironmentId,
        tab: {
          lineNumber,
          path,
          source,
          statusLabel,
        },
      });
      updateFixedPanelTabsState((state) => {
        const existingTab = findWorkspaceTab(state.secondary.tabs, path);
        const tabs = upsertSecondaryTab(state.secondary.tabs, nextTab);
        if (
          existingTab &&
          existingTab.environmentId === resolvedEnvironmentId &&
          existingTab.lineNumber === lineNumber &&
          areEnvironmentFilePreviewSourcesEqual(existingTab.source, source) &&
          existingTab.statusLabel === statusLabel &&
          state.secondary.activeTabId === nextTab.id &&
          state.secondary.isOpen
        ) {
          return state;
        }
        return setSecondaryTabs({
          activeTabId: nextTab.id,
          isOpen: true,
          state,
          tabs,
        });
      });
    },
    [resolvedEnvironmentId, updateFixedPanelTabsState],
  );

  const closeWorkspaceFileTab = useCallback(
    (path: string) => {
      updateFixedPanelTabsState((state) => {
        const tab = findWorkspaceTab(state.secondary.tabs, path);
        if (!tab) {
          return state;
        }
        const tabs = removeSecondaryTab(state.secondary.tabs, tab.id);
        return setSecondaryTabs({
          activeTabId:
            state.secondary.activeTabId === tab.id
              ? null
              : state.secondary.activeTabId,
          isOpen: state.secondary.isOpen,
          state,
          tabs,
        });
      });
    },
    [updateFixedPanelTabsState],
  );

  const activateWorkspaceFileTab = useCallback(
    (path: string) => {
      updateFixedPanelTabsState((state) => {
        const tab = findWorkspaceTab(state.secondary.tabs, path);
        if (!tab) {
          return state;
        }
        if (state.secondary.activeTabId === tab.id && state.secondary.isOpen) {
          return state;
        }
        return setSecondaryTabs({
          activeTabId: tab.id,
          isOpen: true,
          state,
          tabs: state.secondary.tabs,
        });
      });
    },
    [updateFixedPanelTabsState],
  );

  const openStorageFile = useCallback(
    (path: string) => {
      if (!isManagerThread) return;
      const nextTab = createStorageTab(path, pinnedStorageFilePath);
      updateFixedPanelTabsState((state) => {
        const tabs = upsertSecondaryTab(state.secondary.tabs, nextTab);
        if (
          tabs === state.secondary.tabs &&
          state.secondary.activeTabId === nextTab.id &&
          state.secondary.isOpen
        ) {
          return state;
        }
        return setSecondaryTabs({
          activeTabId: nextTab.id,
          isOpen: true,
          state,
          tabs,
        });
      });
    },
    [isManagerThread, pinnedStorageFilePath, updateFixedPanelTabsState],
  );

  const openHostFile = useCallback(
    ({ lineNumber, path }: HostFileTabState) => {
      if (!threadId) return;
      const nextTab = createHostFilePreviewFixedPanelTab({
        lineNumber,
        path,
      });
      updateFixedPanelTabsState((state) => {
        const existingTab = findHostFileTab(state.secondary.tabs, path);
        const tabs = upsertSecondaryTab(state.secondary.tabs, nextTab);
        if (
          existingTab &&
          existingTab.lineNumber === lineNumber &&
          state.secondary.activeTabId === nextTab.id &&
          state.secondary.isOpen
        ) {
          return state;
        }
        return setSecondaryTabs({
          activeTabId: nextTab.id,
          isOpen: true,
          state,
          tabs,
        });
      });
    },
    [threadId, updateFixedPanelTabsState],
  );

  const closeHostFileTab = useCallback(
    (path: string) => {
      updateFixedPanelTabsState((state) => {
        const tab = findHostFileTab(state.secondary.tabs, path);
        if (!tab) {
          return state;
        }
        const tabs = removeSecondaryTab(state.secondary.tabs, tab.id);
        return setSecondaryTabs({
          activeTabId:
            state.secondary.activeTabId === tab.id
              ? null
              : state.secondary.activeTabId,
          isOpen: state.secondary.isOpen,
          state,
          tabs,
        });
      });
    },
    [updateFixedPanelTabsState],
  );

  const activateHostFileTab = useCallback(
    (path: string) => {
      updateFixedPanelTabsState((state) => {
        const tab = findHostFileTab(state.secondary.tabs, path);
        if (!tab) {
          return state;
        }
        if (state.secondary.activeTabId === tab.id && state.secondary.isOpen) {
          return state;
        }
        return setSecondaryTabs({
          activeTabId: tab.id,
          isOpen: true,
          state,
          tabs: state.secondary.tabs,
        });
      });
    },
    [updateFixedPanelTabsState],
  );

  const closeStorageFileTab = useCallback(
    (path: string) => {
      if (!isManagerThread || path === pinnedStorageFilePath) return;
      updateFixedPanelTabsState((state) => {
        const tab = findStorageFileTab(state.secondary.tabs, path);
        if (!tab) {
          return state;
        }
        const tabs = removeSecondaryTab(state.secondary.tabs, tab.id);
        return setSecondaryTabs({
          activeTabId:
            state.secondary.activeTabId === tab.id
              ? null
              : state.secondary.activeTabId,
          isOpen: state.secondary.isOpen,
          state,
          tabs,
        });
      });
    },
    [isManagerThread, pinnedStorageFilePath, updateFixedPanelTabsState],
  );

  const activateStorageFileTab = useCallback(
    (path: string) => {
      if (!isManagerThread) return;
      updateFixedPanelTabsState((state) => {
        const tab = findStorageFileTab(state.secondary.tabs, path);
        if (!tab) {
          return state;
        }
        if (state.secondary.activeTabId === tab.id && state.secondary.isOpen) {
          return state;
        }
        return setSecondaryTabs({
          activeTabId: tab.id,
          isOpen: true,
          state,
          tabs: state.secondary.tabs,
        });
      });
    },
    [isManagerThread, updateFixedPanelTabsState],
  );

  const clearActiveFileTabs = useCallback(() => {
    updateFixedPanelTabsState((state) => {
      const activeTab = getActiveSecondaryTab(state);
      if (
        !activeTab ||
        (activeTab.kind !== "workspace-file-preview" &&
          activeTab.kind !== "host-file-preview" &&
          activeTab.kind !== "thread-storage-file-preview")
      ) {
        return state;
      }
      return setSecondaryTabs({
        activeTabId: null,
        isOpen: state.secondary.isOpen,
        state,
        tabs: state.secondary.tabs,
      });
    });
  }, [updateFixedPanelTabsState]);

  const activeTab = getActiveSecondaryTab(fixedPanelTabsState);
  const workspaceTabs =
    resolvedEnvironmentId === undefined
      ? []
      : fixedPanelTabsState.secondary.tabs.filter((tab) =>
          isWorkspaceFilePreviewTabForEnvironment(tab, resolvedEnvironmentId),
        );
  const activeWorkspaceFileTab =
    activeTab?.kind === "workspace-file-preview" &&
    activeTab.environmentId === resolvedEnvironmentId
      ? activeTab
      : null;
  const activeStorageFileTab =
    isManagerThread && activeTab?.kind === "thread-storage-file-preview"
      ? activeTab
      : null;
  const activeHostFileTab =
    activeTab?.kind === "host-file-preview" ? activeTab : null;
  const storageTabs = isManagerThread
    ? orderStorageTabs(
        fixedPanelTabsState.secondary.tabs.filter(isStorageFilePreviewTab),
      )
    : [];

  return {
    activateHostFileTab,
    activateStorageFileTab,
    activateWorkspaceFileTab,
    activeHostFileLineNumber: activeHostFileTab?.lineNumber ?? null,
    activeHostFilePath: activeHostFileTab?.path ?? null,
    activeStorageFilePath: activeStorageFileTab?.path ?? null,
    activeWorkspaceFileLineNumber: activeWorkspaceFileTab?.lineNumber ?? null,
    activeWorkspaceFilePath: activeWorkspaceFileTab?.path ?? null,
    activeWorkspaceFileSource: activeWorkspaceFileTab?.source ?? null,
    activeWorkspaceFileStatusLabel: activeWorkspaceFileTab?.statusLabel ?? null,
    clearActiveFileTabs,
    closeHostFileTab,
    closeStorageFileTab,
    closeWorkspaceFileTab,
    openHostFile,
    openHostFileTabs: fixedPanelTabsState.secondary.tabs
      .filter(isHostFilePreviewTab)
      .map(toHostFileTabState),
    openStorageFile,
    openStorageFilePaths: storageTabs.map((tab) => tab.path),
    openWorkspaceFile,
    openWorkspaceFileTabs: workspaceTabs.map(toWorkspaceFileTabState),
    pinnedStorageFilePath,
  };
}
