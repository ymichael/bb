import { useCallback, useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  activeStorageFilePathAtom,
  activeWorkspaceFilePathAtom,
  openStorageFilePathsAtom,
  openWorkspaceFileTabsAtom,
  type WorkspaceFileTab,
} from "./threadSecondaryPanelAtoms";
import { PINNED_STORAGE_FILE_PATH } from "./managerStorage";
import { useSetThreadSecondaryPanel } from "@/lib/thread-secondary-panel";

interface UseThreadFileTabsParams {
  threadId: string | null | undefined;
  environmentId: string | null | undefined;
  isManagerThread: boolean;
  storageFiles: readonly { path: string }[] | undefined;
}

function arePathListsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function useThreadFileTabs({
  threadId,
  environmentId,
  isManagerThread,
  storageFiles,
}: UseThreadFileTabsParams) {
  const openWorkspaceFileTabs = useAtomValue(openWorkspaceFileTabsAtom);
  const setOpenWorkspaceFileTabs = useSetAtom(openWorkspaceFileTabsAtom);
  const activeWorkspaceFilePath = useAtomValue(activeWorkspaceFilePathAtom);
  const setActiveWorkspaceFilePath = useSetAtom(activeWorkspaceFilePathAtom);
  const openStorageFilePaths = useAtomValue(openStorageFilePathsAtom);
  const setOpenStorageFilePaths = useSetAtom(openStorageFilePathsAtom);
  const rawActiveStorageFilePath = useAtomValue(activeStorageFilePathAtom);
  const setActiveStorageFilePath = useSetAtom(activeStorageFilePathAtom);
  const setSecondaryPanel = useSetThreadSecondaryPanel();
  const hasDefaultedToPinnedFileRef = useRef(false);

  useEffect(() => {
    setOpenWorkspaceFileTabs([]);
    setActiveWorkspaceFilePath(null);
    setOpenStorageFilePaths([]);
    setActiveStorageFilePath(null);
    hasDefaultedToPinnedFileRef.current = false;
  }, [
    environmentId,
    setActiveStorageFilePath,
    setActiveWorkspaceFilePath,
    setOpenStorageFilePaths,
    setOpenWorkspaceFileTabs,
    threadId,
  ]);

  useEffect(() => {
    if (!isManagerThread) return;
    setOpenStorageFilePaths((prev) => {
      if (prev[0] === PINNED_STORAGE_FILE_PATH) return prev;
      const withoutPinned = prev.filter(
        (path) => path !== PINNED_STORAGE_FILE_PATH,
      );
      return [PINNED_STORAGE_FILE_PATH, ...withoutPinned];
    });
    if (hasDefaultedToPinnedFileRef.current) return;
    hasDefaultedToPinnedFileRef.current = true;
    setActiveStorageFilePath((prev) => prev ?? PINNED_STORAGE_FILE_PATH);
  }, [isManagerThread, setActiveStorageFilePath, setOpenStorageFilePaths]);

  useEffect(() => {
    if (!storageFiles) return;
    const known = new Set(storageFiles.map((file) => file.path));
    setOpenStorageFilePaths((prev) => {
      const next = prev.filter((path) => known.has(path));
      return arePathListsEqual(next, prev) ? prev : next;
    });
    setActiveStorageFilePath((prev) =>
      prev !== null && !known.has(prev) ? null : prev,
    );
  }, [setActiveStorageFilePath, setOpenStorageFilePaths, storageFiles]);

  const openWorkspaceFile = useCallback(
    ({ lineNumber, path }: WorkspaceFileTab) => {
      setOpenWorkspaceFileTabs((prev) => {
        const existingTab = prev.find((tab) => tab.path === path);
        if (!existingTab) {
          return [...prev, { lineNumber, path }];
        }
        if (existingTab.lineNumber === lineNumber) {
          return prev;
        }
        return prev.map((tab) =>
          tab.path === path ? { lineNumber, path } : tab,
        );
      });
      setActiveWorkspaceFilePath(path);
      setActiveStorageFilePath(null);
      setSecondaryPanel("thread-info");
    },
    [
      setActiveStorageFilePath,
      setActiveWorkspaceFilePath,
      setOpenWorkspaceFileTabs,
      setSecondaryPanel,
    ],
  );

  const closeWorkspaceFileTab = useCallback(
    (path: string) => {
      setOpenWorkspaceFileTabs((prev) =>
        prev.filter((tab) => tab.path !== path),
      );
      setActiveWorkspaceFilePath((prev) => (prev === path ? null : prev));
    },
    [setActiveWorkspaceFilePath, setOpenWorkspaceFileTabs],
  );

  const activateWorkspaceFileTab = useCallback(
    (path: string) => {
      setActiveWorkspaceFilePath(path);
      setActiveStorageFilePath(null);
    },
    [setActiveStorageFilePath, setActiveWorkspaceFilePath],
  );

  const openStorageFile = useCallback(
    (path: string) => {
      setOpenStorageFilePaths((prev) =>
        prev.includes(path) ? prev : [...prev, path],
      );
      setActiveStorageFilePath(path);
      setActiveWorkspaceFilePath(null);
    },
    [
      setActiveStorageFilePath,
      setActiveWorkspaceFilePath,
      setOpenStorageFilePaths,
    ],
  );

  const closeStorageFileTab = useCallback(
    (path: string) => {
      if (path === PINNED_STORAGE_FILE_PATH) return;
      setOpenStorageFilePaths((prev) =>
        prev.filter((openPath) => openPath !== path),
      );
      setActiveStorageFilePath((prev) => (prev === path ? null : prev));
    },
    [setActiveStorageFilePath, setOpenStorageFilePaths],
  );

  const activateStorageFileTab = useCallback(
    (path: string) => {
      setActiveStorageFilePath(path);
      setActiveWorkspaceFilePath(null);
    },
    [setActiveStorageFilePath, setActiveWorkspaceFilePath],
  );

  const clearActiveFileTabs = useCallback(() => {
    setActiveWorkspaceFilePath(null);
    setActiveStorageFilePath(null);
  }, [setActiveStorageFilePath, setActiveWorkspaceFilePath]);

  const activeWorkspaceFileTab =
    openWorkspaceFileTabs.find((tab) => tab.path === activeWorkspaceFilePath) ??
    null;
  const activeStorageFilePath =
    activeWorkspaceFilePath === null ? rawActiveStorageFilePath : null;

  return {
    activateStorageFileTab,
    activateWorkspaceFileTab,
    activeStorageFilePath,
    activeWorkspaceFileLineNumber: activeWorkspaceFileTab?.lineNumber ?? null,
    activeWorkspaceFilePath,
    clearActiveFileTabs,
    closeStorageFileTab,
    closeWorkspaceFileTab,
    openStorageFile,
    openStorageFilePaths,
    openWorkspaceFile,
    openWorkspaceFileTabs,
  };
}
