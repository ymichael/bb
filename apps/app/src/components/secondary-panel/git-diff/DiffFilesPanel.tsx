import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAtom } from "jotai";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DiffFileEntry, DiffPatchEntry } from "@bb/server-contract";
import type { DiffPresentation } from "@/components/code/code-rendering";
import type { WorkspaceDiffTarget } from "@bb/domain";
import type { RequestDiffFileContents } from "@/components/git-diff/GitDiffCardBody";
import {
  type DiffPatchState,
  type LoadDiffPatchPath,
  type RetryDiffPatchPath,
  useEnvironmentDiffPatches,
} from "@/hooks/queries/use-environment-diff-patches";
import { cn } from "@bb/shared-ui/lib/utils";
import { DiffFileCard } from "./DiffFileCard";
import {
  diffFileCardStateAtomFamily,
  estimateCardHeight,
  resolveCardCollapsed,
  resolveDiffFileCardInitialState,
} from "./diffFilesStore";

const DIFF_FILES_OVERSCAN = 4;
const DIFF_FILES_GAP_PX = 8;

interface DiffFilesPanelProps {
  environmentId: string;
  target: WorkspaceDiffTarget;
  diffIdentity: string;
  files: DiffFileEntry[];
  initialPatches: DiffPatchEntry[];
  filesUpdatedAt: number;
  presentation: DiffPresentation;
  filePathRoot?: string | null;
  isPanelOpen: boolean;
  isPlaceholderData?: boolean;
  scrollToPath?: string | null;
  onScrolledToPath?: () => void;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview?: (path: string) => void;
  onRequestFileContents?: RequestDiffFileContents;
  onSelectionAddToChat?: (text: string) => void;
}

export function DiffFilesPanel({
  environmentId,
  target,
  diffIdentity,
  files,
  initialPatches,
  filesUpdatedAt,
  presentation,
  filePathRoot,
  isPanelOpen,
  isPlaceholderData,
  scrollToPath,
  onScrolledToPath,
  onOpenFileInEditor,
  onOpenFilePreview,
  onRequestFileContents,
  onSelectionAddToChat,
}: DiffFilesPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { requestPaths, getPatchState, retry, loadPath, seedInitialPatches } =
    useEnvironmentDiffPatches(environmentId, { target });

  useEffect(() => {
    if (initialPatches.length > 0) {
      seedInitialPatches(initialPatches);
    }
  }, [seedInitialPatches, initialPatches, filesUpdatedAt]);

  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const entry = files[index];
      if (!entry) {
        return 0;
      }
      const collapsed = resolveDiffFileCardInitialState({
        entry,
        fileCount: files.length,
      }).collapsed;
      return estimateCardHeight({ entry, collapsed }) + DIFF_FILES_GAP_PX;
    },
    getItemKey: (index) => files[index]?.path ?? index,
    overscan: DIFF_FILES_OVERSCAN,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const { startIndex, endIndex } = virtualizer.range ?? {
    startIndex: 0,
    endIndex: -1,
  };

  const { visiblePaths, overscanPaths } = useMemo(() => {
    const visible: string[] = [];
    const overscan: string[] = [];
    for (const item of virtualItems) {
      const entry = files[item.index];
      if (!entry || entry.loadMode !== "auto") {
        continue;
      }
      if (item.index >= startIndex && item.index <= endIndex) {
        visible.push(entry.path);
      } else {
        overscan.push(entry.path);
      }
    }
    return { visiblePaths: visible, overscanPaths: overscan };
  }, [virtualItems, files, startIndex, endIndex]);

  const visibleKey = visiblePaths.join("\n");
  const overscanKey = overscanPaths.join("\n");
  useEffect(() => {
    if (!isPanelOpen) {
      return;
    }
    requestPaths({ visible: visiblePaths, overscan: overscanPaths });
    // oxlint-disable-next-line react/exhaustive-deps
  }, [isPanelOpen, requestPaths, visibleKey, overscanKey, filesUpdatedAt]);

  useEffect(() => {
    if (!scrollToPath || isPlaceholderData) {
      return;
    }
    const index = files.findIndex((file) => file.path === scrollToPath);
    if (index < 0) {
      return;
    }
    virtualizer.scrollToIndex(index, { align: "start" });
    onScrolledToPath?.();
  }, [scrollToPath, files, isPlaceholderData, virtualizer, onScrolledToPath]);

  return (
    <div ref={scrollRef} className={cn(PANEL_SCROLL_SLOT_CLASS, "px-4 pb-3")}>
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualItems.map((item) => {
          const entry = files[item.index];
          if (!entry) {
            return null;
          }
          return (
            <div
              key={entry.path}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 w-full"
              style={{
                top: item.start,
                paddingBottom: DIFF_FILES_GAP_PX,
              }}
            >
              <DiffFileRow
                entry={entry}
                diffIdentity={diffIdentity}
                fileCount={files.length}
                presentation={presentation}
                filePathRoot={filePathRoot}
                patchState={getPatchState(entry.path)}
                loadPath={loadPath}
                retry={retry}
                onOpenFileInEditor={onOpenFileInEditor}
                onOpenFilePreview={onOpenFilePreview}
                onRequestFileContents={onRequestFileContents}
                onSelectionAddToChat={onSelectionAddToChat}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const PANEL_SCROLL_SLOT_CLASS =
  "min-h-0 flex-1 overflow-x-hidden overflow-y-auto";

interface DiffFileRowProps {
  entry: DiffFileEntry;
  diffIdentity: string;
  fileCount: number;
  presentation: DiffPresentation;
  filePathRoot?: string | null;
  patchState: DiffPatchState;
  loadPath: LoadDiffPatchPath;
  retry: RetryDiffPatchPath;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview?: (path: string) => void;
  onRequestFileContents?: RequestDiffFileContents;
  onSelectionAddToChat?: (text: string) => void;
}

function DiffFileRow({
  entry,
  diffIdentity,
  fileCount,
  presentation,
  filePathRoot,
  patchState,
  loadPath,
  retry,
  onOpenFileInEditor,
  onOpenFilePreview,
  onRequestFileContents,
  onSelectionAddToChat,
}: DiffFileRowProps) {
  const stateAtom = useMemo(
    () => diffFileCardStateAtomFamily({ diffIdentity, path: entry.path }),
    [diffIdentity, entry.path],
  );
  const [cardState, setCardState] = useAtom(stateAtom);
  const collapsed = resolveCardCollapsed(cardState, entry, fileCount);

  const handleToggleCollapsed = useCallback(() => {
    setCardState((previous) => {
      const current =
        previous ?? resolveDiffFileCardInitialState({ entry, fileCount });
      return { ...current, collapsed: !current.collapsed };
    });
  }, [entry, fileCount, setCardState]);

  const handleLoadPatch = useCallback(() => {
    loadPath(entry.path);
  }, [entry.path, loadPath]);

  const handleRetry = useCallback(() => {
    retry(entry.path);
  }, [entry.path, retry]);

  return (
    <DiffFileCard
      entry={entry}
      presentation={presentation}
      filePathRoot={filePathRoot}
      isCollapsed={collapsed}
      onToggleCollapsed={handleToggleCollapsed}
      patchState={patchState}
      onLoadPatch={handleLoadPatch}
      onRetry={handleRetry}
      onOpenFileInEditor={onOpenFileInEditor}
      onOpenFilePreview={onOpenFilePreview}
      onRequestFileContents={onRequestFileContents}
      onSelectionAddToChat={onSelectionAddToChat}
    />
  );
}
