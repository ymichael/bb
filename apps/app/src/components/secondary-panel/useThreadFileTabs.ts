import { useCallback, useEffect } from "react";
import type { ThreadType } from "@bb/domain";
import {
  useSetThreadSecondaryPanel,
  useThreadSecondaryPanelState,
  useUpdateThreadSecondaryPanelState,
} from "@/lib/thread-secondary-panel";
import { areEnvironmentFilePreviewSourcesEqual } from "@/lib/file-preview";
import {
  clearActiveFileTab,
  clearWorkspaceTabsForEnvironment,
  getActiveHostFileTab,
  getActiveStorageFilePath,
  getActiveWorkspaceFileTab,
  normalizeThreadSecondaryPanelState,
  pruneStorageFileTabs,
  type HostFileTabState,
  type ThreadSecondaryPanelFileTabRef,
  type ThreadSecondaryPanelFileTabsState,
  type ThreadSecondaryPanelState,
  type WorkspaceFileTabState,
} from "@/lib/thread-secondary-panel-state";
import { PINNED_STORAGE_FILE_PATH } from "./managerStorage";

interface UseThreadFileTabsParams {
  threadId: string | null | undefined;
  environmentId: string | null | undefined;
  threadType: ThreadType | undefined;
  storageFiles: readonly { path: string }[] | undefined;
}

function upsertWorkspaceFileTab(
  tabs: readonly WorkspaceFileTabState[],
  nextTab: WorkspaceFileTabState,
): readonly WorkspaceFileTabState[] {
  const existingTab = tabs.find((tab) => tab.path === nextTab.path);
  if (!existingTab) {
    return [...tabs, nextTab];
  }
  if (
    existingTab.lineNumber === nextTab.lineNumber &&
    areEnvironmentFilePreviewSourcesEqual(existingTab.source, nextTab.source) &&
    existingTab.statusLabel === nextTab.statusLabel
  ) {
    return tabs;
  }
  return tabs.map((tab) => (tab.path === nextTab.path ? nextTab : tab));
}

function removeWorkspaceFileTab(
  tabs: readonly WorkspaceFileTabState[],
  path: string,
): readonly WorkspaceFileTabState[] {
  const nextTabs = tabs.filter((tab) => tab.path !== path);
  return nextTabs.length === tabs.length ? tabs : nextTabs;
}

function removeStorageFileTab(
  tabs: readonly string[],
  path: string,
): readonly string[] {
  const nextTabs = tabs.filter((openPath) => openPath !== path);
  return nextTabs.length === tabs.length ? tabs : nextTabs;
}

function upsertHostFileTab(
  tabs: readonly HostFileTabState[],
  nextTab: HostFileTabState,
): readonly HostFileTabState[] {
  const existingTab = tabs.find((tab) => tab.path === nextTab.path);
  if (!existingTab) {
    return [...tabs, nextTab];
  }
  if (existingTab.lineNumber === nextTab.lineNumber) {
    return tabs;
  }
  return tabs.map((tab) => (tab.path === nextTab.path ? nextTab : tab));
}

function removeHostFileTab(
  tabs: readonly HostFileTabState[],
  path: string,
): readonly HostFileTabState[] {
  const nextTabs = tabs.filter((tab) => tab.path !== path);
  return nextTabs.length === tabs.length ? tabs : nextTabs;
}

function buildActiveWorkspaceFileTab(
  path: string,
): ThreadSecondaryPanelFileTabRef {
  return {
    type: "workspace",
    path,
  };
}

function buildActiveStorageFileTab(
  path: string,
): ThreadSecondaryPanelFileTabRef {
  return {
    type: "storage",
    path,
  };
}

function buildActiveHostFileTab(path: string): ThreadSecondaryPanelFileTabRef {
  return {
    type: "host-file",
    path,
  };
}

function setFileTabs(
  state: ThreadSecondaryPanelState,
  fileTabs: ThreadSecondaryPanelFileTabsState,
): ThreadSecondaryPanelState {
  return {
    ...state,
    fileTabs,
  };
}

