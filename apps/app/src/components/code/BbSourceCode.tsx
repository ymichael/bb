import { SourceLoadingSkeleton } from "@/components/code/code-loading-skeletons";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { File as PierreFile, VirtualizerContext } from "@pierre/diffs/react";
import type { FileOptions } from "@pierre/diffs/react";
import {
  DIFFS_TAG_NAME,
  Virtualizer as PierreVirtualizer,
  type FileContents as PierreFileContents,
  type SelectedLineRange,
  type VirtualFileMetrics,
} from "@pierre/diffs";
import { Button } from "@bb/shared-ui/button";
import { usePierreLineSelectionActions } from "@/components/git-diff/PierreLineSelectionActions.js";
import { usePreferredTheme } from "@/hooks/useTheme";
import { useResolvedCodeThemePair } from "@/lib/code-theme";
import { PierreWorkerPoolBoundary } from "@/lib/pierre-worker-pool-boundary";
import {
  usePierreWorkerPool,
  useRequirePierreWorkerPool,
} from "@/lib/pierre-worker-pool-gate";
import { usePierreStrictModeRecoveryOptions } from "@/lib/pierre-strict-mode-recovery";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  truncateSourceCode,
  type SourceCodeTruncation,
} from "./source-code-budget";
import type { BbSourceCodeProps } from "./code-rendering";

interface SourceCodeWorkerPoolStats {
  managerState: "waiting" | "initializing" | "initialized";
  workersFailed: boolean;
  totalWorkers: number;
  busyWorkers: number;
  queuedTasks: number;
  activeTasks: number;
  themeSubscribers: number;
  fileCacheSize: number;
  diffCacheSize: number;
}

const SOURCE_LINE_HEIGHT_PX = 18;
const SOURCE_GAP_BLOCK_PX = 16;

const SOURCE_VIEW_STYLE = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": `${SOURCE_LINE_HEIGHT_PX}px`,
  "--diffs-gap-block": `${SOURCE_GAP_BLOCK_PX}px`,
} as CSSProperties;

const SOURCE_VIRTUAL_FILE_METRICS: VirtualFileMetrics = {
  hunkLineCount: 50,
  lineHeight: SOURCE_LINE_HEIGHT_PX,
  diffHeaderHeight: 0,
  spacing: SOURCE_GAP_BLOCK_PX,
};

function getTargetRoots(container: HTMLElement): ParentNode[] {
  const roots: ParentNode[] = [container];
  for (const pierreContainer of container.querySelectorAll<HTMLElement>(
    DIFFS_TAG_NAME,
  )) {
    if (pierreContainer.shadowRoot !== null) {
      roots.push(pierreContainer.shadowRoot);
    }
  }
  return roots;
}

function clearTargetLine(container: HTMLElement) {
  for (const root of getTargetRoots(container)) {
    const targetLines = root.querySelectorAll(
      "[data-bb-source-code-target-line]",
    );
    for (const targetLine of targetLines) {
      targetLine.removeAttribute("data-bb-source-code-target-line");
      targetLine.removeAttribute("data-selected-line");
    }
  }
}

function findTargetLine(
  container: HTMLElement,
  lineNumber: number,
): HTMLElement | null {
  const roots = getTargetRoots(container);
  for (const root of roots) {
    const lines = root.querySelectorAll(`[data-line="${lineNumber}"]`);
    for (const line of lines) {
      if (line instanceof HTMLElement && line.dataset.lineIndex !== undefined) {
        return line;
      }
    }
  }
  for (const root of roots) {
    const lines = root.querySelectorAll(`[data-line="${lineNumber}"]`);
    for (const line of lines) {
      if (line instanceof HTMLElement) {
        return line;
      }
    }
  }
  return null;
}

function findVirtualizedViewport(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-bb-source-code-viewport]");
}

