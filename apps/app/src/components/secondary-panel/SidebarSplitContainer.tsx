import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useAtomValue } from "jotai";
import { cn } from "@bb/shared-ui/lib/utils";
import { beginSplitDrag, type SplitDropTarget } from "@/lib/split-drag";
import {
  computePaneRects,
  countPanes,
  listPanes,
  MAX_PANES,
  type LayoutNode,
  type SplitLayout,
  type SplitPath,
  type SplitSide,
} from "@/lib/split-layout";
import { dimInactiveSplitsAtom } from "@/lib/split-layout/atoms";
import { createSplitResizeSnapSession } from "@/lib/split-resize-snap";
import { IframeDragGuardOverlay } from "@/lib/iframe-drag-guard";
import { MACOS_APP_REGION_NO_DRAG_CLASS } from "@/lib/bb-desktop";
import { withLocalStorage } from "@/lib/browser-storage";
import {
  PaneContext,
  type PaneContextValue,
} from "@/views/thread-detail/PaneContext";
import {
  createSidebarSplitState,
  focusSidebarPane,
  getSidebarGroupForPane,
  getSidebarTabPlacement,
  isCanonicalSidebarSplitState,
  moveSidebarPaneToSide,
  moveSidebarTab,
  parseSidebarSplitState,
  pruneSidebarSplitStorage,
  reconcileSidebarSplitState,
  removeSidebarSplit,
  reorderSidebarTab,
  replaceSidebarTab,
  resizeSidebarSplit,
  restoreSidebarTabPlacement,
  selectSidebarTab,
  serializeSidebarSplitState,
  setSidebarPaneMaximized,
  sidebarPaneGroupId,
  sidebarSplitStorageKey,
  toggleSidebarPaneMaximize,
  type SidebarSplitState,
  type SidebarTabPlacement,
  type SidebarTabGroup,
} from "./sidebarSplitLayout";
import type { SecondaryPanelTabReorderRequest } from "./secondaryPanelTab";

const PANE_DRAG_ENGAGE_DISTANCE_PX = 7;
const PANE_EDGE_EPSILON = 1e-9;
type SidebarSplitResizeCursor = "col-resize" | "row-resize";

export interface SidebarSplitTabDescriptor {
  id: string;
  label: string;
}

