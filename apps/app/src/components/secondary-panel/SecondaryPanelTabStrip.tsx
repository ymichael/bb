import {
  type CSSProperties,
  type MouseEventHandler,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import {
  OverflowFade,
  type OverflowFadeTone,
} from "@/components/ui/overflow-fade";
import { TabPill } from "@/components/ui/tab-pill";
import { useDragClickSuppression } from "@/components/ui/use-drag-click-suppression";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  MACOS_APP_REGION_NO_DRAG_CLASS,
  MACOS_WINDOW_NO_DRAG_CLASS,
} from "@/lib/bb-desktop";
import type {
  SecondaryPanelRenderableTab,
  SecondaryPanelTabReorderHandler,
} from "./secondaryPanelTab";

const CHEVRON_SCROLL_STEP_PX = 140;

const TAB_STRIP_SCROLL_BUTTON_CLASS =
  "h-7 w-5 rounded-md p-0 [&_svg]:size-3.5 max-md:pointer-coarse:h-9 max-md:pointer-coarse:w-9 max-md:pointer-coarse:[&_svg]:size-5";

const EDGE_EPSILON_PX = 1;

export const SECONDARY_PANEL_TAB_STRIP_FADE_TONE: OverflowFadeTone = "sidebar";

class InertTouchSensor extends TouchSensor {
  static override setup(): () => void {
    return () => {};
  }
}

interface TabStripOverflowState {
  hasOverflow: boolean;
  canScrollLeft: boolean;
  canScrollRight: boolean;
}

const INITIAL_OVERFLOW_STATE: TabStripOverflowState = {
  hasOverflow: false,
  canScrollLeft: false,
  canScrollRight: false,
};