function approachVirtualizedTargetLine(
  container: HTMLElement,
  lineNumber: number,
) {
  const viewport = findVirtualizedViewport(container);
  if (viewport === null) return;
  const viewportRect = viewport.getBoundingClientRect();
  const centerOffset = viewportRect.height / 2;
  const renderedBounds = getRenderedLineBounds(container);
  if (renderedBounds === null) {
    const estimatedTop =
      SOURCE_GAP_BLOCK_PX + (lineNumber - 1) * SOURCE_LINE_HEIGHT_PX;
    viewport.scrollTop = Math.max(0, estimatedTop - centerOffset);
    return;
  }
  const { firstLineNumber, firstTop, lastLineNumber, lastBottom } =
    renderedBounds;
  if (lineNumber > lastLineNumber) {
    const distance =
      lastBottom -
      viewportRect.top +
      (lineNumber - lastLineNumber - 1) * SOURCE_LINE_HEIGHT_PX;
    viewport.scrollTop += Math.max(0, distance - centerOffset);
  } else if (lineNumber < firstLineNumber) {
    const distance =
      viewportRect.top -
      firstTop +
      (firstLineNumber - lineNumber) * SOURCE_LINE_HEIGHT_PX;
    viewport.scrollTop = Math.max(
      0,
      viewport.scrollTop - distance - centerOffset,
    );
  }
}

interface RenderedPreviewLineBounds {
  firstLineNumber: number;
  firstTop: number;
  lastLineNumber: number;
  lastBottom: number;
}

function getRenderedLineBounds(
  container: HTMLElement,
): RenderedPreviewLineBounds | null {
  let bounds: RenderedPreviewLineBounds | null = null;
  for (const root of getTargetRoots(container)) {
    for (const line of root.querySelectorAll<HTMLElement>(
      "[data-line][data-line-index]",
    )) {
      const lineNumber = Number(line.dataset.line);
      if (!Number.isFinite(lineNumber)) continue;
      const rect = line.getBoundingClientRect();
      if (bounds === null) {
        bounds = {
          firstLineNumber: lineNumber,
          firstTop: rect.top,
          lastLineNumber: lineNumber,
          lastBottom: rect.bottom,
        };
        continue;
      }
      if (lineNumber < bounds.firstLineNumber) {
        bounds.firstLineNumber = lineNumber;
        bounds.firstTop = rect.top;
      }
      if (lineNumber > bounds.lastLineNumber) {
        bounds.lastLineNumber = lineNumber;
        bounds.lastBottom = rect.bottom;
      }
    }
  }
  return bounds;
}

function scrollTargetLine(container: HTMLElement, line: HTMLElement) {
  const viewport = findVirtualizedViewport(container);
  if (viewport === null) return;

  const lineRect = line.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  const lineCenter = lineRect.top + lineRect.height / 2;
  const viewportCenter = viewportRect.top + viewportRect.height / 2;
  viewport.scrollTop += lineCenter - viewportCenter;
}

function formatLineRange(startLineNumber: number, endLineNumber: number) {
  return startLineNumber === endLineNumber
    ? String(startLineNumber)
    : `${startLineNumber}-${endLineNumber}`;
}

function buildLineSelectionText({
  contents,
  path,
  range,
}: {
  contents: string;
  path: string;
  range: SelectedLineRange;
}): string | null {
  const startLineNumber = Math.max(1, Math.min(range.start, range.end));
  const endLineNumber = Math.max(
    startLineNumber,
    Math.max(range.start, range.end),
  );
  const lines = contents.split(/\r\n|\n|\r/);
  const selectedLines = lines.slice(startLineNumber - 1, endLineNumber);
  if (selectedLines.length === 0) {
    return null;
  }
  const selectedText = selectedLines.join("\n").trimEnd();
  if (selectedText.trim().length === 0) {
    return null;
  }
  return `${path}:${formatLineRange(startLineNumber, endLineNumber)}\n${selectedText}`;
}