export interface SidebarSplitPaneRenderArgs {
  group: SidebarTabGroup;
  isFocused: boolean;
  isLeftEdge: boolean;
  isMaximized: boolean;
  isTopRow: boolean;
  onBeginTabDrag: (
    tabId: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  onReorderTab: (request: SecondaryPanelTabReorderRequest) => void;
  onFocusPane: () => void;
  onRemoveSplit?: () => void;
  onMoveActiveTabToSide?: (side: SplitSide) => void;
  onSelectTab: (tabId: string) => void;
  onToggleMaximize: () => void;
  paneId: string;
  showOuterControls: boolean;
}

interface SidebarSplitContainerProps {
  activeTabId: string;
  isFullScreen: boolean;
  onActivateTab: (tabId: string) => void;
  onGlobalTabReorder: (request: SecondaryPanelTabReorderRequest) => void;
  onToggleFullScreen: () => void;
  panelStateId: string;
  renderPane: (args: SidebarSplitPaneRenderArgs) => ReactNode;
  tabs: readonly SidebarSplitTabDescriptor[];
}

export function SidebarSplitContainer({
  activeTabId,
  isFullScreen,
  onActivateTab,
  onGlobalTabReorder,
  onToggleFullScreen,
  panelStateId,
  renderPane,
  tabs,
}: SidebarSplitContainerProps) {
  const availableTabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const storageKey = sidebarSplitStorageKey(panelStateId);
  const [initialStorageValue] = useState<string | null>(() =>
    withLocalStorage((storage) => storage.getItem(storageKey), null),
  );
  const [state, setState] = useState<SidebarSplitState>(() => {
    const restored =
      typeof window === "undefined"
        ? createSidebarSplitState(availableTabIds, activeTabId)
        : parseSidebarSplitState(
            initialStorageValue,
            availableTabIds,
            activeTabId,
          );
    return setSidebarPaneMaximized(
      restored,
      isFullScreen ? restored.layout.focusedPaneId : null,
    );
  });
  const stateRef = useRef(state);
  const lastPersistedValueRef = useRef({
    storageKey,
    value: initialStorageValue,
  });
  const previousActiveTabId = useRef(activeTabId);
  const previousAvailableTabIds = useRef(availableTabIds);
  const removedTabPlacements = useRef(new Map<string, SidebarTabPlacement>());
  const previousFullScreen = useRef(isFullScreen);
  const dimsInactiveSplits = useAtomValue(dimInactiveSplitsAtom);
  const [resizeCursor, setResizeCursor] =
    useState<SidebarSplitResizeCursor | null>(null);
  const [resizePreviewLayout, setResizePreviewLayout] =
    useState<SplitLayout | null>(null);
  const paneCount = countPanes(state.layout.root);
  const hasMultiplePanes = paneCount > 1;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const previousExternalActiveTabId = previousActiveTabId.current;
    const previousAvailable = previousAvailableTabIds.current;
    const shouldFollowExternalSelection =
      previousExternalActiveTabId !== activeTabId;
    previousActiveTabId.current = activeTabId;
    previousAvailableTabIds.current = availableTabIds;
    const current = stateRef.current;
    const availableTabIdSet = new Set(availableTabIds);
    for (const tabId of previousAvailable) {
      if (availableTabIdSet.has(tabId)) continue;
      const placement = getSidebarTabPlacement(current, tabId);
      if (placement !== null) {
        removedTabPlacements.current.set(tabId, placement);
      }
    }
    const withActiveTabReplacement =
      shouldFollowExternalSelection &&
      !availableTabIds.includes(previousExternalActiveTabId)
        ? replaceSidebarTab(current, previousExternalActiveTabId, activeTabId)
        : current;
    let reconciled = reconcileSidebarSplitState(
      withActiveTabReplacement,
      availableTabIds,
      activeTabId,
    );
    const previousAvailableTabIdSet = new Set(previousAvailable);
    for (const tabId of availableTabIds) {
      if (previousAvailableTabIdSet.has(tabId)) continue;
      const placement = removedTabPlacements.current.get(tabId);
      if (placement === undefined) continue;
      reconciled = restoreSidebarTabPlacement(reconciled, tabId, placement);
      removedTabPlacements.current.delete(tabId);
    }
    const activePane = shouldFollowExternalSelection
      ? listPanes(reconciled.layout.root).find((pane) =>
          getSidebarGroupForPane(reconciled, pane.paneId)?.tabIds.includes(
            activeTabId,
          ),
        )
      : undefined;
    const next =
      activePane === undefined
        ? reconciled
        : selectSidebarTab(reconciled, activePane.paneId, activeTabId);
    if (next !== current) {
      stateRef.current = next;
      setState(next);
    }
  }, [activeTabId, availableTabIds]);

  useEffect(() => {
    withLocalStorage(
      (storage) =>
        pruneSidebarSplitStorage({
          storage,
          now: Date.now(),
        }),
      undefined,
    );
    lastPersistedValueRef.current = {
      storageKey,
      value: withLocalStorage((storage) => storage.getItem(storageKey), null),
    };
  }, [storageKey]);

  useEffect(() => {
    const persistedValue = isCanonicalSidebarSplitState(
      state,
      availableTabIds,
      activeTabId,
    )
      ? null
      : serializeSidebarSplitState(state);
    const previous = lastPersistedValueRef.current;
    if (
      previous.storageKey === storageKey &&
      previous.value === persistedValue
    ) {
      return;
    }
    try {
      if (persistedValue === null) {
        window.localStorage.removeItem(storageKey);
      } else {
        window.localStorage.setItem(storageKey, persistedValue);
      }
      lastPersistedValueRef.current = { storageKey, value: persistedValue };
    } catch (error) {
      console.warn(
        `[secondary-panel] could not persist split layout for ${panelStateId}; keeping it in memory only`,
        error,
      );
    }
  }, [activeTabId, availableTabIds, panelStateId, state, storageKey]);

  const commitState = useCallback(
    (
      update: (current: SidebarSplitState) => SidebarSplitState,
      activateFocusedTab = false,
    ) => {
      const current = stateRef.current;
      const next = update(current);
      if (next === current) return current;
      stateRef.current = next;
      setState(next);
      if (activateFocusedTab) {
        const focusedGroup = getSidebarGroupForPane(
          next,
          next.layout.focusedPaneId,
        );
        if (focusedGroup !== null && focusedGroup.activeTabId !== activeTabId) {
          onActivateTab(focusedGroup.activeTabId);
        }
      }
      return next;
    },
    [activeTabId, onActivateTab],
  );

  useEffect(() => {
    if (previousFullScreen.current === isFullScreen) return;
    previousFullScreen.current = isFullScreen;
    commitState((current) =>
      setSidebarPaneMaximized(
        current,
        isFullScreen ? current.layout.focusedPaneId : null,
      ),
    );
  }, [commitState, isFullScreen]);

  const selectTab = useCallback(
    (paneId: string, tabId: string) => {
      commitState((current) => selectSidebarTab(current, paneId, tabId));
      if (tabId !== activeTabId) onActivateTab(tabId);
    },
    [activeTabId, commitState, onActivateTab],
  );

  const focusPane = useCallback(
    (paneId: string) => {
      commitState((current) => focusSidebarPane(current, paneId), true);
    },
    [commitState],
  );

  const removeSplit = useCallback(
    (paneId: string) => {
      commitState((current) => removeSidebarSplit(current, paneId), true);
    },
    [commitState],
  );

  const moveActiveTabToSide = useCallback(
    (paneId: string, side: SplitSide) => {
      commitState((current) => {
        const focused = focusSidebarPane(current, paneId);
        const sourceGroup = getSidebarGroupForPane(focused, paneId);
        if (sourceGroup === null) return current;
        if (sourceGroup.tabIds.length > 1) {
          if (countPanes(focused.layout.root) >= MAX_PANES) return focused;
          const moved = moveSidebarTab(
            focused,
            paneId,
            sourceGroup.activeTabId,
            { paneId, zone: side },
            { groupId: nextSidebarSplitGroupId(focused) },
          );
          return isFullScreen
            ? setSidebarPaneMaximized(moved, moved.layout.focusedPaneId)
            : moved;
        }
        const rects = computePaneRects(focused.layout.root);
        const target = listPanes(focused.layout.root)
          .filter((pane) => pane.paneId !== paneId)
          .sort((first, second) => {
            const a = rects.get(first.paneId);
            const b = rects.get(second.paneId);
            if (a === undefined || b === undefined) return 0;
            const edge = (rect: typeof a) => {
              switch (side) {
                case "left":
                  return rect.x;
                case "right":
                  return -(rect.x + rect.w);
                case "top":
                  return rect.y;
                case "bottom":
                  return -(rect.y + rect.h);
              }
            };
            return edge(a) - edge(b);
          })[0];
        return target === undefined
          ? focused
          : moveSidebarPaneToSide(focused, paneId, target.paneId, side);
      }, true);
    },
    [commitState, isFullScreen],
  );

  const toggleMaximizePane = useCallback(
    (paneId: string) => {
      const current = stateRef.current;
      const next = commitState((latest) =>
        toggleSidebarPaneMaximize(latest, paneId),
      );
      if (
        next !== current &&
        (next.maximizedPaneId !== null) !== isFullScreen
      ) {
        onToggleFullScreen();
      }
    },
    [commitState, isFullScreen, onToggleFullScreen],
  );

  const moveTab = useCallback(
    (sourcePaneId: string, tabId: string, target: SplitDropTarget) => {
      const groupId = nextSidebarSplitGroupId(stateRef.current);
      commitState((current) => {
        const moved = moveSidebarTab(current, sourcePaneId, tabId, target, {
          groupId,
        });
        return isFullScreen
          ? setSidebarPaneMaximized(moved, moved.layout.focusedPaneId)
          : moved;
      }, true);
    },
    [commitState, isFullScreen],
  );

  const beginTabDrag = useCallback(
    (
      sourcePaneId: string,
      tabId: string,
      event: ReactPointerEvent<HTMLElement>,
    ) => {
      if (event.button !== 0) return;
      const sourceGroup = getSidebarGroupForPane(state, sourcePaneId);
      const sourceElement = event.currentTarget;
      const targetBoundary = sourceElement.closest<HTMLElement>("aside");
      if (targetBoundary === null) return;
      const chrome = sourceElement.closest<HTMLElement>(
        '[data-testid="thread-secondary-panel-top-chrome"]',
      );
      const chromeRect = chrome?.getBoundingClientRect() ?? null;
      const startX = event.clientX;
      const startY = event.clientY;
      const label = tabs.find((tab) => tab.id === tabId)?.label ?? "Panel tab";
      beginSplitDrag({
        ghostLabel: label,
        sourceEl: sourceElement,
        targetBoundary,
        fallback: {
          paneId: sourcePaneId,
          container: targetBoundary,
        },
        cancelSidebarReorderOnEngage: true,
        shouldEngage: (x, y) => {
          const dx = x - startX;
          const dy = y - startY;
          if (Math.hypot(dx, dy) <= PANE_DRAG_ENGAGE_DISTANCE_PX) return false;
          return (
            Math.abs(dy) > Math.abs(dx) ||
            chromeRect === null ||
            y < chromeRect.top ||
            y > chromeRect.bottom
          );
        },
        decide: (targetPaneId, zone) => {
          if (targetPaneId === sourcePaneId) {
            if (zone === "center" || (sourceGroup?.tabIds.length ?? 0) <= 1) {
              return null;
            }
          }
          if (
            zone !== "center" &&
            (sourceGroup?.tabIds.length ?? 0) > 1 &&
            countPanes(state.layout.root) >= MAX_PANES
          ) {
            return null;
          }
          return {
            zone,
            label: zone === "center" ? "Group tab here" : `Split ${zone}`,
          };
        },
        onDrop: (target) => moveTab(sourcePaneId, tabId, target),
      });
    },
    [moveTab, state, tabs],
  );

  const reorderTab = useCallback(
    (paneId: string, request: SecondaryPanelTabReorderRequest) => {
      commitState((current) =>
        reorderSidebarTab(
          current,
          paneId,
          request.activeTabId,
          request.overTabId,
        ),
      );
      onGlobalTabReorder(request);
    },
    [commitState, onGlobalTabReorder],
  );

  const resize = useCallback(
    (path: SplitPath, childIndex: number, fraction: number) => {
      commitState((current) =>
        resizeSidebarSplit(current, path, childIndex, fraction),
      );
    },
    [commitState],
  );
  const previewResize = useCallback(
    (path: SplitPath, childIndex: number, fraction: number | null) => {
      setResizePreviewLayout(
        fraction === null
          ? null
          : resizeSidebarSplit(stateRef.current, path, childIndex, fraction)
              .layout,
      );
    },
    [],
  );

  const firstPane = listPanes(state.layout.root)[0];
  const moveActiveTabHandler = (paneId: string) => {
    const group = getSidebarGroupForPane(state, paneId);
    const canMove =
      group !== null &&
      (group.tabIds.length > 1 ? paneCount < MAX_PANES : paneCount > 1);
    return canMove
      ? (side: SplitSide) => moveActiveTabToSide(paneId, side)
      : undefined;
  };
  if (!hasMultiplePanes && firstPane !== undefined) {
    const group = getSidebarGroupForPane(state, firstPane.paneId);
    if (group === null) return null;
    // oxlint-disable-next-line react/refs
    return renderPane({
      group,
      isFocused: true,
      isLeftEdge: true,
      isMaximized: isFullScreen,
      isTopRow: true,
      onBeginTabDrag: (tabId, event) =>
        beginTabDrag(firstPane.paneId, tabId, event),
      onReorderTab: (request) => reorderTab(firstPane.paneId, request),
      onFocusPane: () => focusPane(firstPane.paneId),
      onRemoveSplit: undefined,
      onMoveActiveTabToSide: moveActiveTabHandler(firstPane.paneId),
      onSelectTab: (tabId) => selectTab(firstPane.paneId, tabId),
      onToggleMaximize: onToggleFullScreen,
      paneId: firstPane.paneId,
      showOuterControls: true,
    });
  }
  const presentedLayout = resizePreviewLayout ?? state.layout;
  const paneRects = computePaneRects(presentedLayout.root);

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-sidebar-split-container=""
      data-sidebar-split-root-direction={
        presentedLayout.root.type === "split"
          ? presentedLayout.root.dir
          : undefined
      }
    >
      <SidebarSplitTrackTree
        node={presentedLayout.root}
        path={[]}
        maximizedPaneId={state.maximizedPaneId}
        onResize={resize}
        onResizeDragChange={setResizeCursor}
        onPreviewResize={previewResize}
      />
      {listPanes(state.layout.root).map((pane) => {
        const rect = paneRects.get(pane.paneId);
        return rect === undefined ? null : (
          <SidebarSplitLeaf
            key={pane.paneId}
            dimsInactiveSplits={dimsInactiveSplits}
            focusedPaneId={state.layout.focusedPaneId}
            isLeftEdge={rect.x <= PANE_EDGE_EPSILON}
            isRightEdge={rect.x + rect.w >= 1 - PANE_EDGE_EPSILON}
            isTopRow={rect.y <= PANE_EDGE_EPSILON}
            maximizedPaneId={state.maximizedPaneId}
            pane={pane}
            rect={rect}
            renderPane={renderPane}
            state={state}
            onBeginTabDrag={beginTabDrag}
            onFocusPane={focusPane}
            onRemoveSplit={removeSplit}
            onMoveActiveTabToSide={moveActiveTabToSide}
            onReorderTab={reorderTab}
            onSelectTab={selectTab}
            onToggleMaximize={toggleMaximizePane}
          />
        );
      })}
      <IframeDragGuardOverlay
        active={resizeCursor !== null}
        cursor={resizeCursor ?? "col-resize"}
      />
    </div>
  );
}

