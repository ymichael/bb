import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { SelectedLineRange } from "@pierre/diffs";
import {
  anchorPointFromMouseEvent,
  selectionAnchorFromPointerRelease,
  type MessageProseSelection,
  type SelectionAnchor,
  type SelectionAnchorPoint,
  type SelectionAnchorSide,
} from "@/components/thread/timeline/SelectableMessageProse.js";
import { TimelineSelectionMenu } from "@/components/thread/timeline/TimelineSelectionMenu.js";
import { getDiffShadowRoots } from "./git-diff-patch-text";

const LINE_SELECTION_MENU_INLINE_OFFSET_PX = 72;

let documentPointerStartPoint: SelectionAnchorPoint | null = null;
let documentPointerReleaseAnchor: SelectionAnchor | null = null;

interface UsePierreLineSelectionActionsArgs {
  buildFallbackSelectionText?: (args: {
    containerElement: HTMLElement | null;
    range: SelectedLineRange;
  }) => string | null;
  buildSelectionText: (range: SelectedLineRange) => string | null;
  containerRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  onSelectionAddToChat?: (text: string) => void;
}

export interface PierreLineSelectionActions {
  menu: ReactNode;
  onLineSelectionChange: (range: SelectedLineRange | null) => void;
  onLineSelectionEnd: (range: SelectedLineRange | null) => void;
  onLineSelectionStart: (range: SelectedLineRange | null) => void;
  onGutterUtilityClick: (range: SelectedLineRange) => void;
  onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMoveCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUpCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  selectedRange: SelectedLineRange | null;
}

function fallbackAnchorPoint(
  containerElement: HTMLElement | null,
): SelectionAnchor {
  const rect = containerElement?.getBoundingClientRect();
  if (!rect) {
    return { point: { x: 0, y: 0 }, side: "top" };
  }
  return { point: { x: rect.left + 24, y: rect.top + 24 }, side: "top" };
}

function buildMenuSelection({
  anchor,
  containerElement,
  text,
}: {
  anchor: SelectionAnchor | null;
  containerElement: HTMLElement | null;
  text: string;
}): MessageProseSelection | null {
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return null;
  }

  const selectionAnchor = anchor ?? fallbackAnchorPoint(containerElement);
  const anchorPoint = selectionAnchor.point;
  return {
    text: trimmedText,
    rect: new DOMRect(anchorPoint.x, anchorPoint.y, 0, 0),
    anchorPoint,
    anchorSide: selectionAnchor.side,
  };
}

function isGutterUtilityPointerEvent(
  event: ReactPointerEvent<HTMLElement>,
): boolean {
  return isGutterUtilityPath(event.nativeEvent.composedPath());
}

function isGutterUtilityPath(
  path: readonly (EventTarget | undefined)[],
): boolean {
  return path.some(
    (target) =>
      target instanceof Element &&
      (target.hasAttribute("data-utility-button") ||
        target.hasAttribute("data-gutter-utility-slot") ||
        target.getAttribute("slot") === "gutter-utility-slot" ||
        target.getAttribute("name") === "gutter-utility-slot"),
  );
}

function selectedLineAttributeMatchesSide(
  element: HTMLElement,
  anchorSide: SelectionAnchorSide,
) {
  const value = element.getAttribute("data-selected-line");
  if (value === "single") {
    return true;
  }
  return anchorSide === "bottom" ? value === "last" : value === "first";
}

