import { cn } from "@bb/shared-ui/lib/utils";
import { PANE_FOCUS_APP_COMMAND_IDS } from "@bb/domain";
import { useAtom, useAtomValue, useStore } from "jotai";
import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useNavigate } from "react-router-dom";
import { useRouteState } from "@/hooks/useRouteState";
import {
  getThreadRoutePath,
  type ThreadRoutePathArgs,
} from "@/lib/route-paths";
import { useIsMutating } from "@tanstack/react-query";
import { BbHttpError } from "@/lib/sdk";
import { useThread } from "@/hooks/queries/thread-queries";
import { useSplitWorkspaceActive } from "@/hooks/useSplitWorkspaceActive";
import {
  dimInactiveSplitsAtom,
  maximizedPaneIdAtom,
  splitLayoutAtom,
} from "@/lib/split-layout/atoms";
import {
  computePaneRects,
  countPanes,
  findPane,
  listPanes,
  movePane,
  removePane,
  replacePaneContent,
  resizeSplit,
  setFocus,
  swapPanes,
} from "@/lib/split-layout";
import { createSplitResizeSnapSession } from "@/lib/split-resize-snap";
import type {
  LayoutNode,
  PaneContent,
  PaneNode,
  SplitLayout,
  SplitPath,
  SplitSide,
} from "@/lib/split-layout";
import {
  beginSplitDrag,
  decidePaneDrop,
  SPLIT_PANE_DATA_ATTR,
} from "@/lib/split-drag";
import {
  useAppCommandContext,
  useAppCommandHandler,
  useIndexedAppCommandHandlers,
} from "@/components/commands/AppCommandProvider";
import {
  PaneContext,
  createPaneSecondaryPanelRegistry,
  useOptionalPaneContext,
  type PaneContextValue,
  type PaneSecondaryPanelRegistration,
  type PaneSecondaryPanelRegistry,
} from "./PaneContext";
import { ThreadDetailView } from "./ThreadDetailView";
import { RootComposeView } from "@/views/RootComposeView";
import { PluginPanelView } from "@/views/PluginPanelView";
import {
  AppPageHeader,
  HEADER_ICON_BUTTON_CLASS,
  HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
} from "@/components/layout/AppPageHeader";
import { AppBreadcrumbs } from "@/components/layout/AppBreadcrumbs";
import { resourceRouteLabelAtom } from "@/components/layout/resourceRouteLabelAtom";
import { resolveAutomationBreadcrumbs } from "@/components/tools/tools-navigation";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { usePluginNavPanelChrome } from "@/lib/plugin-nav-panel-chrome";
import {
  PluginPanelHeaderActions,
  PluginPanelHeaderCenter,
} from "@/components/plugin/PluginPanelHeader";
import { getAdjacentPaneId } from "./splitPaneCommands";
import {
  applyThreadPaneActionToLayout,
  createSinglePaneLayout,
  focusedPaneRoute,
  paneContentRoute,
  reconcileLayoutForContent,
  threadPaneContent,
} from "./splitThreadNavigation";
import { ThreadDetailWorkerPoolProvider } from "./ThreadDetailWorkerPoolProvider";
import {
  getBbDesktopInfo,
  MACOS_WINDOW_NO_DRAG_CLASS,
  shouldUseMacosDesktopChrome,
} from "@/lib/bb-desktop";
import { SplitWorkspaceSecondaryPanelHost } from "./SplitWorkspaceSecondaryPanelHost";
import { SecondaryPanelHostLayoutContext } from "@/components/secondary-panel/SecondaryPanelHostLayoutContext";
import {
  CONTEXT_INACTIVE_TEXT_CLASS,
  CONTEXT_SELECTION_SURFACE_CLASS,
} from "@/components/ui/context-selection";
import { PaneMaximizeButton } from "./PaneMaximizeButton";
import { wsManager } from "@/lib/ws";

const LazyPluginPanelRightPanelHost = lazy(() =>
  import("@/components/plugin/PluginPanelRightPanelHost").then(
    ({ PluginPanelRightPanelHost }) => ({ default: PluginPanelRightPanelHost }),
  ),
);

const PLUGIN_GUIDE_PLUGIN_ID = "plugin-api-docs";
const PLUGIN_GUIDE_PANEL_PATH = "plugin-api";

const LazyPluginDetailPaneView = lazy(() =>
  import("@/views/ToolsView").then(({ PluginDetailPaneView }) => ({
    default: PluginDetailPaneView,
  })),
);

function PluginDetailPaneView({ pluginId }: { pluginId: string }) {
  return (
    <Suspense fallback={null}>
      <LazyPluginDetailPaneView pluginId={pluginId} />
    </Suspense>
  );
}

function PluginPagePanelHost({
  children,
  ...props
}: {
  children: ReactNode;
  flushPageInsets?: boolean;
  paneId?: string;
  panelPath: string;
  pluginId: string;
  subPath: string;
}) {
  return (
    <Suspense fallback={null}>
      <LazyPluginPanelRightPanelHost
        key={`${props.pluginId}/${props.panelPath}`}
        {...props}
        pluginDetailTabsEnabled={
          props.pluginId === PLUGIN_GUIDE_PLUGIN_ID &&
          props.panelPath === PLUGIN_GUIDE_PANEL_PATH
        }
      >
        {children}
      </LazyPluginPanelRightPanelHost>
    </Suspense>
  );
}

const PANE_DRAG_ENGAGE_DISTANCE_PX = 7;

