import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  HostFileTabState,
  ThreadStorageFileTabState,
  WorkspaceFileTabState,
} from "@bb/client-core";
import type { ThreadSecondaryPanel } from "@/lib/thread-secondary-panel";
import type { FileOpenerOverride } from "@/lib/plugin-slot-resolvers";

type ThreadSecondaryPanelThreadId = string | undefined;

type ThreadSecondaryPanelOpenHandler = (panel: ThreadSecondaryPanel) => void;
type ThreadSecondaryPanelDiffFileOpenHandler = (path: string) => void;
type ThreadSecondaryPanelCommitDiffOpenHandler = (sha: string) => void;
export interface ThreadSecondaryPanelFileOpenOptions {
  viewer?: FileOpenerOverride;
}
export type ThreadSecondaryPanelWorkspaceFileOpenHandler = (
  file: WorkspaceFileTabState,
  options?: ThreadSecondaryPanelFileOpenOptions,
) => void;
export type ThreadSecondaryPanelStorageFileOpenHandler = (
  file: ThreadStorageFileTabState,
  options?: ThreadSecondaryPanelFileOpenOptions,
) => void;
export type ThreadSecondaryPanelHostFileOpenHandler = (
  file: HostFileTabState,
  options?: ThreadSecondaryPanelFileOpenOptions,
) => void;

export interface UseThreadSecondaryPanelVisibilityArgs {
  closePersistedPanel: () => void;
  drawerVisibility: ThreadSecondaryPanelDrawerVisibility;
  isCompactViewport: boolean;
  isPersistedOpen: boolean;
  openPersistedCommitDiff: ThreadSecondaryPanelCommitDiffOpenHandler;
  openPersistedDiffFile: ThreadSecondaryPanelDiffFileOpenHandler;
  openPersistedDiffPanel: () => void;
  openPersistedHostFile: ThreadSecondaryPanelHostFileOpenHandler;
  openPersistedPanel: ThreadSecondaryPanelOpenHandler;
  openPersistedStorageFile: ThreadSecondaryPanelStorageFileOpenHandler;
  openPersistedWorkspaceFile: ThreadSecondaryPanelWorkspaceFileOpenHandler;
  togglePersistedPanel: () => void;
}

interface UseThreadSecondaryPanelDrawerVisibilityArgs {
  isCompactViewport: boolean;
  threadId: ThreadSecondaryPanelThreadId;
}

interface ThreadSecondaryPanelDrawerVisibility {
  closeDrawer: () => void;
  isDrawerVisible: boolean;
  openDrawer: () => void;
  toggleDrawer: () => void;
}

interface ThreadSecondaryPanelVisibility {
  closePanel: () => void;
  isOpen: boolean;
  openCommitDiff: ThreadSecondaryPanelCommitDiffOpenHandler;
  openCompactDrawer: () => void;
  openDiffFile: ThreadSecondaryPanelDiffFileOpenHandler;
  openDiffPanel: () => void;
  openHostFile: ThreadSecondaryPanelHostFileOpenHandler;
  openPanel: ThreadSecondaryPanelOpenHandler;
  openStorageFile: ThreadSecondaryPanelStorageFileOpenHandler;
  openWorkspaceFile: ThreadSecondaryPanelWorkspaceFileOpenHandler;
  togglePanel: () => void;
}

function hasThreadId(
  threadId: ThreadSecondaryPanelThreadId,
): threadId is string {
  return threadId !== undefined && threadId.length > 0;
}

export function useThreadSecondaryPanelDrawerVisibility({
  isCompactViewport,
  threadId,
}: UseThreadSecondaryPanelDrawerVisibilityArgs): ThreadSecondaryPanelDrawerVisibility {
  const [openDrawerThreadId, setOpenDrawerThreadId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    setOpenDrawerThreadId(null);
  }, [threadId]);

  useEffect(() => {
    if (!isCompactViewport) {
      setOpenDrawerThreadId(null);
    }
  }, [isCompactViewport]);

  const openDrawerForCurrentThread = useCallback(() => {
    if (!hasThreadId(threadId)) {
      return;
    }
    setOpenDrawerThreadId(threadId);
  }, [threadId]);

  const closeDrawerForCurrentThread = useCallback(() => {
    setOpenDrawerThreadId((currentThreadId) =>
      currentThreadId === threadId ? null : currentThreadId,
    );
  }, [threadId]);

  const openDrawer = useCallback(() => {
    if (!isCompactViewport) {
      return;
    }
    openDrawerForCurrentThread();
  }, [isCompactViewport, openDrawerForCurrentThread]);

  const isDrawerVisible =
    isCompactViewport &&
    hasThreadId(threadId) &&
    openDrawerThreadId === threadId;

  const toggleDrawer = useCallback(() => {
    if (!isCompactViewport) {
      return;
    }
    if (isDrawerVisible) {
      closeDrawerForCurrentThread();
      return;
    }
    openDrawerForCurrentThread();
  }, [
    closeDrawerForCurrentThread,
    isCompactViewport,
    isDrawerVisible,
    openDrawerForCurrentThread,
  ]);

  return useMemo(
    () => ({
      closeDrawer: closeDrawerForCurrentThread,
      isDrawerVisible,
      openDrawer,
      toggleDrawer,
    }),
    [closeDrawerForCurrentThread, isDrawerVisible, openDrawer, toggleDrawer],
  );
}