function BbSourceCode({
  content,
  path,
  cacheKey,
  overflow,
  highlightedLines,
  className,
  scrollToHighlightedLines = false,
  onSelectionAddToChat,
}: BbSourceCodeProps) {
  const fileCacheKey = cacheKey ?? path;
  const file = useMemo<PierreFileContents>(
    () => ({ name: path, contents: content, cacheKey: fileCacheKey }),
    [content, fileCacheKey, path],
  );
  const preferredTheme = usePreferredTheme();
  const codeTheme = useResolvedCodeThemePair();
  const containerRef = useRef<HTMLDivElement>(null);
  const isWorkerPoolReady = useRequirePierreWorkerPool();
  const workerPool = usePierreWorkerPool();
  const lastWorkerPoolStatsKeyRef = useRef<string | null>(null);
  const [workerPoolStats, setWorkerPoolStats] =
    useState<SourceCodeWorkerPoolStats | null>(null);
  const [, rerenderAfterWorkerPoolChange] = useState(0);
  const fileIdentity = fileCacheKey;
  const truncation = useMemo(() => truncateSourceCode(content), [content]);
  const [fullFileRequestedFor, setFullFileRequestedFor] = useState<
    string | null
  >(null);
  const buildSelectionText = useCallback(
    (range: SelectedLineRange) =>
      buildLineSelectionText({ contents: content, path, range }),
    [content, path],
  );
  const lineSelectionActions = usePierreLineSelectionActions({
    buildSelectionText,
    containerRef,
    enabled: onSelectionAddToChat !== undefined,
    onSelectionAddToChat,
  });
  const baseOptions = useMemo<FileOptions<undefined>>(
    () => ({
      themeType: preferredTheme,
      theme: codeTheme,
      overflow,
      disableFileHeader: true,
      enableGutterUtility: onSelectionAddToChat !== undefined,
      enableLineSelection:
        highlightedLines !== null || onSelectionAddToChat !== undefined,
      lineHoverHighlight:
        onSelectionAddToChat === undefined ? "disabled" : "number",
      onGutterUtilityClick:
        onSelectionAddToChat === undefined
          ? undefined
          : lineSelectionActions.onGutterUtilityClick,
      onLineSelectionChange: lineSelectionActions.onLineSelectionChange,
      onLineSelectionEnd: lineSelectionActions.onLineSelectionEnd,
      onLineSelectionStart: lineSelectionActions.onLineSelectionStart,
    }),
    [
      codeTheme,
      highlightedLines,
      overflow,
      lineSelectionActions.onGutterUtilityClick,
      lineSelectionActions.onLineSelectionChange,
      lineSelectionActions.onLineSelectionEnd,
      lineSelectionActions.onLineSelectionStart,
      onSelectionAddToChat,
      preferredTheme,
    ],
  );
  const options = usePierreStrictModeRecoveryOptions(baseOptions);
  const selectedLines = useMemo<SelectedLineRange | null>(() => {
    if (lineSelectionActions.selectedRange !== null) {
      return lineSelectionActions.selectedRange;
    }
    return highlightedLines === null
      ? null
      : { start: highlightedLines.start, end: highlightedLines.end };
  }, [highlightedLines, lineSelectionActions.selectedRange]);
  const targetLineNumber = scrollToHighlightedLines
    ? (selectedLines?.start ?? null)
    : null;
  const showsFullFile =
    truncation === null ||
    fullFileRequestedFor === fileIdentity ||
    (targetLineNumber !== null &&
      targetLineNumber > truncation.renderedLineCount);
  const renderedFile = useMemo<PierreFileContents>(() => {
    if (showsFullFile || truncation === null) {
      return file;
    }
    return {
      ...file,
      cacheKey: `${fileCacheKey}:head`,
      contents: truncation.contents,
    };
  }, [file, fileCacheKey, showsFullFile, truncation]);
  const renderedFileMountKey =
    showsFullFile || truncation === null
      ? fileCacheKey
      : `${fileCacheKey}:head`;
  const pendingViewportScrollTopRef = useRef<number | null>(null);
  const handleLoadFullFile = () => {
    const viewport =
      containerRef.current === null
        ? null
        : findVirtualizedViewport(containerRef.current);
    pendingViewportScrollTopRef.current = viewport?.scrollTop ?? null;
    setFullFileRequestedFor(fileIdentity);
  };
  useLayoutEffect(() => {
    const scrollTop = pendingViewportScrollTopRef.current;
    if (scrollTop === null) return;
    pendingViewportScrollTopRef.current = null;
    const viewport =
      containerRef.current === null
        ? null
        : findVirtualizedViewport(containerRef.current);
    if (viewport === null) return;
    viewport.scrollTop = scrollTop;
    const frame = window.requestAnimationFrame(() => {
      viewport.scrollTop = scrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renderedFileMountKey]);

  useEffect(() => {
    if (!workerPool) {
      setWorkerPoolStats(null);
      return;
    }

    lastWorkerPoolStatsKeyRef.current = null;
    return workerPool.subscribeToStatChanges((stats) => {
      setWorkerPoolStats(stats);
      const statsKey = [
        stats.managerState,
        stats.workersFailed,
        stats.busyWorkers,
        stats.queuedTasks,
        stats.activeTasks,
        stats.fileCacheSize,
      ].join(":");
      if (lastWorkerPoolStatsKeyRef.current === statsKey) {
        return;
      }
      lastWorkerPoolStatsKeyRef.current = statsKey;
      rerenderAfterWorkerPoolChange((version) => version + 1);
    });
  }, [file.contents, file.name, workerPool]);

  const shouldWaitForWorkerPool =
    workerPool !== undefined &&
    workerPoolStats?.managerState !== "initialized" &&
    workerPoolStats?.workersFailed !== true;
  const workerHighlightCacheState =
    workerPool?.getFileResultCache(renderedFile) !== undefined
      ? "highlighted"
      : "plain";

  useEffect(() => {
    const cleanupContainer = containerRef.current;
    let animationFrame: number | null = null;
    let attempts = 0;

    function scheduleRetry() {
      animationFrame = window.requestAnimationFrame(scrollToLine);
    }

    function scrollToLine() {
      const container = containerRef.current;
      if (!container) return;
      clearTargetLine(container);
      if (targetLineNumber === null) return;

      const line = findTargetLine(container, targetLineNumber);
      if (line) {
        line.setAttribute("data-bb-source-code-target-line", "");
        line.setAttribute("data-selected-line", "single");
        scrollTargetLine(container, line);
        return;
      }

      approachVirtualizedTargetLine(container, targetLineNumber);
      attempts += 1;
      if (attempts < TARGET_LINE_MAX_ATTEMPTS) {
        scheduleRetry();
      }
    }

    scrollToLine();
    return () => {
      if (cleanupContainer) {
        clearTargetLine(cleanupContainer);
      }
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [
    renderedFile.contents,
    renderedFile.name,
    shouldWaitForWorkerPool,
    targetLineNumber,
    workerHighlightCacheState,
  ]);

  if (shouldWaitForWorkerPool || !isWorkerPoolReady) {
    return <SourceLoadingSkeleton />;
  }

  return (
    <div
      ref={containerRef}
      className={cn("flex min-h-0 flex-1 flex-col", className)}
      style={SOURCE_VIEW_STYLE}
      data-bb-source-code-line-number={targetLineNumber ?? undefined}
      onPointerDownCapture={lineSelectionActions.onPointerDownCapture}
      onPointerMoveCapture={lineSelectionActions.onPointerMoveCapture}
      onPointerUpCapture={lineSelectionActions.onPointerUpCapture}
    >
      <PierreWorkerPoolBoundary>
        <SourceCodeViewport>
          <PierreFile
            key={renderedFileMountKey}
            disableWorkerPool={workerPoolStats?.workersFailed === true}
            file={renderedFile}
            metrics={SOURCE_VIRTUAL_FILE_METRICS}
            options={options}
            selectedLines={selectedLines}
          />
          {truncation !== null && !showsFullFile ? (
            <SourceCodeTruncationNotice
              truncation={truncation}
              onLoadFullFile={handleLoadFullFile}
            />
          ) : null}
        </SourceCodeViewport>
      </PierreWorkerPoolBoundary>
      {lineSelectionActions.menu}
    </div>
  );
}

const TARGET_LINE_MAX_ATTEMPTS = 40;

function SourceCodeViewport({ children }: { children: ReactNode }) {
  const [virtualizer] = useState(() =>
    typeof window === "undefined" ? undefined : new PierreVirtualizer(),
  );
  const viewportRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node !== null) {
        virtualizer?.setup(node);
      } else {
        virtualizer?.cleanUp();
      }
    },
    [virtualizer],
  );
  return (
    <VirtualizerContext.Provider value={virtualizer}>
      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-y-auto"
        data-bb-source-code-viewport
      >
        <div>{children}</div>
      </div>
    </VirtualizerContext.Provider>
  );
}

function SourceCodeTruncationNotice({
  truncation,
  onLoadFullFile,
}: {
  truncation: SourceCodeTruncation;
  onLoadFullFile: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-xs text-muted-foreground">
      <span>
        Showing the first {truncation.renderedLineCount.toLocaleString()} of{" "}
        {truncation.totalLineCount.toLocaleString()} lines.
      </span>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0 text-xs underline underline-offset-4 hover:underline"
        onClick={onLoadFullFile}
      >
        Load full file
      </Button>
    </div>
  );
}

export default BbSourceCode;