type BeginPaneDrag = (
  paneId: string,
  event: ReactPointerEvent,
  label: string,
) => void;

const EMPTY_PATH: SplitPath = [];

type NavigateInPane = (paneId: string, thread: ThreadRoutePathArgs) => void;

interface SplitThreadAreaProps {
  routeContent?: PaneContent;
}

interface PreservedScrollPosition {
  left: number;
  top: number;
}

function usePreservedSplitScrollPositions(maximizedPaneId: string | null) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const positionsRef = useRef(new Map<HTMLElement, PreservedScrollPosition>());
  const previousMaximizedPaneIdRef = useRef(maximizedPaneId);

  const captureVisibleScrollPositions = useCallback(() => {
    const workspace = workspaceRef.current;
    if (workspace === null) {
      return;
    }
    for (const pane of workspace.querySelectorAll<HTMLElement>(
      `[${SPLIT_PANE_DATA_ATTR}]:not([aria-hidden="true"])`,
    )) {
      for (const element of pane.querySelectorAll<HTMLElement>("*")) {
        if (element.scrollLeft === 0 && element.scrollTop === 0) {
          positionsRef.current.delete(element);
          continue;
        }
        positionsRef.current.set(element, {
          left: element.scrollLeft,
          top: element.scrollTop,
        });
      }
    }
  }, []);

  useLayoutEffect(() => {
    if (previousMaximizedPaneIdRef.current === maximizedPaneId) {
      return;
    }
    previousMaximizedPaneIdRef.current = maximizedPaneId;

    const restore = (): boolean => {
      const workspace = workspaceRef.current;
      let corrected = false;
      for (const [element, position] of positionsRef.current) {
        if (workspace === null || !workspace.contains(element)) {
          positionsRef.current.delete(element);
          continue;
        }
        if (
          element.scrollLeft === position.left &&
          element.scrollTop === position.top
        ) {
          continue;
        }
        element.scrollLeft = position.left;
        element.scrollTop = position.top;
        corrected = true;
      }
      return corrected;
    };

    restore();
    let frame: number | null = null;
    let framesRemaining = 5;
    const restoreUntilSettled = () => {
      const corrected = restore();
      framesRemaining -= 1;
      frame =
        corrected && framesRemaining > 0
          ? window.requestAnimationFrame(restoreUntilSettled)
          : null;
    };
    frame = window.requestAnimationFrame(restoreUntilSettled);
    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [maximizedPaneId]);

  return { captureVisibleScrollPositions, workspaceRef };
}

export function SplitThreadArea(props: SplitThreadAreaProps = {}) {
  return (
    <ThreadDetailWorkerPoolProvider>
      <SplitThreadAreaContent {...props} />
    </ThreadDetailWorkerPoolProvider>
  );
}

