import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useFileTree, type UseFileTreeResult } from "@pierre/trees/react";
import type { WorkspaceFile } from "@bb/server-contract";

const EMPTY_STORAGE_FILES: readonly WorkspaceFile[] = [];

interface UseManagerStorageBrowserArgs {
  files: readonly WorkspaceFile[] | undefined;
  onSelectPath: (path: string) => void;
  selectedPath: string | null;
}

export interface ManagerStorageBrowserController {
  closeSearch: () => void;
  filteredFiles: readonly WorkspaceFile[];
  isSearchOpen: boolean;
  loadedFiles: readonly WorkspaceFile[];
  model: UseFileTreeResult["model"];
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

/**
 * Owns the manager-thread storage browser's tree model and related UI state.
 *
 * Pierre tree's `useFileTree` destroys its model on the owning component's
 * unmount (`model.cleanUp()` unsubscribes the selection listener and destroys
 * the controller — see packages/trees/src/react/useFileTree.ts and
 * render/FileTree.ts in pierrecomputer/pierre). The storage tab content
 * unmounts whenever a file tab covers it, so this hook must live in a parent
 * that survives that toggle (e.g., ThreadDetailView), with the model and
 * search state passed down to the presentational browser.
 */
export function useManagerStorageBrowser({
  files,
  onSelectPath,
  selectedPath,
}: UseManagerStorageBrowserArgs): ManagerStorageBrowserController {
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

  useEffect(() => {
    filePathSetRef.current = filePathSet;
  }, [filePathSet]);

  useEffect(() => {
    onSelectPathRef.current = onSelectPath;
  }, [onSelectPath]);

  const handleTreeSelectionChange = useCallback(
    (selectedPaths: readonly string[]) => {
      const nextPath = selectedPaths[0];
      if (!nextPath || !filePathSetRef.current.has(nextPath)) {
        return;
      }
      onSelectPathRef.current(nextPath);
    },
    [],
  );

  const { model } = useFileTree({
    density: "compact",
    initialExpansion: "closed",
    onSelectionChange: handleTreeSelectionChange,
    paths: [],
    search: false,
  });

  const isSearching = searchQuery.trim().length > 0;
  const expandedDirectoryPaths = useMemo(
    () => (isSearching ? buildDirectoryPaths(filePaths) : []),
    [isSearching, filePaths],
  );
  useEffect(() => {
    model.resetPaths(filePaths, {
      initialExpandedPaths: expandedDirectoryPaths,
    });
  }, [expandedDirectoryPaths, filePaths, model]);

  useEffect(() => {
    const selectedPaths = model.getSelectedPaths();
    const selectedPathIsVisible =
      selectedPath !== null && filePathSet.has(selectedPath);

    if (selectedPathIsVisible) {
      if (selectedPaths.length !== 1 || selectedPaths[0] !== selectedPath) {
        model.getItem(selectedPath)?.select();
      }
      return;
    }

    for (const path of selectedPaths) {
      model.getItem(path)?.deselect();
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