export interface SecondaryPanelTabStripProps {
  activeTabId: string | null;
  tabs: readonly SecondaryPanelRenderableTab[];
  onBeginTabDrag?: (
    tabId: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  onReorderTab: SecondaryPanelTabReorderHandler;
  usesDesktopChrome: boolean;
  isPanelOpen: boolean;
}

interface SortablePanelTabProps {
  isActive: boolean;
  activeTabRef: RefObject<HTMLDivElement | null>;
  dragDisabled: boolean;
  noDragClass: string | null;
  onBeginTabDrag?: (
    tabId: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  tab: SecondaryPanelRenderableTab;
}

export function SecondaryPanelTabStrip({
  activeTabId,
  tabs,
  onBeginTabDrag,
  onReorderTab,
  usesDesktopChrome,
  isPanelOpen,
}: SecondaryPanelTabStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  const leftScrollButtonRef = useRef<HTMLButtonElement>(null);
  const rightScrollButtonRef = useRef<HTMLButtonElement>(null);
  const [overflow, setOverflow] = useState<TabStripOverflowState>(
    INITIAL_OVERFLOW_STATE,
  );
  const maxScrollLeftRef = useRef(0);
  const hasOverflowRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const {
    beginDragClickSuppression,
    clearDragClickSuppressionSoon,
    consumeDragClickSuppression,
  } = useDragClickSuppression();
  const dragDisabled = tabs.length < 2;
  const mouseSensor = useSensor(MouseSensor, {
    activationConstraint: { distance: 4 },
  });
  const touchSensor = useSensor(
    isPanelOpen && !dragDisabled ? TouchSensor : InertTouchSensor,
    { activationConstraint: { delay: 200, tolerance: 6 } },
  );
  const sensors = useSensors(mouseSensor, touchSensor);
  const tabIds = useMemo(() => tabs.map((tab) => tab.tab.id), [tabs]);
  const draggingTab =
    draggingTabId === null
      ? null
      : (tabs.find((tab) => tab.tab.id === draggingTabId) ?? null);

  const applyEdgeFlags = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport === null) {
      return;
    }
    const maxScrollLeft = maxScrollLeftRef.current;
    const hasOverflow = hasOverflowRef.current;
    const isScrollable = hasOverflow && maxScrollLeft > EDGE_EPSILON_PX;
    const { scrollLeft } = viewport;
    const canScrollLeft = isScrollable && scrollLeft > EDGE_EPSILON_PX;
    const canScrollRight =
      isScrollable && scrollLeft < maxScrollLeft - EDGE_EPSILON_PX;
    setOverflow((prev) =>
      prev.hasOverflow === hasOverflow &&
      prev.canScrollLeft === canScrollLeft &&
      prev.canScrollRight === canScrollRight
        ? prev
        : { hasOverflow, canScrollLeft, canScrollRight },
    );
  }, []);

  const measureCapacity = useCallback(() => {
    const strip = stripRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (strip === null || viewport === null || content === null) {
      return;
    }
    const hasOverflow =
      content.scrollWidth > strip.clientWidth + EDGE_EPSILON_PX;
    hasOverflowRef.current = hasOverflow;
    maxScrollLeftRef.current = hasOverflow
      ? Math.max(0, viewport.scrollWidth - viewport.clientWidth)
      : 0;
    applyEdgeFlags();
  }, [applyEdgeFlags]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) {
      return;
    }
    const handleScroll = () => {
      if (scrollFrameRef.current !== null) {
        return;
      }
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        applyEdgeFlags();
      });
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    const resizeObserver = new ResizeObserver(measureCapacity);
    if (stripRef.current !== null) {
      resizeObserver.observe(stripRef.current);
    }
    resizeObserver.observe(viewport);
    if (contentRef.current !== null) {
      resizeObserver.observe(contentRef.current);
    }
    return () => {
      viewport.removeEventListener("scroll", handleScroll);
      resizeObserver.disconnect();
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [applyEdgeFlags, measureCapacity]);

  useEffect(() => {
    measureCapacity();
  }, [tabs, measureCapacity]);

  useEffect(() => {
    void document.fonts?.ready?.then(() => measureCapacity());
  }, [measureCapacity]);

  useLayoutEffect(() => {
    const activeTabElement = activeTabRef.current;
    if (activeTabElement === null) {
      return;
    }
    activeTabElement.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeTabId, overflow.hasOverflow]);

  useLayoutEffect(() => {
    const focusedElement = document.activeElement;
    const activeTabButton =
      activeTabRef.current?.querySelector<HTMLButtonElement>("button") ?? null;
    if (
      !overflow.canScrollLeft &&
      focusedElement === leftScrollButtonRef.current
    ) {
      (overflow.canScrollRight
        ? rightScrollButtonRef.current
        : activeTabButton
      )?.focus();
      return;
    }
    if (
      !overflow.canScrollRight &&
      focusedElement === rightScrollButtonRef.current
    ) {
      (overflow.canScrollLeft
        ? leftScrollButtonRef.current
        : activeTabButton
      )?.focus();
    }
  }, [overflow.canScrollLeft, overflow.canScrollRight]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      if (
        event.deltaY === 0 ||
        Math.abs(event.deltaX) >= Math.abs(event.deltaY)
      ) {
        return;
      }
      const maxScrollLeft = maxScrollLeftRef.current;
      if (maxScrollLeft <= EDGE_EPSILON_PX) {
        return;
      }
      const { scrollLeft } = viewport;
      const canScrollInWheelDirection =
        event.deltaY > 0
          ? scrollLeft < maxScrollLeft - EDGE_EPSILON_PX
          : scrollLeft > EDGE_EPSILON_PX;
      if (!canScrollInWheelDirection) {
        return;
      }
      viewport.scrollLeft = Math.min(
        maxScrollLeft,
        Math.max(0, scrollLeft + event.deltaY),
      );
      event.preventDefault();
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", handleWheel);
    };
  }, []);

  const scrollByStep = useCallback((direction: -1 | 1) => {
    viewportRef.current?.scrollBy({
      left: direction * CHEVRON_SCROLL_STEP_PX,
      behavior: "smooth",
    });
  }, []);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      setDraggingTabId(String(event.active.id));
      beginDragClickSuppression();
    },
    [beginDragClickSuppression],
  );
  const handleDragCancel = useCallback(() => {
    setDraggingTabId(null);
    clearDragClickSuppressionSoon();
  }, [clearDragClickSuppressionSoon]);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingTabId(null);
      clearDragClickSuppressionSoon();
      if (!event.over) {
        return;
      }
      const activeTabId = String(event.active.id);
      const overTabId = String(event.over.id);
      if (activeTabId === overTabId) {
        return;
      }
      onReorderTab({ activeTabId, overTabId });
    },
    [clearDragClickSuppressionSoon, onReorderTab],
  );
  const handleClickCapture = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      if (!consumeDragClickSuppression()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [consumeDragClickSuppression],
  );

  const noDragClass = usesDesktopChrome ? MACOS_WINDOW_NO_DRAG_CLASS : null;
  const chevronNoDragClass = usesDesktopChrome
    ? MACOS_APP_REGION_NO_DRAG_CLASS
    : null;
  const dndTabs = useMemo(
    () => (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={tabIds}
          strategy={horizontalListSortingStrategy}
        >
          {tabs.map((tab) => (
            <SortablePanelTab
              key={tab.tab.id}
              activeTabRef={activeTabRef}
              dragDisabled={dragDisabled}
              isActive={tab.tab.id === activeTabId}
              noDragClass={noDragClass}
              onBeginTabDrag={onBeginTabDrag}
              tab={tab}
            />
          ))}
        </SortableContext>
        {}
        {createPortal(
          <DragOverlay className="cursor-grabbing">
            {draggingTab === null ? null : (
              <PanelTab
                isActive={draggingTab.tab.id === activeTabId}
                tab={draggingTab}
              />
            )}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    ),
    [
      sensors,
      handleDragStart,
      handleDragCancel,
      handleDragEnd,
      tabIds,
      tabs,
      dragDisabled,
      noDragClass,
      onBeginTabDrag,
      draggingTab,
      activeTabId,
    ],
  );

  return (
    <div
      ref={stripRef}
      data-testid="secondary-panel-tab-strip"
      className="group relative flex min-w-0 items-center"
    >
      <TabStripScrollButton
        buttonRef={leftScrollButtonRef}
        direction="left"
        hasOverflow={overflow.hasOverflow}
        canScroll={overflow.canScrollLeft}
        className={chevronNoDragClass}
        onClick={() => scrollByStep(-1)}
      />
      <div data-secondary-panel-tab-scroll-region className="relative min-w-0">
        {}
        <OverflowFade
          placement="left"
          tone={SECONDARY_PANEL_TAB_STRIP_FADE_TONE}
          className={cn(
            "z-10",
            overflow.canScrollLeft ? "opacity-100" : "opacity-0",
          )}
        />
        <OverflowFade
          placement="right"
          tone={SECONDARY_PANEL_TAB_STRIP_FADE_TONE}
          className={cn(
            "z-10",
            overflow.canScrollRight ? "opacity-100" : "opacity-0",
          )}
        />
        <div
          ref={viewportRef}
          onClickCapture={handleClickCapture}
          className={cn(
            "no-scrollbar min-w-0 overflow-x-auto overflow-y-hidden",
            usesDesktopChrome && MACOS_APP_REGION_NO_DRAG_CLASS,
          )}
        >
          <div
            ref={contentRef}
            data-secondary-panel-tab-content
            className="flex w-max items-center gap-1"
          >
            {dndTabs}
          </div>
        </div>
      </div>
      <TabStripScrollButton
        buttonRef={rightScrollButtonRef}
        direction="right"
        hasOverflow={overflow.hasOverflow}
        canScroll={overflow.canScrollRight}
        className={chevronNoDragClass}
        onClick={() => scrollByStep(1)}
      />
    </div>
  );
}

function SortablePanelTab({
  activeTabRef,
  dragDisabled,
  isActive,
  noDragClass,
  onBeginTabDrag,
  tab,
}: SortablePanelTabProps) {
  const { isDragging, listeners, setNodeRef, transform, transition } =
    useSortable({
      id: tab.tab.id,
      disabled: dragDisabled,
    });
  const { onPointerDown: sortablePointerDown, ...sortableListeners } =
    listeners ?? {};
  const setTabRef = useCallback(
    (element: HTMLDivElement | null) => {
      setNodeRef(element);
      if (isActive) {
        activeTabRef.current = element;
      }
    },
    [activeTabRef, isActive, setNodeRef],
  );
  const style = useMemo<CSSProperties>(
    () => ({
      transform: CSS.Translate.toString(transform),
      transition,
    }),
    [transform, transition],
  );

  return (
    <div
      ref={setTabRef}
      style={style}
      className={cn(
        "shrink-0",
        !dragDisabled && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40",
        noDragClass,
      )}
      onPointerDown={(event) => {
        onBeginTabDrag?.(tab.tab.id, event);
        sortablePointerDown?.(event);
      }}
      {...sortableListeners}
    >
      <PanelTab tab={tab} isActive={isActive} />
    </div>
  );
}

interface TabStripScrollButtonProps {
  buttonRef: RefObject<HTMLButtonElement | null>;
  direction: "left" | "right";
  hasOverflow: boolean;
  canScroll: boolean;
  className: string | null;
  onClick: () => void;
}

function TabStripScrollButton({
  buttonRef,
  direction,
  hasOverflow,
  canScroll,
  className,
  onClick,
}: TabStripScrollButtonProps) {
  const label = direction === "left" ? "Scroll tabs left" : "Scroll tabs right";
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="ghost"
      size="sm"
      tabIndex={canScroll ? 0 : -1}
      aria-hidden={!canScroll}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "z-20 shrink-0 bg-sidebar text-muted-foreground shadow-none hover:bg-surface-raised-solid hover:text-foreground focus-visible:bg-sidebar",
        hasOverflow
          ? TAB_STRIP_SCROLL_BUTTON_CLASS
          : "h-7 w-0 overflow-hidden p-0 max-md:pointer-coarse:h-9",
        "transition-opacity",
        canScroll
          ? "pointer-events-auto opacity-100"
          : "pointer-events-none opacity-0",
        className,
      )}
    >
      <Icon name={direction === "left" ? "ChevronLeft" : "ChevronRight"} />
    </Button>
  );
}

function PanelTab({
  tab,
  isActive,
}: {
  tab: SecondaryPanelRenderableTab;
  isActive: boolean;
}) {
  const title =
    tab.statusLabel === null ? tab.label : `${tab.label} (${tab.statusLabel})`;
  return (
    <TabPill
      label={tab.label}
      leadingVisual={tab.leadingVisual}
      secondaryLabel={tab.statusLabel === null ? null : `(${tab.statusLabel})`}
      title={title}
      isActive={isActive}
      onSelect={tab.onSelect}
      labelMaxWidthClass="max-w-[160px]"
      enlargeCloseTargetOnCoarsePointer={
        tab.tab.kind === "workspace-file-preview" ||
        tab.tab.kind === "host-file-preview" ||
        tab.tab.kind === "thread-storage-file-preview"
      }
      closeAction={
        tab.isPinned
          ? null
          : {
              onClose: tab.onClose,
              closeLabel: `Close ${tab.label}`,
            }
      }
    />
  );
}