function SplitThreadAreaContent({ routeContent }: SplitThreadAreaProps) {
  const { projectId, threadId } = useRouteState();
  const splitWorkspaceActive = useSplitWorkspaceActive();
  const navigate = useNavigate();
  const store = useStore();
  const [storedLayout, setLayout] = useAtom(splitLayoutAtom);
  const dimsInactiveSplits = useAtomValue(dimInactiveSplitsAtom);
  const [maximizedPaneId, setMaximizedPaneIdAtom] =
    useAtom(maximizedPaneIdAtom);
  const secondaryPanelRegistry = useMemo(
    () => createPaneSecondaryPanelRegistry(),
    [],
  );

  const routeThread = useMemo<ThreadRoutePathArgs | null>(
    () => (projectId && threadId ? { projectId, threadId } : null),
    [projectId, threadId],
  );
  const currentContent = useMemo<PaneContent | null>(
    () => routeContent ?? (routeThread ? threadPaneContent(routeThread) : null),
    [routeContent, routeThread],
  );

  useEffect(() => {
    if (currentContent === null) {
      return;
    }
    setLayout((previous) =>
      reconcileLayoutForContent(previous, currentContent),
    );
  }, [currentContent, setLayout]);

  const layout: SplitLayout | null =
    storedLayout ??
    (currentContent?.kind === "thread" && routeThread
      ? createSinglePaneLayout(routeThread)
      : currentContent
        ? reconcileLayoutForContent(null, currentContent)
        : null);
  const panes = layout === null ? [] : listPanes(layout.root);
  const isSplitActive = splitWorkspaceActive && panes.length > 1;
  const maximizedPane =
    layout !== null && maximizedPaneId !== null
      ? findPane(layout.root, maximizedPaneId)
      : null;
  const effectiveMaximizedPaneId =
    layout !== null &&
    countPanes(layout.root) > 1 &&
    maximizedPaneId !== null &&
    maximizedPane !== null
      ? maximizedPaneId
      : null;
  const {
    captureVisibleScrollPositions,
    workspaceRef: preservedScrollWorkspaceRef,
  } = usePreservedSplitScrollPositions(effectiveMaximizedPaneId);
  const setMaximizedPaneId = useCallback(
    (next: SetStateAction<string | null>) => {
      captureVisibleScrollPositions();
      setMaximizedPaneIdAtom(next);
    },
    [captureVisibleScrollPositions, setMaximizedPaneIdAtom],
  );

  useEffect(
    () =>
      wsManager.onThreadPaneAction((signal) => {
        const current = store.get(splitLayoutAtom);
        if (current === null) {
          return;
        }
        const previousMaximizedPaneId = store.get(maximizedPaneIdAtom);
        const next = applyThreadPaneActionToLayout(
          current,
          previousMaximizedPaneId,
          { projectId: signal.projectId, threadId: signal.threadId },
          signal.action,
        );
        if (next.layout !== current) {
          store.set(splitLayoutAtom, next.layout);
          const route = focusedPaneRoute(next.layout);
          if (route !== null) {
            navigate(route, { replace: true });
          }
        }
        if (next.maximizedPaneId !== previousMaximizedPaneId) {
          setMaximizedPaneId(next.maximizedPaneId);
        }
        if (next.dimInactiveSplits !== null) {
          store.set(dimInactiveSplitsAtom, next.dimInactiveSplits);
        }
      }),
    [navigate, setMaximizedPaneId, store],
  );

  useEffect(() => {
    if (maximizedPaneId === null) return;
    if (
      layout === null ||
      countPanes(layout.root) < 2 ||
      maximizedPane === null
    ) {
      setMaximizedPaneId(null);
      return;
    }
    if (layout.focusedPaneId !== maximizedPaneId) {
      setMaximizedPaneId(layout.focusedPaneId);
    }
  }, [layout, maximizedPane, maximizedPaneId, setMaximizedPaneId]);

  const navigateInPane = useCallback<NavigateInPane>(
    (paneId, thread) => {
      setLayout((previous) =>
        previous === null
          ? previous
          : replacePaneContent(previous, paneId, threadPaneContent(thread)),
      );
      navigate(getThreadRoutePath(thread));
    },
    [navigate, setLayout],
  );

  const focusPane = useCallback(
    (paneId: string) => {
      if (layout === null || layout.focusedPaneId === paneId) {
        return;
      }
      const pane = findPane(layout.root, paneId);
      setLayout(setFocus(layout, paneId));
      if (maximizedPaneId !== null) {
        setMaximizedPaneId(paneId);
      }
      if (pane !== null) {
        navigate(paneContentRoute(pane.content), { replace: true });
      }
    },
    [layout, maximizedPaneId, navigate, setLayout, setMaximizedPaneId],
  );

  const closePane = useCallback(
    (paneId: string) => {
      if (layout === null) {
        return;
      }
      const next = removePane(layout, paneId);
      if (next === layout) {
        return;
      }
      setLayout(next);
      if (maximizedPaneId === paneId) {
        setMaximizedPaneId(null);
      }
      if (next.focusedPaneId !== layout.focusedPaneId) {
        const route = focusedPaneRoute(next);
        if (route !== null) {
          navigate(route, { replace: true });
        }
      }
    },
    [layout, maximizedPaneId, navigate, setLayout, setMaximizedPaneId],
  );

  const toggleMaximizePane = useCallback(
    (paneId: string) => {
      const current = store.get(splitLayoutAtom);
      const pane = current === null ? null : findPane(current.root, paneId);
      if (current === null || countPanes(current.root) < 2 || pane === null) {
        return;
      }
      if (current.focusedPaneId !== paneId) {
        const next = setFocus(current, paneId);
        store.set(splitLayoutAtom, next);
        const route = focusedPaneRoute(next);
        if (route !== null) navigate(route, { replace: true });
      }
      setMaximizedPaneId((previous) => (previous === paneId ? null : paneId));
    },
    [navigate, setMaximizedPaneId, store],
  );

  const movePaneToSide = useCallback(
    (paneId: string, side: SplitSide) => {
      const current = store.get(splitLayoutAtom);
      if (current === null || countPanes(current.root) < 2) return;

      const rects = computePaneRects(current.root);
      const candidates = listPanes(current.root).filter(
        (pane) => pane.paneId !== paneId,
      );
      const edgePosition = (candidateId: string) => {
        const rect = rects.get(candidateId);
        if (rect === undefined) return 0;
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
      const target = candidates.sort(
        (first, second) =>
          edgePosition(first.paneId) - edgePosition(second.paneId),
      )[0];
      if (target === undefined) return;

      const next = movePane(current, paneId, target.paneId, side);
      if (next === current) return;
      store.set(splitLayoutAtom, next);
      const route = focusedPaneRoute(next);
      if (route !== null) navigate(route, { replace: true });
    },
    [navigate, store],
  );

  const resize = useCallback(
    (splitPath: SplitPath, childIndex: number, fraction: number) => {
      setLayout((previous) =>
        previous === null
          ? previous
          : resizeSplit(previous, splitPath, childIndex, fraction),
      );
    },
    [setLayout],
  );

  const pruneStalePane = useCallback(
    (paneId: string) => {
      const current = store.get(splitLayoutAtom);
      if (current === null) {
        return;
      }
      const next = removePane(current, paneId);
      if (next === current) {
        return;
      }
      store.set(splitLayoutAtom, next);
      if (maximizedPaneId === paneId) {
        setMaximizedPaneId(null);
      }
      if (next.focusedPaneId !== current.focusedPaneId) {
        const route = focusedPaneRoute(next);
        if (route !== null) {
          navigate(route, { replace: true });
        }
      }
    },
    [maximizedPaneId, navigate, setMaximizedPaneId, store],
  );

  const beginPaneDrag = useCallback<BeginPaneDrag>(
    (paneId, event, label) => {
      const startLayout = store.get(splitLayoutAtom);
      if (startLayout === null || countPanes(startLayout.root) < 2) {
        return;
      }
      const restoreMaximizeAfterDrag =
        store.get(maximizedPaneIdAtom) === paneId;
      const sourceEl =
        event.currentTarget instanceof Element
          ? event.currentTarget.closest<HTMLElement>(
              `[${SPLIT_PANE_DATA_ATTR}]`,
            )
          : null;
      const startX = event.clientX;
      const startY = event.clientY;
      beginSplitDrag({
        ghostLabel: label,
        sourceEl,
        shouldEngage: (x, y) =>
          Math.hypot(x - startX, y - startY) > PANE_DRAG_ENGAGE_DISTANCE_PX,
        onEngage: restoreMaximizeAfterDrag
          ? () => setMaximizedPaneId(null)
          : undefined,
        onEnd: restoreMaximizeAfterDrag
          ? () => {
              const current = store.get(splitLayoutAtom);
              if (
                current !== null &&
                findPane(current.root, current.focusedPaneId) !== null
              ) {
                setMaximizedPaneId(current.focusedPaneId);
              }
            }
          : undefined,
        decide: (targetPaneId, zone) =>
          decidePaneDrop({ zone, isSelf: targetPaneId === paneId }),
        onDrop: (target) => {
          const current = store.get(splitLayoutAtom);
          if (current === null) {
            return;
          }
          const next =
            target.zone === "center"
              ? swapPanes(current, paneId, target.paneId)
              : movePane(current, paneId, target.paneId, target.zone);
          if (next === current) {
            return;
          }
          store.set(splitLayoutAtom, next);
          const route = focusedPaneRoute(next);
          if (route !== null) {
            navigate(route, { replace: true });
          }
        },
      });
    },
    [navigate, setMaximizedPaneId, store],
  );

  if (!splitWorkspaceActive || layout === null || currentContent === null) {
    return currentContent ? (
      <StandalonePaneContent
        content={currentContent}
        paneId={layout?.focusedPaneId}
      />
    ) : null;
  }

  const commandHandlers = (
    <SplitPaneCommandHandlers
      closePane={closePane}
      focusPane={focusPane}
      isSplitActive={isSplitActive}
      layout={layout}
      maximizedPaneId={effectiveMaximizedPaneId}
      panes={panes}
      toggleMaximizePane={toggleMaximizePane}
    />
  );

  const firstPane = panes[0];
  if (panes.length === 1 && firstPane !== undefined) {
    return (
      <>
        {commandHandlers}
        <WorkspacePaneContent
          content={firstPane.content}
          paneId={firstPane.paneId}
          isFocused
          isSplitPane={false}
          secondaryPanelRegistry={null}
          reservesWindowPanelToggle={false}
          onRequestClose={null}
          isMaximized={false}
          onToggleMaximize={null}
          isBoundedPane={false}
          isTopRow
          ownsWindowTopLeft
          onNavigateInPane={navigateInPane}
        />
      </>
    );
  }

  return (
    <>
      {commandHandlers}
      {}
      <div
        ref={preservedScrollWorkspaceRef}
        className="relative -m-4 flex min-h-0 min-w-0 flex-1 overflow-hidden md:-m-5"
      >
        <SplitWorkspaceSecondaryPanelHost
          focusedPaneId={effectiveMaximizedPaneId ?? layout.focusedPaneId}
          isPaneMaximized={effectiveMaximizedPaneId !== null}
          registry={secondaryPanelRegistry}
        >
          <SplitTree
            node={layout.root}
            path={EMPTY_PATH}
            isTopRow
            isLeftEdge
            isRightEdge
            dimsInactiveSplits={dimsInactiveSplits}
            focusedPaneId={effectiveMaximizedPaneId ?? layout.focusedPaneId}
            maximizedPaneId={effectiveMaximizedPaneId}
            secondaryPanelRegistry={secondaryPanelRegistry}
            onFocusPane={focusPane}
            onClosePane={closePane}
            onToggleMaximizePane={toggleMaximizePane}
            onMovePaneToSide={movePaneToSide}
            onResize={resize}
            onNavigateInPane={navigateInPane}
            onBeginPaneDrag={beginPaneDrag}
            onPruneStalePane={pruneStalePane}
          />
        </SplitWorkspaceSecondaryPanelHost>
      </div>
    </>
  );
}

interface SplitPaneCommandHandlersProps {
  closePane: (paneId: string) => void;
  focusPane: (paneId: string) => void;
  isSplitActive: boolean;
  layout: SplitLayout;
  maximizedPaneId: string | null;
  panes: readonly PaneNode[];
  toggleMaximizePane: (paneId: string) => void;
}

function SplitPaneCommandHandlers({
  closePane,
  focusPane,
  isSplitActive,
  layout,
  maximizedPaneId,
  panes,
  toggleMaximizePane,
}: SplitPaneCommandHandlersProps) {
  useAppCommandContext("splitActive", isSplitActive);
  useAppCommandHandler("pane.focus.previous", () => {
    if (!isSplitActive) return false;
    const paneId = getAdjacentPaneId(panes, layout.focusedPaneId, -1);
    if (paneId !== null) focusPane(paneId);
    return true;
  });
  useAppCommandHandler("pane.focus.next", () => {
    if (!isSplitActive) return false;
    const paneId = getAdjacentPaneId(panes, layout.focusedPaneId, 1);
    if (paneId !== null) focusPane(paneId);
    return true;
  });
  useIndexedAppCommandHandlers(PANE_FOCUS_APP_COMMAND_IDS, (index) => {
    if (!isSplitActive) return false;
    const paneId = panes[index]?.paneId ?? null;
    if (paneId !== null) focusPane(paneId);
    return true;
  });
  useAppCommandHandler("pane.close", () => {
    if (!isSplitActive) return false;
    closePane(layout.focusedPaneId);
    return true;
  });
  useAppCommandHandler("pane.maximize.toggle", () => {
    if (!isSplitActive) return false;
    toggleMaximizePane(maximizedPaneId ?? layout.focusedPaneId);
    return true;
  });
  return null;
}

interface SplitTreeProps {
  node: LayoutNode;
  path: SplitPath;
  dimsInactiveSplits: boolean;
  isTopRow: boolean;
  isLeftEdge: boolean;
  isRightEdge: boolean;
  focusedPaneId: string;
  maximizedPaneId: string | null;
  secondaryPanelRegistry: PaneSecondaryPanelRegistry;
  onFocusPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onToggleMaximizePane: (paneId: string) => void;
  onMovePaneToSide: (paneId: string, side: SplitSide) => void;
  onResize: (
    splitPath: SplitPath,
    childIndex: number,
    fraction: number,
  ) => void;
  onNavigateInPane: NavigateInPane;
  onBeginPaneDrag: BeginPaneDrag;
  onPruneStalePane: (paneId: string) => void;
}

function SplitTree(props: SplitTreeProps) {
  const { node, path, isTopRow, isLeftEdge, isRightEdge, focusedPaneId } =
    props;

  if (node.type === "pane") {
    const isFocused = node.paneId === focusedPaneId;
    const isMaximized = node.paneId === props.maximizedPaneId;
    const isHiddenByMaximize = props.maximizedPaneId !== null && !isMaximized;
    return (
      <div
        onPointerDown={() => props.onFocusPane(node.paneId)}
        aria-hidden={isHiddenByMaximize || undefined}
        style={isHiddenByMaximize ? { contentVisibility: "hidden" } : undefined}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 overflow-hidden",
          isHiddenByMaximize && "invisible pointer-events-none",
          isMaximized && "absolute inset-0 z-30",
        )}
        data-split-pane-id={node.paneId}
        data-focused={isFocused ? "true" : "false"}
        data-maximized={isMaximized ? "true" : undefined}
      >
        {}
        {node.content.kind === "thread" ? (
          <PaneStaleWatcher
            threadId={node.content.threadId}
            onStale={() => props.onPruneStalePane(node.paneId)}
          />
        ) : null}
        <WorkspacePaneContent
          content={node.content}
          paneId={node.paneId}
          isFocused={isFocused}
          isSplitPane
          secondaryPanelRegistry={props.secondaryPanelRegistry}
          reservesWindowPanelToggle={isMaximized || (isTopRow && isRightEdge)}
          onRequestClose={() => props.onClosePane(node.paneId)}
          isMaximized={isMaximized}
          onToggleMaximize={() => props.onToggleMaximizePane(node.paneId)}
          onMoveToSide={(side) => props.onMovePaneToSide(node.paneId, side)}
          isBoundedPane
          isTopRow={isMaximized || isTopRow}
          ownsWindowTopLeft={
            props.maximizedPaneId !== null
              ? isMaximized
              : isTopRow && isLeftEdge
          }
          onNavigateInPane={props.onNavigateInPane}
          onBeginPaneDrag={props.onBeginPaneDrag}
        />
        {}
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
    );
  }

  return (
    <div
      data-split-resize-grid-root=""
      className={cn(
        "flex min-h-0 min-w-0 flex-1",
        node.dir === "col" ? "flex-col" : "flex-row",
      )}
    >
      {node.children.map((child, index) => (
        <Fragment key={paneKey(child)}>
          {index > 0 ? (
            <SplitDivider
              boundaryIndex={index}
              childCount={node.children.length}
              dir={node.dir}
              hidden={props.maximizedPaneId !== null}
              onResize={(fraction) => props.onResize(path, index - 1, fraction)}
            />
          ) : null}
          <div
            className="flex min-h-0 min-w-0"
            style={{ flex: `${node.sizes[index] ?? 1} 1 0` }}
          >
            <SplitTree
              {...props}
              node={child}
              path={[...path, index]}
              isTopRow={isTopRow && (node.dir === "row" || index === 0)}
              isLeftEdge={isLeftEdge && (node.dir === "col" || index === 0)}
              isRightEdge={
                isRightEdge &&
                (node.dir === "col" || index === node.children.length - 1)
              }
            />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

interface WorkspacePaneContentProps {
  content: PaneContent;
  paneId: string;
  isFocused: boolean;
  isSplitPane: boolean;
  secondaryPanelRegistry: PaneSecondaryPanelRegistry | null;
  reservesWindowPanelToggle: boolean;
  onRequestClose: (() => void) | null;
  isMaximized: boolean;
  onToggleMaximize: (() => void) | null;
  onMoveToSide?: (side: SplitSide) => void;
  isBoundedPane: boolean;
  isTopRow: boolean;
  ownsWindowTopLeft: boolean;
  onNavigateInPane: NavigateInPane;
  onBeginPaneDrag?: BeginPaneDrag;
}

function WorkspacePaneContent({
  content,
  paneId,
  isFocused,
  isSplitPane,
  secondaryPanelRegistry,
  reservesWindowPanelToggle,
  onRequestClose,
  isMaximized,
  onToggleMaximize,
  onMoveToSide,
  isBoundedPane,
  isTopRow,
  ownsWindowTopLeft,
  onNavigateInPane,
  onBeginPaneDrag,
}: WorkspacePaneContentProps) {
  const navigateInPane = useCallback(
    (thread: ThreadRoutePathArgs) => onNavigateInPane(paneId, thread),
    [onNavigateInPane, paneId],
  );
  const beginPaneDrag = useMemo(
    () =>
      onBeginPaneDrag
        ? (event: ReactPointerEvent, label: string) =>
            onBeginPaneDrag(paneId, event, label)
        : undefined,
    [onBeginPaneDrag, paneId],
  );
  const secondaryPanelHost = useMemo<PaneSecondaryPanelRegistration | null>(
    () =>
      secondaryPanelRegistry === null
        ? null
        : {
            publish: (model) => secondaryPanelRegistry.publish(paneId, model),
            clear: () => secondaryPanelRegistry.clear(paneId),
          },
    [paneId, secondaryPanelRegistry],
  );
  const value = useMemo<PaneContextValue>(
    () => ({
      paneId,
      isFocused,
      isSplitPane,
      secondaryPanelHost,
      reservesWindowPanelToggle,
      onRequestClose,
      isMaximized,
      onToggleMaximize,
      onMoveToSide,
      isBoundedPane,
      isTopRow,
      ownsWindowTopLeft,
      navigateInPane,
      beginPaneDrag,
    }),
    [
      beginPaneDrag,
      isBoundedPane,
      isFocused,
      isSplitPane,
      isTopRow,
      ownsWindowTopLeft,
      navigateInPane,
      onRequestClose,
      isMaximized,
      onToggleMaximize,
      onMoveToSide,
      paneId,
      reservesWindowPanelToggle,
      secondaryPanelHost,
    ],
  );

  if (content.kind !== "thread") {
    return (
      <PaneContext.Provider value={value}>
        <NonThreadPaneContent
          content={content}
          onRequestClose={onRequestClose}
          beginPaneDrag={beginPaneDrag}
          isBoundedPane={isBoundedPane}
          isTopRow={isTopRow}
          ownsWindowTopLeft={ownsWindowTopLeft}
        />
      </PaneContext.Provider>
    );
  }

  return (
    <PaneContext.Provider value={value}>
      <ThreadDetailView
        surface="pane"
        projectId={content.projectId}
        threadId={content.threadId}
      />
    </PaneContext.Provider>
  );
}

function StandalonePaneContent({
  content,
  paneId,
}: {
  content: PaneContent;
  paneId?: string;
}) {
  const navPanelChrome = usePluginNavPanelChrome();
  if (content.kind === "thread") {
    return <ThreadDetailView surface="page" />;
  }
  if (content.kind === "new-thread") {
    return <RootComposeView />;
  }
  if (content.kind === "plugin-detail") {
    return <PluginDetailPaneView pluginId={content.pluginId} />;
  }
  const panelEntry = navPanelChrome.find(
    (candidate) =>
      candidate.chrome.pluginId === content.pluginId &&
      candidate.chrome.path === content.panelPath,
  );
  const panel = panelEntry?.panel ?? undefined;
  const panelChrome = panelEntry?.chrome;
  const body = (
    <PluginPanelView
      pluginId={content.pluginId}
      panelPath={content.panelPath}
      subPath={content.subPath}
    />
  );
  return (
    <PluginPagePanelHost
      flushPageInsets
      pluginId={content.pluginId}
      panelPath={content.panelPath}
      paneId={paneId}
      subPath={content.subPath}
    >
      {panelChrome ? (
        <div className="flex h-full min-h-0 flex-col">
          <AppPageHeader
            center={<PluginPanelHeaderCenter chrome={panelChrome} />}
            actions={
              panel ? (
                <PluginPanelHeaderActions
                  panel={panel}
                  paneId={paneId}
                  subPath={content.subPath}
                />
              ) : undefined
            }
          />
          <div className="flex min-h-0 flex-1 flex-col p-4 md:p-5">{body}</div>
        </div>
      ) : (
        body
      )}
    </PluginPagePanelHost>
  );
}

function NonThreadPaneContent({
  content,
  onRequestClose,
  beginPaneDrag,
  isBoundedPane,
  isTopRow,
  ownsWindowTopLeft,
}: {
  content: Exclude<PaneContent, { kind: "thread" }>;
  onRequestClose: (() => void) | null;
  beginPaneDrag?: (event: ReactPointerEvent, label: string) => void;
  isBoundedPane: boolean;
  isTopRow: boolean;
  ownsWindowTopLeft: boolean;
}) {
  const navPanelChrome = usePluginNavPanelChrome();
  const resourceRouteLabel = useAtomValue(resourceRouteLabelAtom);
  const dimsInactiveSplits = useAtomValue(dimInactiveSplitsAtom);
  const { reservesWindowPanelToggle, isFocused } = useOptionalPaneContext() ?? {
    reservesWindowPanelToggle: false,
    isFocused: true,
  };
  const hostLayout = useContext(SecondaryPanelHostLayoutContext);
  const showsWindowPanelToggle = hostLayout?.pinsCornerToggle === true;
  const [desktopInfo] = useState(getBbDesktopInfo);
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const panelEntry =
    content.kind === "plugin-panel"
      ? navPanelChrome.find(
          (candidate) =>
            candidate.chrome.pluginId === content.pluginId &&
            candidate.chrome.path === content.panelPath,
        )
      : undefined;
  const panel = panelEntry?.panel ?? undefined;
  const panelChrome = panelEntry?.chrome;
  const automationBreadcrumbs =
    content.kind === "plugin-panel"
      ? resolveAutomationBreadcrumbs(
          paneContentRoute(content),
          isFocused ? resourceRouteLabel : null,
        )
      : null;
  const label =
    panelChrome?.title ??
    (content.kind === "plugin-detail" ? "Extension" : "New thread");
  const handlePointerDown = (event: ReactPointerEvent) => {
    if (
      event.target instanceof Element &&
      event.target.closest("a, button") !== null
    ) {
      return;
    }
    if (event.button === 0) beginPaneDrag?.(event, label);
  };
  const actions = (
    <>
      {panel ? (
        <PluginPanelHeaderActions
          panel={panel}
          subPath={content.kind === "plugin-panel" ? content.subPath : ""}
        />
      ) : null}
      <PaneMaximizeButton />
      {onRequestClose ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
            CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
          )}
          aria-label="Close pane"
          onClick={onRequestClose}
        >
          <Icon
            name={
              content.kind === "new-thread"
                ? "CloseThreadPane"
                : "ClosePluginPane"
            }
          />
        </Button>
      ) : null}
      {reservesWindowPanelToggle && showsWindowPanelToggle ? (
        <span aria-hidden className={HEADER_ICON_BUTTON_CLASS} />
      ) : null}
    </>
  );

  const contentMarkup = (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        !isBoundedPane && content.kind === "new-thread" && "-m-4 md:-m-5",
      )}
    >
      {isBoundedPane || panel ? (
        <AppPageHeader
          isWindowDragRegion={isTopRow}
          ownsWindowTopLeft={ownsWindowTopLeft}
          className={isBoundedPane ? "z-[21]" : undefined}
          center={
            <div
              data-pane-header-focus-tab={
                isBoundedPane && isFocused ? "" : undefined
              }
              className={cn(
                "relative flex min-w-0 flex-1 items-center",
                isBoundedPane && "-mx-2 -my-1 rounded-md px-2 py-1",
                isBoundedPane && isFocused && CONTEXT_SELECTION_SURFACE_CLASS,
                beginPaneDrag &&
                  cn(
                    "cursor-grab touch-none select-none",
                    usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
                  ),
              )}
              onPointerDown={beginPaneDrag ? handlePointerDown : undefined}
            >
              {automationBreadcrumbs ? (
                <AppBreadcrumbs
                  breadcrumbs={automationBreadcrumbs}
                  usesDesktopChrome={usesDesktopChrome}
                />
              ) : panelChrome ? (
                <PluginPanelHeaderCenter chrome={panelChrome} />
              ) : (
                <p
                  className={cn(
                    "relative truncate text-sm font-normal transition-colors",
                    isBoundedPane &&
                      !isFocused &&
                      dimsInactiveSplits &&
                      CONTEXT_INACTIVE_TEXT_CLASS,
                  )}
                >
                  {content.kind === "plugin-detail"
                    ? "Extension"
                    : "New thread"}
                </p>
              )}
            </div>
          }
          actions={actions}
        />
      ) : null}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col p-4 md:p-5",
          isBoundedPane && content.kind === "plugin-panel" && "isolate",
        )}
      >
        {content.kind === "new-thread" ? (
          <RootComposeView />
        ) : content.kind === "plugin-detail" ? (
          <PluginDetailPaneView pluginId={content.pluginId} />
        ) : (
          <PluginPanelView
            pluginId={content.pluginId}
            panelPath={content.panelPath}
            subPath={content.subPath}
          />
        )}
      </div>
    </div>
  );

  return content.kind === "plugin-panel" ? (
    <PluginPagePanelHost
      flushPageInsets={!isBoundedPane}
      pluginId={content.pluginId}
      panelPath={content.panelPath}
      subPath={content.subPath}
    >
      {contentMarkup}
    </PluginPagePanelHost>
  ) : (
    contentMarkup
  );
}

