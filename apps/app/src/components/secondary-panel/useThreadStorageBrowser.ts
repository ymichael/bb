import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFile } from "@bb/server-contract";
import { createRetryingModuleLoader } from "@/lib/plugin-frontend-lazy";
import type { ThreadStorageTreeModel } from "./ThreadStorageFileTree";

const EMPTY_STORAGE_FILES: readonly WorkspaceFile[] = [];

type ThreadStorageFileTreeModule = typeof import("./ThreadStorageFileTree");

const loadThreadStorageFileTree =
  createRetryingModuleLoader<ThreadStorageFileTreeModule>(
    () => import("./ThreadStorageFileTree"),
  );

export type ThreadStoragePathSelectHandler = (path: string) => void;

interface UseThreadStorageBrowserArgs {
  files: readonly WorkspaceFile[] | undefined;
  onSelectPath: ThreadStoragePathSelectHandler;
  selectedPath: string | null;
}

export interface ThreadStorageBrowserController {
  closeSearch: () => void;
  filteredFiles: readonly WorkspaceFile[];
  isSearchOpen: boolean;
  loadedFiles: readonly WorkspaceFile[];
  model: ThreadStorageTreeModel | null;
  openSearch: () => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

function buildDirectoryPaths(paths: readonly string[]): string[] {
  const directoryPaths = new Set<string>();

  for (const path of paths) {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    let currentPath = "";

    for (const segment of segments.slice(0, -1)) {
      currentPath = `${currentPath}${segment}/`;
      directoryPaths.add(currentPath);
    }
  }

  return Array.from(directoryPaths);
}

export function useThreadStorageBrowser({
  files,
  onSelectPath,
  selectedPath,
}: UseThreadStorageBrowserArgs): ThreadStorageBrowserController {
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const loadedFiles = files ?? EMPTY_STORAGE_FILES;
  const filteredFiles = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (normalized.length === 0) {
      return loadedFiles;
    }
    return loadedFiles.filter((file) =>
      file.path.toLowerCase().includes(normalized),
    );
  }, [loadedFiles, searchQuery]);
  const filePaths = useMemo(
    () => filteredFiles.map((file) => file.path),
    [filteredFiles],
  );
  const filePathSet = useMemo(() => new Set(filePaths), [filePaths]);
  const filePathSetRef = useRef<ReadonlySet<string>>(filePathSet);
  const onSelectPathRef = useRef(onSelectPath);
  const isApplyingSelectionRef = useRef(false);

  useEffect(() => {
    filePathSetRef.current = filePathSet;
  }, [filePathSet]);

  useEffect(() => {
    onSelectPathRef.current = onSelectPath;
  }, [onSelectPath]);

  const handleTreeSelectionChange = useCallback(
    (selectedPaths: readonly string[]) => {
      if (isApplyingSelectionRef.current) return;
      const nextPath = selectedPaths[0];
      if (!nextPath || !filePathSetRef.current.has(nextPath)) {
        return;
      }
      onSelectPathRef.current(nextPath);
    },
    [],
  );

  const [model, setModel] = useState<ThreadStorageTreeModel | null>(null);
  const shouldLoadTree = loadedFiles.length > 0;
  useEffect(() => {
    if (!shouldLoadTree) return;
    let cancelled = false;
    let createdModel: ThreadStorageTreeModel | null = null;
    void loadThreadStorageFileTree().then(
      ({ createThreadStorageTreeModel }) => {
        if (cancelled) return;
        createdModel = createThreadStorageTreeModel(handleTreeSelectionChange);
        setModel(createdModel);
      },
      (error: unknown) => {
        if (cancelled) return;
        console.warn(
          `thread storage tree load failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
    return () => {
      cancelled = true;
      createdModel?.cleanUp();
      setModel(null);
    };
  }, [handleTreeSelectionChange, shouldLoadTree]);

  const isSearching = searchQuery.trim().length > 0;
  const expandedDirectoryPaths = useMemo(
    () => (isSearching ? buildDirectoryPaths(filePaths) : []),
    [isSearching, filePaths],
  );
  useEffect(() => {
    if (model === null) return;
    model.resetPaths(filePaths, {
      initialExpandedPaths: expandedDirectoryPaths,
    });
  }, [expandedDirectoryPaths, filePaths, model]);

  useEffect(() => {
    if (model === null) return;
    const currentSelectedPaths = model.getSelectedPaths();
    const selectedPathIsVisible =
      selectedPath !== null && filePathSet.has(selectedPath);

    const alreadyMatches = selectedPathIsVisible
      ? currentSelectedPaths.length === 1 &&
        currentSelectedPaths[0] === selectedPath
      : currentSelectedPaths.length === 0;
    if (alreadyMatches) return;

    isApplyingSelectionRef.current = true;
    try {
      for (const path of currentSelectedPaths) {
        if (selectedPathIsVisible && path === selectedPath) continue;
        model.getItem(path)?.deselect();
      }
      if (selectedPathIsVisible) {
        model.getItem(selectedPath)?.select();
      }
    } finally {
      isApplyingSelectionRef.current = false;
    }
  }, [filePathSet, model, selectedPath]);

  const openSearch = useCallback(() => {
    setIsSearchOpen(true);
  }, []);
  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery("");
  }, []);

  return {
    closeSearch,
    filteredFiles,
    isSearchOpen,
    loadedFiles,
    model,
    openSearch,
    searchQuery,
    setSearchQuery,
  };
}