interface SidebarSplitTrackTreeProps {
  maximizedPaneId: string | null;
  node: LayoutNode;
  onResize: (path: SplitPath, childIndex: number, fraction: number) => void;
  onResizeDragChange: (cursor: SidebarSplitResizeCursor | null) => void;
  onPreviewResize: (
    path: SplitPath,
    childIndex: number,
    fraction: number | null,
  ) => void;
  path: number[];
}

function SidebarSplitTrackTree(props: SidebarSplitTrackTreeProps) {
  if (props.node.type === "pane") {
    return <div className="flex min-h-0 min-w-0 flex-1" />;
  }
  const node = props.node;
  return (
    <div
      data-split-resize-grid-root=""
      className={cn(
        "pointer-events-none flex min-h-0 min-w-0 flex-1",
        node.dir === "row" ? "flex-row" : "flex-col",
      )}
    >
      {node.children.map((child, index) => (
        <Fragment key={sidebarSplitSubtreeKey(child)}>
          {index > 0 ? (
            <SidebarSplitDivider
              boundaryIndex={index}
              childCount={node.children.length}
              dir={node.dir}
              hidden={props.maximizedPaneId !== null}
              onResize={(fraction) =>
                props.onResize(props.path, index - 1, fraction)
              }
              onResizeDragChange={props.onResizeDragChange}
              onPreviewResize={(fraction) =>
                props.onPreviewResize(props.path, index - 1, fraction)
              }
            />
          ) : null}
          <div
            className="flex min-h-0 min-w-0"
            style={{ flex: `${node.sizes[index] ?? 1} 1 0px` }}
          >
            <SidebarSplitTrackTree
              {...props}
              node={child}
              path={[...props.path, index]}
            />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

interface SidebarSplitLeafProps {
  dimsInactiveSplits: boolean;
  focusedPaneId: string;
  isLeftEdge: boolean;
  isRightEdge: boolean;
  isTopRow: boolean;
  maximizedPaneId: string | null;
  onBeginTabDrag: (
    paneId: string,
    tabId: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  onFocusPane: (paneId: string) => void;
  onMoveActiveTabToSide: (paneId: string, side: SplitSide) => void;
  onRemoveSplit: (paneId: string) => void;
  onReorderTab: (
    paneId: string,
    request: SecondaryPanelTabReorderRequest,
  ) => void;
  onSelectTab: (paneId: string, tabId: string) => void;
  onToggleMaximize: (paneId: string) => void;
  pane: Extract<LayoutNode, { type: "pane" }>;
  rect: { h: number; w: number; x: number; y: number };
  renderPane: (args: SidebarSplitPaneRenderArgs) => ReactNode;
  state: SidebarSplitState;
}

function SidebarSplitLeaf(props: SidebarSplitLeafProps) {
  const { pane } = props;
  const groupId = sidebarPaneGroupId(pane);
  const group = groupId === null ? undefined : props.state.groups[groupId];
  if (group === undefined) return null;
  const isFocused = pane.paneId === props.focusedPaneId;
  const isMaximized = pane.paneId === props.maximizedPaneId;
  const isHiddenByMaximize = props.maximizedPaneId !== null && !isMaximized;
  const canMoveActiveTabToSide =
    group.tabIds.length > 1
      ? countPanes(props.state.layout.root) < MAX_PANES
      : countPanes(props.state.layout.root) > 1;
  const showOuterControls =
    isMaximized ||
    (props.maximizedPaneId === null && props.isTopRow && props.isRightEdge);
  const context: PaneContextValue = {
    paneId: pane.paneId,
    isFocused,
    isSplitPane: true,
    secondaryPanelHost: null,
    reservesWindowPanelToggle: showOuterControls,
    onRequestClose: null,
    isMaximized,
    onToggleMaximize: () => props.onToggleMaximize(pane.paneId),
    isBoundedPane: true,
    isTopRow: isMaximized || props.isTopRow,
    ownsWindowTopLeft: false,
    navigateInPane: () => {},
  };
  return (
    <PaneContext.Provider value={context}>
      <div
        onPointerDownCapture={() => props.onFocusPane(pane.paneId)}
        onFocusCapture={() => props.onFocusPane(pane.paneId)}
        aria-hidden={isHiddenByMaximize || undefined}
        style={
          isMaximized
            ? undefined
            : {
                contentVisibility: isHiddenByMaximize ? "hidden" : undefined,
                height: `${props.rect.h * 100}%`,
                left: `${props.rect.x * 100}%`,
                top: `${props.rect.y * 100}%`,
                width: `${props.rect.w * 100}%`,
              }
        }
        className={cn(
          "absolute flex min-h-0 min-w-0 overflow-hidden",
          isHiddenByMaximize && "invisible pointer-events-none",
          isMaximized && "absolute inset-0 z-30",
        )}
        data-split-pane-id={pane.paneId}
        data-focused={isFocused ? "true" : "false"}
        data-maximized={isMaximized ? "true" : undefined}
      >
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sidebar">
          {props.renderPane({
            group,
            isFocused,
            isLeftEdge: isMaximized || props.isLeftEdge,
            isMaximized,
            isTopRow: isMaximized || props.isTopRow,
            onBeginTabDrag: (tabId, event) =>
              props.onBeginTabDrag(pane.paneId, tabId, event),
            onReorderTab: (request) => props.onReorderTab(pane.paneId, request),
            onFocusPane: () => props.onFocusPane(pane.paneId),
            onRemoveSplit: () => props.onRemoveSplit(pane.paneId),
            onMoveActiveTabToSide: canMoveActiveTabToSide
              ? (side) => props.onMoveActiveTabToSide(pane.paneId, side)
              : undefined,
            onSelectTab: (tabId) => props.onSelectTab(pane.paneId, tabId),
            onToggleMaximize: () => props.onToggleMaximize(pane.paneId),
            paneId: pane.paneId,
            showOuterControls,
          })}
        </section>
        <div
          aria-hidden
          data-pane-focus-scrim=""
          className={cn(
            "pointer-events-none absolute inset-0 z-20 transition-colors",
            isFocused || !props.dimsInactiveSplits
              ? "bg-transparent"
              : "bg-background/30",
          )}
        />
      </div>
    </PaneContext.Provider>
  );
}

function SidebarSplitDivider({
  boundaryIndex,
  childCount,
  dir,
  hidden,
  onResize,
  onResizeDragChange,
  onPreviewResize,
}: {
  boundaryIndex: number;
  childCount: number;
  dir: "row" | "col";
  hidden: boolean;
  onResize: (fraction: number) => void;
  onResizeDragChange: (cursor: SidebarSplitResizeCursor | null) => void;
  onPreviewResize: (fraction: number | null) => void;
}) {
  const horizontal = dir === "row";
  const finishResizeRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      finishResizeRef.current?.();
    },
    [],
  );
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      finishResizeRef.current?.();
      const hitTarget = event.currentTarget;
      const divider = hitTarget.parentElement;
      const previous = divider?.previousElementSibling;
      const next = divider?.nextElementSibling;
      if (
        !(divider instanceof HTMLElement) ||
        !(previous instanceof HTMLElement) ||
        !(next instanceof HTMLElement)
      ) {
        return;
      }
      const previousRect = previous.getBoundingClientRect();
      const nextRect = next.getBoundingClientRect();
      const pointerId = event.pointerId;
      const start = horizontal ? previousRect.left : previousRect.top;
      const end = horizontal ? nextRect.right : nextRect.bottom;
      const pointerDownPosition = horizontal ? event.clientX : event.clientY;
      const span = end - start;
      if (span <= 0) return;
      const pair = createSidebarSplitResizePair(previous, next);
      hitTarget.setPointerCapture(pointerId);
      divider.dataset.dragging = "true";
      const snapSession = createSplitResizeSnapSession(
        divider,
        horizontal ? "x" : "y",
        { boundaryIndex, childCount },
      );
      snapSession.resolve({ end, pointer: pointerDownPosition, start });
      let pendingFraction: number | null = null;
      let receivedPointerMove = false;
      let finished = false;
      const applyPointerPosition = (pointerEvent: PointerEvent) => {
        const pointer = horizontal
          ? pointerEvent.clientX
          : pointerEvent.clientY;
        const { fraction } = snapSession.resolve({
          end,
          pointer,
          start,
        });
        pendingFraction = fraction;
        pair.previous.style.flex = `${pair.total * fraction} 1 0px`;
        pair.next.style.flex = `${pair.total * (1 - fraction)} 1 0px`;
        onPreviewResize(fraction);
      };
      const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        receivedPointerMove = true;
        applyPointerPosition(moveEvent);
      };
      const finish = (commit: boolean) => {
        if (finished) return;
        finished = true;
        finishResizeRef.current = null;
        delete divider.dataset.dragging;
        hitTarget.removeEventListener("pointermove", move);
        hitTarget.removeEventListener("pointerup", onUp);
        hitTarget.removeEventListener("pointercancel", cancel);
        hitTarget.removeEventListener("lostpointercapture", lostCapture);
        if (hitTarget.hasPointerCapture?.(pointerId)) {
          hitTarget.releasePointerCapture(pointerId);
        }
        snapSession.clear();
        onResizeDragChange(null);
        onPreviewResize(null);
        if (commit && pendingFraction !== null) {
          onResize(pendingFraction);
          return;
        }
        pair.previous.style.flex = pair.previousFlex;
        pair.next.style.flex = pair.nextFlex;
      };
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        const pointerUpPosition = horizontal
          ? upEvent.clientX
          : upEvent.clientY;
        if (!receivedPointerMove && pointerUpPosition === pointerDownPosition) {
          finish(false);
          return;
        }
        applyPointerPosition(upEvent);
        finish(true);
      };
      const cancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== pointerId) return;
        finish(false);
      };
      const lostCapture = (lostEvent: PointerEvent) => {
        if (lostEvent.pointerId !== pointerId) return;
        finish(false);
      };
      hitTarget.addEventListener("pointermove", move);
      hitTarget.addEventListener("pointerup", onUp);
      hitTarget.addEventListener("pointercancel", cancel);
      hitTarget.addEventListener("lostpointercapture", lostCapture);
      finishResizeRef.current = () => finish(false);
      onResizeDragChange(horizontal ? "col-resize" : "row-resize");
    },
    [
      boundaryIndex,
      childCount,
      horizontal,
      onPreviewResize,
      onResize,
      onResizeDragChange,
    ],
  );
  return (
    <div
      role="separator"
      data-split-resize-grid-boundary={boundaryIndex}
      data-split-resize-grid-count={childCount}
      aria-hidden={hidden || undefined}
      aria-label={
        horizontal
          ? "Resize right panel panes"
          : "Resize stacked right panel panes"
      }
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      className={cn(
        "group relative z-[25] shrink-0 bg-border-seam transition-colors hover:bg-ring/40 data-[dragging]:bg-ring/40",
        MACOS_APP_REGION_NO_DRAG_CLASS,
        "pointer-events-auto",
        hidden && "invisible pointer-events-none",
        horizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
      )}
    >
      <div
        aria-hidden
        onPointerDown={handlePointerDown}
        className={cn(
          "absolute z-10 touch-none bg-transparent",
          horizontal
            ? "-left-1.5 top-0 h-full w-3 cursor-col-resize"
            : "left-0 -top-1.5 h-3 w-full cursor-row-resize",
        )}
      />
    </div>
  );
}

interface SidebarSplitResizePair {
  next: HTMLElement;
  nextFlex: string;
  previous: HTMLElement;
  previousFlex: string;
  total: number;
}

function createSidebarSplitResizePair(
  previous: HTMLElement,
  next: HTMLElement,
): SidebarSplitResizePair {
  const previousGrow = Number.parseFloat(
    window.getComputedStyle(previous).flexGrow,
  );
  const nextGrow = Number.parseFloat(window.getComputedStyle(next).flexGrow);
  return {
    next,
    nextFlex: next.style.flex,
    previous,
    previousFlex: previous.style.flex,
    total:
      Number.isFinite(previousGrow) &&
      Number.isFinite(nextGrow) &&
      previousGrow + nextGrow > 0
        ? previousGrow + nextGrow
        : 1,
  };
}

function nextSidebarSplitGroupId(state: SidebarSplitState): string {
  let sequence = 1;
  while (state.groups[`group-split-${sequence}`] !== undefined) sequence += 1;
  return `group-split-${sequence}`;
}

function sidebarSplitSubtreeKey(node: LayoutNode): string {
  return listPanes(node)
    .map((pane) => `${pane.paneId}:${sidebarPaneGroupId(pane) ?? "unknown"}`)
    .join("|");
}