export function useThreadFileTabs({
  threadId,
  environmentId,
  threadType,
  storageFiles,
}: UseThreadFileTabsParams) {
  const panelState = useThreadSecondaryPanelState(threadId);
  const updatePanelState = useUpdateThreadSecondaryPanelState(threadId);
  const setSecondaryPanel = useSetThreadSecondaryPanel(threadId);
  const isThreadResolved = threadType !== undefined;
  const isManagerThread = threadType === "manager";
  const resolvedEnvironmentId = isThreadResolved
    ? (environmentId ?? null)
    : undefined;

  useEffect(() => {
    if (!isThreadResolved) return;
    updatePanelState((state) =>
      normalizeThreadSecondaryPanelState({ isManagerThread, state }),
    );
  }, [isManagerThread, isThreadResolved, updatePanelState]);

  useEffect(() => {
    if (!isThreadResolved) return;
    updatePanelState((state) =>
      clearWorkspaceTabsForEnvironment({
        environmentId: resolvedEnvironmentId,
        state,
      }),
    );
  }, [isThreadResolved, resolvedEnvironmentId, updatePanelState]);

  useEffect(() => {
    if (!isManagerThread) return;
    updatePanelState((state) => {
      const normalizedState = normalizeThreadSecondaryPanelState({
        isManagerThread,
        state,
      });
      if (
        normalizedState.fileTabs.storage[0] === PINNED_STORAGE_FILE_PATH &&
        normalizedState.fileTabs.active !== null
      ) {
        return normalizedState;
      }
      const storageWithoutPinned = normalizedState.fileTabs.storage.filter(
        (path) => path !== PINNED_STORAGE_FILE_PATH,
      );
      const storage = [PINNED_STORAGE_FILE_PATH, ...storageWithoutPinned];
      return setFileTabs(normalizedState, {
        ...normalizedState.fileTabs,
        storage,
        active:
          normalizedState.fileTabs.active ??
          buildActiveStorageFileTab(PINNED_STORAGE_FILE_PATH),
      });
    });
  }, [isManagerThread, updatePanelState]);

  useEffect(() => {
    if (!isThreadResolved || !storageFiles) return;
    updatePanelState((state) =>
      pruneStorageFileTabs({
        isManagerThread,
        pinnedStorageFilePath: PINNED_STORAGE_FILE_PATH,
        state,
        storageFiles,
      }),
    );
  }, [isManagerThread, isThreadResolved, storageFiles, updatePanelState]);

  const openWorkspaceFile = useCallback(
    ({ lineNumber, path, source, statusLabel }: WorkspaceFileTabState) => {
      if (resolvedEnvironmentId === undefined) return;
      updatePanelState((state) => {
        const workspace = upsertWorkspaceFileTab(state.fileTabs.workspace, {
          lineNumber,
          path,
          source,
          statusLabel,
        });
        const isAlreadyActive =
          state.fileTabs.active?.type === "workspace" &&
          state.fileTabs.active.path === path;
        if (
          state.environmentId === resolvedEnvironmentId &&
          workspace === state.fileTabs.workspace &&
          isAlreadyActive
        ) {
          return state;
        }
        return setFileTabs(
          {
            ...state,
            environmentId: resolvedEnvironmentId,
          },
          {
            ...state.fileTabs,
            workspace,
            active: buildActiveWorkspaceFileTab(path),
          },
        );
      });
      setSecondaryPanel("thread-info");
    },
    [resolvedEnvironmentId, setSecondaryPanel, updatePanelState],
  );

  const closeWorkspaceFileTab = useCallback(
    (path: string) => {
      updatePanelState((state) => {
        const workspace = removeWorkspaceFileTab(
          state.fileTabs.workspace,
          path,
        );
        if (workspace === state.fileTabs.workspace) {
          return state;
        }
        return setFileTabs(state, {
          ...state.fileTabs,
          workspace,
          active:
            state.fileTabs.active?.type === "workspace" &&
            state.fileTabs.active.path === path
              ? null
              : state.fileTabs.active,
        });
      });
    },
    [updatePanelState],
  );

  const activateWorkspaceFileTab = useCallback(
    (path: string) => {
      updatePanelState((state) => {
        if (
          !state.fileTabs.workspace.some((tab) => tab.path === path) ||
          (state.fileTabs.active?.type === "workspace" &&
            state.fileTabs.active.path === path)
        ) {
          return state;
        }
        return setFileTabs(state, {
          ...state.fileTabs,
          active: buildActiveWorkspaceFileTab(path),
        });
      });
    },
    [updatePanelState],
  );

  const openStorageFile = useCallback(
    (path: string) => {
      if (!isManagerThread) return;
      updatePanelState((state) => {
        const storage = state.fileTabs.storage.includes(path)
          ? state.fileTabs.storage
          : [...state.fileTabs.storage, path];
        if (
          storage === state.fileTabs.storage &&
          state.fileTabs.active?.type === "storage" &&
          state.fileTabs.active.path === path
        ) {
          return state;
        }
        return setFileTabs(state, {
          ...state.fileTabs,
          storage,
          active: buildActiveStorageFileTab(path),
        });
      });
    },
    [isManagerThread, updatePanelState],
  );

  const openHostFile = useCallback(
    ({ lineNumber, path }: HostFileTabState) => {
      if (!threadId) return;
      updatePanelState((state) => {
        const hostFiles = upsertHostFileTab(state.fileTabs.hostFiles, {
          lineNumber,
          path,
        });
        const isAlreadyActive =
          state.fileTabs.active?.type === "host-file" &&
          state.fileTabs.active.path === path;
        if (hostFiles === state.fileTabs.hostFiles && isAlreadyActive) {
          return state;
        }
        return setFileTabs(state, {
          ...state.fileTabs,
          hostFiles,
          active: buildActiveHostFileTab(path),
        });
      });
      setSecondaryPanel("thread-info");
    },
    [setSecondaryPanel, threadId, updatePanelState],
  );

  const closeHostFileTab = useCallback(
    (path: string) => {
      updatePanelState((state) => {
        const hostFiles = removeHostFileTab(state.fileTabs.hostFiles, path);
        if (hostFiles === state.fileTabs.hostFiles) {
          return state;
        }
        return setFileTabs(state, {
          ...state.fileTabs,
          hostFiles,
          active:
            state.fileTabs.active?.type === "host-file" &&
            state.fileTabs.active.path === path
              ? null
              : state.fileTabs.active,
        });
      });
    },
    [updatePanelState],
  );

  const activateHostFileTab = useCallback(
    (path: string) => {
      updatePanelState((state) => {
        if (
          !state.fileTabs.hostFiles.some((tab) => tab.path === path) ||
          (state.fileTabs.active?.type === "host-file" &&
            state.fileTabs.active.path === path)
        ) {
          return state;
        }
        return setFileTabs(state, {
          ...state.fileTabs,
          active: buildActiveHostFileTab(path),
        });
      });
    },
    [updatePanelState],
  );

  const closeStorageFileTab = useCallback(
    (path: string) => {
      if (!isManagerThread || path === PINNED_STORAGE_FILE_PATH) return;
      updatePanelState((state) => {
        const storage = removeStorageFileTab(state.fileTabs.storage, path);
        if (storage === state.fileTabs.storage) {
          return state;
        }
        return setFileTabs(state, {
          ...state.fileTabs,
          storage,
          active:
            state.fileTabs.active?.type === "storage" &&
            state.fileTabs.active.path === path
              ? null
              : state.fileTabs.active,
        });
      });
    },
    [isManagerThread, updatePanelState],
  );

  const activateStorageFileTab = useCallback(
    (path: string) => {
      if (!isManagerThread) return;
      updatePanelState((state) => {
        if (
          !state.fileTabs.storage.includes(path) ||
          (state.fileTabs.active?.type === "storage" &&
            state.fileTabs.active.path === path)
        ) {
          return state;
        }
        return setFileTabs(state, {
          ...state.fileTabs,
          active: buildActiveStorageFileTab(path),
        });
      });
    },
    [isManagerThread, updatePanelState],
  );

  const clearActiveFileTabs = useCallback(() => {
    updatePanelState(clearActiveFileTab);
  }, [updatePanelState]);

  const workspaceEnvironmentMatches =
    resolvedEnvironmentId !== undefined &&
    panelState.environmentId === resolvedEnvironmentId;
  const visibleWorkspaceFileTabs = workspaceEnvironmentMatches
    ? panelState.fileTabs.workspace
    : [];
  const activeWorkspaceFileTab = workspaceEnvironmentMatches
    ? getActiveWorkspaceFileTab(panelState)
    : null;
  const activeStorageFilePath = isManagerThread
    ? getActiveStorageFilePath(panelState)
    : null;
  const activeHostFileTab = getActiveHostFileTab(panelState);
  const openStorageFilePaths = isManagerThread
    ? panelState.fileTabs.storage
    : [];

  return {
    activateHostFileTab,
    activateStorageFileTab,
    activateWorkspaceFileTab,
    activeHostFileLineNumber: activeHostFileTab?.lineNumber ?? null,
    activeHostFilePath: activeHostFileTab?.path ?? null,
    activeStorageFilePath,
    activeWorkspaceFileLineNumber: activeWorkspaceFileTab?.lineNumber ?? null,
    activeWorkspaceFilePath: activeWorkspaceFileTab?.path ?? null,
    activeWorkspaceFileSource: activeWorkspaceFileTab?.source ?? null,
    activeWorkspaceFileStatusLabel: activeWorkspaceFileTab?.statusLabel ?? null,
    clearActiveFileTabs,
    closeHostFileTab,
    closeStorageFileTab,
    closeWorkspaceFileTab,
    openHostFile,
    openHostFileTabs: panelState.fileTabs.hostFiles,
    openStorageFile,
    openStorageFilePaths,
    openWorkspaceFile,
    openWorkspaceFileTabs: visibleWorkspaceFileTabs,
  };
}