function getBoundarySelectedLine(
  rows: HTMLElement[],
  anchorSide: SelectionAnchorSide,
) {
  const matchingRow = rows.find((row) =>
    selectedLineAttributeMatchesSide(row, anchorSide),
  );
  if (matchingRow !== undefined) {
    return matchingRow;
  }
  return rows
    .map((row) => ({ row, rect: row.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 || rect.height > 0)
    .sort((first, second) =>
      anchorSide === "bottom"
        ? second.rect.bottom - first.rect.bottom
        : first.rect.top - second.rect.top,
    )[0]?.row;
}

function anchorPointFromSelectedLine(
  lineElement: HTMLElement,
  anchorSide: SelectionAnchorSide,
): SelectionAnchorPoint {
  const rect = lineElement.getBoundingClientRect();
  return {
    x:
      rect.left +
      Math.min(LINE_SELECTION_MENU_INLINE_OFFSET_PX, rect.width / 2),
    y: anchorSide === "bottom" ? rect.bottom : rect.top,
  };
}

function resolveSelectedLineAnchorPoint({
  anchorSide,
  containerElement,
}: {
  anchorSide: SelectionAnchorSide;
  containerElement: HTMLElement | null;
}): SelectionAnchorPoint | null {
  for (const root of getDiffShadowRoots(containerElement)) {
    const selectedLine = getBoundarySelectedLine(
      Array.from(
        root.querySelectorAll<HTMLElement>("[data-selected-line][data-line]"),
      ),
      anchorSide,
    );
    if (selectedLine !== undefined) {
      return anchorPointFromSelectedLine(selectedLine, anchorSide);
    }
  }

  for (const root of getDiffShadowRoots(containerElement)) {
    const selectedNumber = getBoundarySelectedLine(
      Array.from(
        root.querySelectorAll<HTMLElement>(
          "[data-selected-line][data-column-number]",
        ),
      ),
      anchorSide,
    );
    if (selectedNumber !== undefined) {
      const rect = selectedNumber.getBoundingClientRect();
      return {
        x: rect.right + LINE_SELECTION_MENU_INLINE_OFFSET_PX,
        y: anchorSide === "bottom" ? rect.bottom : rect.top,
      };
    }
  }

  return null;
}

function resolveUtilityButtonAnchorPoint({
  anchorSide,
  containerElement,
}: {
  anchorSide: SelectionAnchorSide;
  containerElement: HTMLElement | null;
}): SelectionAnchorPoint | null {
  for (const root of getDiffShadowRoots(containerElement)) {
    const utilityButton = root.querySelector("[data-utility-button]");
    if (utilityButton === null) {
      continue;
    }
    const rect = utilityButton.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      continue;
    }
    return {
      x: rect.right + LINE_SELECTION_MENU_INLINE_OFFSET_PX,
      y: anchorSide === "bottom" ? rect.bottom : rect.top,
    };
  }
  return null;
}

function areSelectedLineRangesEqual(
  first: SelectedLineRange | null,
  second: SelectedLineRange | null,
) {
  if (first === second) {
    return true;
  }
  if (first === null || second === null) {
    return false;
  }
  return (
    first.start === second.start &&
    first.end === second.end &&
    first.side === second.side &&
    first.endSide === second.endSide
  );
}

function anchorSideFromLineRange(
  range: SelectedLineRange,
): SelectionAnchorSide | null {
  if (range.end > range.start) {
    return "bottom";
  }
  if (range.end < range.start) {
    return "top";
  }
  return null;
}

function anchorSideFromSelectionStart({
  range,
  startRange,
}: {
  range: SelectedLineRange;
  startRange: SelectedLineRange | null;
}): SelectionAnchorSide | null {
  if (startRange === null) {
    return null;
  }
  const startLine = startRange.start;
  const lowerLine = Math.min(range.start, range.end);
  const upperLine = Math.max(range.start, range.end);
  if (startLine <= lowerLine && upperLine > startLine) {
    return "bottom";
  }
  if (startLine >= upperLine && lowerLine < startLine) {
    return "top";
  }
  return null;
}

export function usePierreLineSelectionActions({
  buildFallbackSelectionText,
  buildSelectionText,
  containerRef,
  enabled,
  onSelectionAddToChat,
}: UsePierreLineSelectionActionsArgs): PierreLineSelectionActions {
  const [activeRange, setActiveRange] = useState<SelectedLineRange | null>(
    null,
  );
  const [previewRange, setPreviewRange] = useState<SelectedLineRange | null>(
    null,
  );
  const [activeSelection, setActiveSelection] =
    useState<MessageProseSelection | null>(null);
  const pointerStartPointRef = useRef<SelectionAnchorPoint | null>(null);
  const lastPointerReleaseAnchorRef = useRef<SelectionAnchor | null>(null);
  const lastLineSelectionAnchorRef = useRef<SelectionAnchor | null>(null);
  const lastUtilityAnchorRef = useRef<SelectionAnchor | null>(null);
  const lineSelectionStartRangeRef = useRef<SelectedLineRange | null>(null);
  const currentLineRangeRef = useRef<SelectedLineRange | null>(null);
  const suppressedSelectionEndRangeRef = useRef<SelectedLineRange | null>(null);

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) {
        return;
      }
      const point = anchorPointFromMouseEvent(event);
      if (isGutterUtilityPointerEvent(event)) {
        lastUtilityAnchorRef.current =
          point === null
            ? null
            : {
                point,
                side: lastLineSelectionAnchorRef.current?.side ?? "top",
              };
        return;
      }
      documentPointerReleaseAnchor = null;
      pointerStartPointRef.current = point;
      documentPointerStartPoint = point;
    },
    [enabled],
  );

  const handlePointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || !isGutterUtilityPointerEvent(event)) {
        return;
      }
      const point = anchorPointFromMouseEvent(event);
      lastUtilityAnchorRef.current =
        point === null
          ? null
          : {
              point,
              side: lastLineSelectionAnchorRef.current?.side ?? "top",
            };
    },
    [enabled],
  );

  const handlePointerUpCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) {
        return;
      }
      if (isGutterUtilityPointerEvent(event)) {
        const point = anchorPointFromMouseEvent(event);
        lastUtilityAnchorRef.current =
          point === null
            ? null
            : {
                point,
                side: lastLineSelectionAnchorRef.current?.side ?? "top",
              };
        return;
      }
      const pointerStartPoint =
        pointerStartPointRef.current ?? documentPointerStartPoint;
      pointerStartPointRef.current = null;
      documentPointerStartPoint = null;
      if (pointerStartPoint === null) {
        return;
      }
      const anchor = selectionAnchorFromPointerRelease(
        pointerStartPoint,
        event,
      );
      if (anchor === null) {
        return;
      }
      lastPointerReleaseAnchorRef.current = anchor;
      documentPointerReleaseAnchor = anchor;
      if (currentLineRangeRef.current !== null) {
        lastLineSelectionAnchorRef.current = anchor;
      }
    },
    [enabled],
  );

  useEffect(() => {
    if (!enabled || typeof document === "undefined") {
      return;
    }

    const handleDocumentPointerDown = (event: PointerEvent) => {
      const path = event.composedPath();
      if (isGutterUtilityPath(path)) {
        return;
      }
      const point = anchorPointFromMouseEvent(event);
      documentPointerReleaseAnchor = null;
      pointerStartPointRef.current = point;
      documentPointerStartPoint = point;
    };
    const handleDocumentPointerUp = (event: PointerEvent) => {
      if (isGutterUtilityPath(event.composedPath())) {
        return;
      }
      const pointerStartPoint =
        pointerStartPointRef.current ?? documentPointerStartPoint;
      pointerStartPointRef.current = null;
      documentPointerStartPoint = null;
      if (pointerStartPoint === null) {
        return;
      }
      const anchor = selectionAnchorFromPointerRelease(
        pointerStartPoint,
        event,
      );
      if (anchor === null) {
        return;
      }
      lastPointerReleaseAnchorRef.current = anchor;
      documentPointerReleaseAnchor = anchor;
      if (currentLineRangeRef.current !== null) {
        lastLineSelectionAnchorRef.current = anchor;
      }
    };
    const handleDocumentPointerCancel = () => {
      pointerStartPointRef.current = null;
      documentPointerStartPoint = null;
    };

    document.addEventListener("pointerdown", handleDocumentPointerDown, true);
    document.addEventListener("pointerup", handleDocumentPointerUp, true);
    document.addEventListener(
      "pointercancel",
      handleDocumentPointerCancel,
      true,
    );
    return () => {
      document.removeEventListener(
        "pointerdown",
        handleDocumentPointerDown,
        true,
      );
      document.removeEventListener("pointerup", handleDocumentPointerUp, true);
      document.removeEventListener(
        "pointercancel",
        handleDocumentPointerCancel,
        true,
      );
    };
  }, [enabled]);

  const dismissSelection = useCallback(() => {
    setActiveRange(null);
    setPreviewRange(null);
    setActiveSelection(null);
    currentLineRangeRef.current = null;
    pointerStartPointRef.current = null;
    lastPointerReleaseAnchorRef.current = null;
    lastLineSelectionAnchorRef.current = null;
    lastUtilityAnchorRef.current = null;
    lineSelectionStartRangeRef.current = null;
    documentPointerStartPoint = null;
    documentPointerReleaseAnchor = null;
  }, []);

  const handleGutterUtilityClick = useCallback(
    (range: SelectedLineRange) => {
      if (!enabled) {
        return;
      }
      const containerElement = containerRef.current;
      const selectionText =
        buildSelectionText(range) ??
        buildFallbackSelectionText?.({
          containerElement,
          range,
        }) ??
        "";
      const pointerAnchor =
        lastLineSelectionAnchorRef.current ??
        lastPointerReleaseAnchorRef.current ??
        documentPointerReleaseAnchor;
      const interactionAnchor = pointerAnchor ?? lastUtilityAnchorRef.current;
      const rangeAnchorSide =
        anchorSideFromSelectionStart({
          range,
          startRange: lineSelectionStartRangeRef.current,
        }) ?? anchorSideFromLineRange(range);
      const anchorSide =
        pointerAnchor?.side ??
        rangeAnchorSide ??
        lastUtilityAnchorRef.current?.side ??
        "top";
      const resolvedAnchorPoint =
        resolveSelectedLineAnchorPoint({
          anchorSide,
          containerElement,
        }) ??
        resolveUtilityButtonAnchorPoint({
          anchorSide,
          containerElement,
        }) ??
        interactionAnchor?.point ??
        null;
      const anchor =
        resolvedAnchorPoint === null
          ? interactionAnchor
          : { point: resolvedAnchorPoint, side: anchorSide };
      const selection = buildMenuSelection({
        anchor,
        containerElement,
        text: selectionText,
      });
      if (selection === null) {
        suppressedSelectionEndRangeRef.current = range;
        setActiveRange(null);
        setPreviewRange(null);
        setActiveSelection(null);
        currentLineRangeRef.current = null;
        return;
      }
      suppressedSelectionEndRangeRef.current = null;
      currentLineRangeRef.current = range;
      setActiveRange(range);
      setPreviewRange(range);
      setActiveSelection(selection);
    },
    [buildFallbackSelectionText, buildSelectionText, containerRef, enabled],
  );

  const handleLineSelectionStart = useCallback(
    (range: SelectedLineRange | null) => {
      if (!enabled) {
        return;
      }
      suppressedSelectionEndRangeRef.current = null;
      currentLineRangeRef.current = range;
      lastLineSelectionAnchorRef.current = null;
      lineSelectionStartRangeRef.current = range;
      setActiveRange(null);
      setActiveSelection(null);
      setPreviewRange(range);
    },
    [enabled],
  );

  const handleLineSelectionChange = useCallback(
    (range: SelectedLineRange | null) => {
      if (!enabled) {
        return;
      }
      suppressedSelectionEndRangeRef.current = null;
      currentLineRangeRef.current = range;
      setPreviewRange(range);
    },
    [enabled],
  );

  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      if (!enabled) {
        return;
      }
      if (
        areSelectedLineRangesEqual(
          range,
          suppressedSelectionEndRangeRef.current,
        )
      ) {
        suppressedSelectionEndRangeRef.current = null;
        currentLineRangeRef.current = null;
        setPreviewRange(null);
        return;
      }
      currentLineRangeRef.current = range;
      const pointerAnchor =
        lastPointerReleaseAnchorRef.current ?? documentPointerReleaseAnchor;
      if (range !== null && pointerAnchor !== null) {
        lastLineSelectionAnchorRef.current = pointerAnchor;
      }
      setPreviewRange(range);
    },
    [enabled],
  );

  const handleSelectionAddToChat = useCallback(
    (text: string) => {
      onSelectionAddToChat?.(text);
      dismissSelection();
    },
    [dismissSelection, onSelectionAddToChat],
  );

  const menu = useMemo(
    () =>
      enabled ? (
        <TimelineSelectionMenu
          selection={activeSelection}
          onAddToChat={
            onSelectionAddToChat === undefined
              ? undefined
              : handleSelectionAddToChat
          }
          onDismiss={dismissSelection}
        />
      ) : null,
    [
      activeSelection,
      dismissSelection,
      enabled,
      handleSelectionAddToChat,
      onSelectionAddToChat,
    ],
  );

  return {
    menu,
    onGutterUtilityClick: handleGutterUtilityClick,
    onLineSelectionChange: handleLineSelectionChange,
    onLineSelectionEnd: handleLineSelectionEnd,
    onLineSelectionStart: handleLineSelectionStart,
    onPointerDownCapture: handlePointerDownCapture,
    onPointerMoveCapture: handlePointerMoveCapture,
    onPointerUpCapture: handlePointerUpCapture,
    selectedRange: activeRange ?? previewRange,
  };
}