export function useThreadSecondaryPanelVisibility({
  closePersistedPanel,
  drawerVisibility,
  isCompactViewport,
  isPersistedOpen,
  openPersistedCommitDiff,
  openPersistedDiffFile,
  openPersistedDiffPanel,
  openPersistedHostFile,
  openPersistedPanel,
  openPersistedStorageFile,
  openPersistedWorkspaceFile,
  togglePersistedPanel,
}: UseThreadSecondaryPanelVisibilityArgs): ThreadSecondaryPanelVisibility {
  const {
    closeDrawer,
    isDrawerVisible,
    openDrawer: openCompactDrawer,
    toggleDrawer,
  } = drawerVisibility;
  const isOpen = isCompactViewport ? isDrawerVisible : isPersistedOpen;

  const openPanel = useCallback<ThreadSecondaryPanelOpenHandler>(
    (panel) => {
      openPersistedPanel(panel);
      openCompactDrawer();
    },
    [openCompactDrawer, openPersistedPanel],
  );

  const openDiffPanel = useCallback(() => {
    openPersistedDiffPanel();
    openCompactDrawer();
  }, [openCompactDrawer, openPersistedDiffPanel]);

  const openDiffFile = useCallback<ThreadSecondaryPanelDiffFileOpenHandler>(
    (path) => {
      openPersistedDiffFile(path);
      openCompactDrawer();
    },
    [openCompactDrawer, openPersistedDiffFile],
  );

  const openCommitDiff = useCallback<ThreadSecondaryPanelCommitDiffOpenHandler>(
    (sha) => {
      openPersistedCommitDiff(sha);
      openCompactDrawer();
    },
    [openCompactDrawer, openPersistedCommitDiff],
  );

  const openWorkspaceFile =
    useCallback<ThreadSecondaryPanelWorkspaceFileOpenHandler>(
      (file, options) => {
        if (options !== undefined) openPersistedWorkspaceFile(file, options);
        else openPersistedWorkspaceFile(file);
        openCompactDrawer();
      },
      [openCompactDrawer, openPersistedWorkspaceFile],
    );

  const openStorageFile =
    useCallback<ThreadSecondaryPanelStorageFileOpenHandler>(
      (file, options) => {
        if (options !== undefined) openPersistedStorageFile(file, options);
        else openPersistedStorageFile(file);
        openCompactDrawer();
      },
      [openCompactDrawer, openPersistedStorageFile],
    );

  const openHostFile = useCallback<ThreadSecondaryPanelHostFileOpenHandler>(
    (file, options) => {
      if (options !== undefined) openPersistedHostFile(file, options);
      else openPersistedHostFile(file);
      openCompactDrawer();
    },
    [openCompactDrawer, openPersistedHostFile],
  );

  const closePanel = useCallback(() => {
    if (isCompactViewport) {
      closeDrawer();
      return;
    }
    closePersistedPanel();
  }, [closeDrawer, closePersistedPanel, isCompactViewport]);

  const togglePanel = useCallback(() => {
    if (!isCompactViewport) {
      togglePersistedPanel();
      return;
    }
    toggleDrawer();
  }, [isCompactViewport, toggleDrawer, togglePersistedPanel]);

  return useMemo(
    () => ({
      closePanel,
      isOpen,
      openCommitDiff,
      openCompactDrawer,
      openDiffFile,
      openDiffPanel,
      openHostFile,
      openPanel,
      openStorageFile,
      openWorkspaceFile,
      togglePanel,
    }),
    [
      closePanel,
      isOpen,
      openCommitDiff,
      openCompactDrawer,
      openDiffFile,
      openDiffPanel,
      openHostFile,
      openPanel,
      openStorageFile,
      openWorkspaceFile,
      togglePanel,
    ],
  );
}
