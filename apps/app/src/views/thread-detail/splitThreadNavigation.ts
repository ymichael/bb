import type { ThreadRoutePathArgs } from "@/lib/route-paths";
import type { ThreadOpenSplit, ThreadPaneAction } from "@bb/server-contract";
import {
  countPanes,
  findPane,
  findPaneByContent,
  findPaneByThread,
  MAX_PANES,
  replacePaneContent,
  setFocus,
  splitPane,
} from "@/lib/split-layout";
import { decideThreadDrop, type SplitZone } from "@/lib/split-drag";
import type { PaneContent, SplitLayout } from "@/lib/split-layout";
import { matchPath } from "react-router-dom";
import {
  APP_ROOT_ROUTE_PATH,
  getPluginDetailRoutePath,
  getPluginPanelRoutePath,
  getRootComposeRoutePath,
  getThreadRoutePath,
  PLUGIN_PANEL_ROUTE_PATH,
  TOOLS_PLUGIN_DETAIL_ROUTE_PATH,
} from "@/lib/route-paths";

const FIRST_PANE_ID = "pane-1";
const SPLITTABLE_THREAD_ROUTE_PATH = "/projects/:projectId/threads/:threadId";

export function threadPaneContent(thread: ThreadRoutePathArgs): PaneContent {
  return {
    kind: "thread",
    projectId: thread.projectId,
    threadId: thread.threadId,
  };
}

export function createSinglePaneLayout(
  thread: ThreadRoutePathArgs,
): SplitLayout {
  return {
    root: {
      type: "pane",
      paneId: FIRST_PANE_ID,
      content: threadPaneContent(thread),
    },
    focusedPaneId: FIRST_PANE_ID,
  };
}

function createSinglePaneContentLayout(content: PaneContent): SplitLayout {
  return {
    root: { type: "pane", paneId: FIRST_PANE_ID, content },
    focusedPaneId: FIRST_PANE_ID,
  };
}

export function paneContentRoute(content: PaneContent): string {
  if (content.kind === "thread") {
    return getThreadRoutePath(content);
  }
  if (content.kind === "new-thread") {
    return getRootComposeRoutePath();
  }
  if (content.kind === "plugin-detail") {
    return getPluginDetailRoutePath({ pluginId: content.pluginId });
  }
  return getPluginPanelRoutePath({
    pluginId: content.pluginId,
    path: content.panelPath,
    subPath: content.subPath,
  });
}

export function paneContentForPathname(pathname: string): PaneContent | null {
  if (pathname === APP_ROOT_ROUTE_PATH) {
    return { kind: "new-thread" };
  }
  const thread = matchPath(
    { path: SPLITTABLE_THREAD_ROUTE_PATH, end: false },
    pathname,
  );
  if (thread?.params.projectId && thread.params.threadId) {
    return {
      kind: "thread",
      projectId: thread.params.projectId,
      threadId: thread.params.threadId,
    };
  }
  const detail = matchPath(TOOLS_PLUGIN_DETAIL_ROUTE_PATH, pathname);
  if (detail?.params.pluginId) {
    return { kind: "plugin-detail", pluginId: detail.params.pluginId };
  }
  const panel = matchPath(PLUGIN_PANEL_ROUTE_PATH, pathname);
  if (panel?.params.pluginId && panel.params.panelPath) {
    return {
      kind: "plugin-panel",
      pluginId: panel.params.pluginId,
      panelPath: panel.params.panelPath,
      subPath: panel.params["*"] ?? "",
    };
  }
  return null;
}

export function reconcileLayoutForContent(
  layout: SplitLayout | null,
  content: PaneContent,
): SplitLayout {
  if (layout === null) {
    return createSinglePaneContentLayout(content);
  }
  const existing = findPaneByContent(layout.root, content);
  if (existing !== null) {
    const withRouteState =
      existing.content.kind === "plugin-panel" &&
      content.kind === "plugin-panel" &&
      existing.content.subPath !== content.subPath
        ? replacePaneContent(layout, existing.paneId, content)
        : layout;
    return withRouteState.focusedPaneId === existing.paneId
      ? withRouteState
      : setFocus(withRouteState, existing.paneId);
  }
  return replacePaneContent(layout, layout.focusedPaneId, content);
}

export function focusedPaneRoute(layout: SplitLayout): string | null {
  const focused = findPane(layout.root, layout.focusedPaneId);
  return focused === null ? null : paneContentRoute(focused.content);
}

function threadOpenSplitZone(split: ThreadOpenSplit): SplitZone {
  return split === "replace" ? "center" : split === "down" ? "bottom" : split;
}

export function applyThreadOpenToLayout(
  layout: SplitLayout | null,
  thread: ThreadRoutePathArgs,
  split: ThreadOpenSplit,
): SplitLayout {
  if (layout === null) {
    return createSinglePaneLayout(thread);
  }
  const existing = findPaneByThread(
    layout.root,
    thread.projectId,
    thread.threadId,
  );
  const decision = decideThreadDrop({
    zone: threadOpenSplitZone(split),
    threadAlreadyOpen: existing !== null,
    atMaxPanes: countPanes(layout.root) >= MAX_PANES,
  });
  if (existing !== null) {
    return layout.focusedPaneId === existing.paneId
      ? layout
      : setFocus(layout, existing.paneId);
  }
  const content = threadPaneContent(thread);
  return decision.zone === "center"
    ? replacePaneContent(layout, layout.focusedPaneId, content)
    : splitPane(layout, layout.focusedPaneId, decision.zone, content);
}

interface ThreadPaneActionLayoutResult {
  layout: SplitLayout;
  maximizedPaneId: string | null;
  dimInactiveSplits: boolean | null;
}

export function applyThreadPaneActionToLayout(
  layout: SplitLayout,
  maximizedPaneId: string | null,
  thread: ThreadRoutePathArgs,
  action: ThreadPaneAction,
): ThreadPaneActionLayoutResult {
  const pane = findPaneByThread(layout.root, thread.projectId, thread.threadId);
  if (pane === null || countPanes(layout.root) < 2) {
    return { layout, maximizedPaneId, dimInactiveSplits: null };
  }
  if (action === "spotlight" || action === "clear-spotlight") {
    return {
      layout:
        layout.focusedPaneId === pane.paneId
          ? layout
          : setFocus(layout, pane.paneId),
      maximizedPaneId,
      dimInactiveSplits: action === "spotlight",
    };
  }
  if (action === "restore") {
    return {
      layout,
      maximizedPaneId: maximizedPaneId === pane.paneId ? null : maximizedPaneId,
      dimInactiveSplits: null,
    };
  }
  if (action === "toggle" && maximizedPaneId === pane.paneId) {
    return { layout, maximizedPaneId: null, dimInactiveSplits: null };
  }
  return {
    layout:
      layout.focusedPaneId === pane.paneId
        ? layout
        : setFocus(layout, pane.paneId),
    maximizedPaneId: pane.paneId,
    dimInactiveSplits: null,
  };
}