interface SplitDividerProps {
  boundaryIndex: number;
  childCount: number;
  dir: "row" | "col";
  hidden: boolean;
  onResize: (fraction: number) => void;
}

interface FrozenTimelineRow {
  containIntrinsicBlockSize: string;
  contentVisibility: string;
  element: HTMLElement;
  height: string;
}

function findVerticalScrollViewport(element: HTMLElement): HTMLElement | null {
  let candidate = element.parentElement;
  while (candidate !== null) {
    const overflowY = window.getComputedStyle(candidate).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      candidate.scrollHeight > candidate.clientHeight
    ) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }
  return null;
}

function freezeOffscreenTimelineRows(
  previous: HTMLElement,
  next: HTMLElement,
): () => void {
  const rows = [
    ...previous.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
    ...next.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
  ];
  const frozenRows: FrozenTimelineRow[] = [];
  const viewportRects = new Map<HTMLElement, DOMRect>();

  for (const row of rows) {
    const viewport = findVerticalScrollViewport(row);
    if (viewport === null) continue;
    const rowRect = row.getBoundingClientRect();
    let viewportRect = viewportRects.get(viewport);
    if (viewportRect === undefined) {
      viewportRect = viewport.getBoundingClientRect();
      viewportRects.set(viewport, viewportRect);
    }
    const overscan = viewportRect.height;
    const isOffscreen =
      rowRect.bottom < viewportRect.top - overscan ||
      rowRect.top > viewportRect.bottom + overscan;
    if (!isOffscreen || rowRect.height <= 0) continue;
    frozenRows.push({
      containIntrinsicBlockSize: row.style.containIntrinsicBlockSize,
      contentVisibility: row.style.contentVisibility,
      element: row,
      height: `${rowRect.height}px`,
    });
  }

  for (const { element, height } of frozenRows) {
    element.style.containIntrinsicBlockSize = height;
    element.style.contentVisibility = "hidden";
  }

  return () => {
    for (const {
      containIntrinsicBlockSize,
      contentVisibility,
      element,
    } of frozenRows) {
      element.style.containIntrinsicBlockSize = containIntrinsicBlockSize;
      element.style.contentVisibility = contentVisibility;
    }
  };
}

