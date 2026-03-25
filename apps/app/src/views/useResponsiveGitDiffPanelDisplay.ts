import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { useResizeObserver } from "usehooks-ts";

const TIMELINE_PANEL_DEFAULT_SIZE_PERCENT = 50;
const GIT_DIFF_SPLIT_VIEW_MIN_WIDTH_PX = 760;
const GIT_DIFF_VIEW_BASE_OPTIONS = {
  overflow: "scroll",
  diffStyle: "unified",
  disableFileHeader: false,
} as const;

export function useResponsiveGitDiffPanelDisplay({
  isSecondaryPanelOpen,
  preferredTheme,
}: {
  isSecondaryPanelOpen: boolean;
  preferredTheme: string;
}) {
  const [gitDiffDisplayMode, setGitDiffDisplayMode] = useState<"unified" | "split">(
    "unified",
  );
  const [hasExplicitGitDiffDisplayMode, setHasExplicitGitDiffDisplayMode] = useState(false);
  const [isSecondaryPanelResizing, setIsSecondaryPanelResizing] = useState(false);
  const [secondaryPanelWidth, setSecondaryPanelWidth] = useState<number | null>(null);
  const secondaryPanelRef = useRef<HTMLElement>(null!);
  const secondaryResizablePanelRef = useRef<ImperativePanelHandle | null>(null);
  const lastSecondaryPanelSizeRef = useRef(TIMELINE_PANEL_DEFAULT_SIZE_PERCENT);
  const lastDiffViewWideEnoughRef = useRef<boolean | null>(null);

  const isDiffViewWideEnough =
    secondaryPanelWidth !== null && secondaryPanelWidth >= GIT_DIFF_SPLIT_VIEW_MIN_WIDTH_PX;
  const gitDiffViewOptions = useMemo(
    () => ({
      ...GIT_DIFF_VIEW_BASE_OPTIONS,
      diffStyle: gitDiffDisplayMode,
      themeType: preferredTheme,
    }),
    [gitDiffDisplayMode, preferredTheme],
  );
  const updateSecondaryPanelWidth = useCallback((nextWidth: number | undefined) => {
    if (nextWidth === undefined) {
      return;
    }

    const roundedWidth = Math.round(nextWidth);
    setSecondaryPanelWidth((currentWidth) =>
      currentWidth === roundedWidth ? currentWidth : roundedWidth,
    );
  }, []);

  useLayoutEffect(() => {
    const panel = secondaryResizablePanelRef.current;
    if (!panel) {
      return;
    }

    if (isSecondaryPanelOpen) {
      panel.expand(lastSecondaryPanelSizeRef.current);
      return;
    }

    panel.collapse();
  }, [isSecondaryPanelOpen]);

  useLayoutEffect(() => {
    if (!isSecondaryPanelOpen) {
      return;
    }

    updateSecondaryPanelWidth(secondaryPanelRef.current?.getBoundingClientRect().width);
  }, [isSecondaryPanelOpen, updateSecondaryPanelWidth]);

  useResizeObserver({
    ref: secondaryPanelRef,
    onResize: ({ width }) => {
      if (!isSecondaryPanelOpen) {
        return;
      }

      updateSecondaryPanelWidth(
        width ?? secondaryPanelRef.current?.getBoundingClientRect().width,
      );
    },
  });

  useEffect(() => {
    if (!isSecondaryPanelOpen) {
      setHasExplicitGitDiffDisplayMode(false);
      setSecondaryPanelWidth(null);
      lastDiffViewWideEnoughRef.current = null;
      return;
    }
    if (secondaryPanelWidth === null) {
      return;
    }

    const previousWideEnough = lastDiffViewWideEnoughRef.current;
    const crossedBreakpoint =
      previousWideEnough !== null && previousWideEnough !== isDiffViewWideEnough;
    if (crossedBreakpoint && hasExplicitGitDiffDisplayMode) {
      setHasExplicitGitDiffDisplayMode(false);
    }

    if (!hasExplicitGitDiffDisplayMode || crossedBreakpoint) {
      const nextMode = isDiffViewWideEnough ? "split" : "unified";
      setGitDiffDisplayMode((currentMode) =>
        currentMode === nextMode ? currentMode : nextMode,
      );
    }

    lastDiffViewWideEnoughRef.current = isDiffViewWideEnough;
  }, [
    secondaryPanelWidth,
    hasExplicitGitDiffDisplayMode,
    isSecondaryPanelOpen,
    isDiffViewWideEnough,
  ]);

  const handleGitDiffDisplayModeChange = useCallback((nextMode: "unified" | "split") => {
    setHasExplicitGitDiffDisplayMode(true);
    setGitDiffDisplayMode(nextMode);
  }, []);

  const handleSecondaryPanelDragging = useCallback((isDragging: boolean) => {
    setIsSecondaryPanelResizing(isDragging);
    if (isDragging) {
      // Treat panel resizing as opting back into responsive split/stacked mode.
      setHasExplicitGitDiffDisplayMode(false);
    }
  }, []);

  const handleSecondaryPanelResize = useCallback((size: number) => {
    if (size <= 0) {
      return;
    }

    lastSecondaryPanelSizeRef.current = size;
  }, []);

  return {
    gitDiffDisplayMode,
    gitDiffViewOptions,
    handleGitDiffDisplayModeChange,
    handleSecondaryPanelDragging,
    handleSecondaryPanelResize,
    isSecondaryPanelResizing,
    secondaryPanelRef,
    secondaryResizablePanelRef,
  };
}