function SplitDivider({
  boundaryIndex,
  childCount,
  dir,
  hidden,
  onResize,
}: SplitDividerProps) {
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
      if (!(divider instanceof HTMLDivElement)) {
        return;
      }
      const previous = divider.previousElementSibling;
      const next = divider.nextElementSibling;
      if (
        !(previous instanceof HTMLElement) ||
        !(next instanceof HTMLElement)
      ) {
        return;
      }
      const previousRect = previous.getBoundingClientRect();
      const nextRect = next.getBoundingClientRect();
      const start = horizontal ? previousRect.left : previousRect.top;
      const end = horizontal ? nextRect.right : nextRect.bottom;
      const span = end - start;
      if (span <= 0) {
        return;
      }

      hitTarget.setPointerCapture(event.pointerId);
      divider.dataset.dragging = "true";
      const pointerId = event.pointerId;
      const snapSession = createSplitResizeSnapSession(
        divider,
        horizontal ? "x" : "y",
        { boundaryIndex, childCount },
      );
      const pointerDownPosition = horizontal ? event.clientX : event.clientY;
      snapSession.resolve({ end, pointer: pointerDownPosition, start });

      const previousGrow = Number.parseFloat(
        window.getComputedStyle(previous).flexGrow,
      );
      const nextGrow = Number.parseFloat(
        window.getComputedStyle(next).flexGrow,
      );
      const pairTotal =
        Number.isFinite(previousGrow) &&
        Number.isFinite(nextGrow) &&
        previousGrow + nextGrow > 0
          ? previousGrow + nextGrow
          : 1;
      const previousFlex = previous.style.flex;
      const nextFlex = next.style.flex;
      const restoreTimelineRows = freezeOffscreenTimelineRows(previous, next);
      let pendingFraction: number | null = null;
      let finished = false;

      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        const pointer = horizontal ? moveEvent.clientX : moveEvent.clientY;
        const { fraction } = snapSession.resolve({
          end,
          pointer,
          start,
        });
        pendingFraction = fraction;

        previous.style.flex = `${pairTotal * fraction} 1 0px`;
        next.style.flex = `${pairTotal * (1 - fraction)} 1 0px`;
      };
      const finish = (commit: boolean) => {
        if (finished) return;
        finished = true;
        finishResizeRef.current = null;
        delete divider.dataset.dragging;
        hitTarget.removeEventListener("pointermove", onMove);
        hitTarget.removeEventListener("pointerup", onUp);
        hitTarget.removeEventListener("pointercancel", onCancel);
        hitTarget.removeEventListener("lostpointercapture", onLostCapture);
        if (hitTarget.hasPointerCapture?.(pointerId)) {
          hitTarget.releasePointerCapture(pointerId);
        }
        snapSession.clear();
        restoreTimelineRows();
        if (commit && pendingFraction !== null) {
          onResize(pendingFraction);
          return;
        }
        previous.style.flex = previousFlex;
        next.style.flex = nextFlex;
      };
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        finish(true);
      };
      const onCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== pointerId) return;
        finish(false);
      };
      const onLostCapture = (lostEvent: PointerEvent) => {
        if (lostEvent.pointerId !== pointerId) return;
        finish(false);
      };
      hitTarget.addEventListener("pointermove", onMove);
      hitTarget.addEventListener("pointerup", onUp);
      hitTarget.addEventListener("pointercancel", onCancel);
      hitTarget.addEventListener("lostpointercapture", onLostCapture);
      finishResizeRef.current = () => finish(false);
    },
    [boundaryIndex, childCount, horizontal, onResize],
  );

  return (
    <div
      role="separator"
      data-split-resize-grid-boundary={boundaryIndex}
      data-split-resize-grid-count={childCount}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      className={cn(
        "group relative z-[25] flex-shrink-0 transition-colors",
        "bg-border-seam",
        "hover:bg-ring/40 data-[dragging]:bg-ring/40",
        hidden && "invisible pointer-events-none",
        horizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
      )}
    >
      <div
        aria-hidden
        data-split-divider-hit-target=""
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

interface PaneStaleWatcherProps {
  threadId: string;
  onStale: () => void;
}

function PaneStaleWatcher({ threadId, onStale }: PaneStaleWatcherProps) {
  const { data: thread, isSuccess, isError, error } = useThread(threadId);
  const archivesInFlight = useIsMutating({
    predicate: (mutation) =>
      mutation.options.meta?.lifecycleOperation === "archive_thread",
  });
  const isGone =
    isError && error instanceof BbHttpError && error.status === 404;
  const isDeleted =
    isSuccess && thread !== undefined && thread.deletedAt !== null;
  const isConfirmedArchived =
    isSuccess &&
    thread !== undefined &&
    thread.archivedAt !== null &&
    archivesInFlight === 0;
  const isStale = isGone || isDeleted || isConfirmedArchived;

  const onStaleRef = useRef(onStale);
  useEffect(() => {
    onStaleRef.current = onStale;
  }, [onStale]);
  useEffect(() => {
    if (isStale) {
      onStaleRef.current();
    }
  }, [isStale]);

  return null;
}

function paneKey(node: LayoutNode): string {
  return node.type === "pane"
    ? node.paneId
    : listPanes(node)
        .map((pane) => pane.paneId)
        .join("-");
}
