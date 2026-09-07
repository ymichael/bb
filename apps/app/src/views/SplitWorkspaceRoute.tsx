import { lazy, useMemo } from "react";
import { matchPath, Navigate, useLocation } from "react-router-dom";
import { useAtomValue } from "jotai";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { holdsPluginDetailPane } from "@/lib/split-layout/openPaneContentInSplit";
import "@bb/shared-ui/icon-extended";
import {
  APP_ROOT_ROUTE_PATH,
  LEGACY_PROJECT_COMPOSE_ROUTE_PATH,
  PLUGIN_PANEL_ROUTE_PATH,
  TOOLS_PLUGIN_DETAIL_ROUTE_PATH,
} from "@/lib/route-paths";
import type { PaneContent } from "@/lib/split-layout";
import { useRouteState } from "@/hooks/useRouteState";
import { LegacyProjectComposeRedirect } from "./RootComposeView";
import { SplitThreadArea } from "./thread-detail/SplitThreadArea";

const ROOT_COMPOSE_CONTENT = { kind: "new-thread" } as const;

const ToolsView = lazy(() =>
  import("./ToolsView").then((m) => ({ default: m.ToolsView })),
);

export default function SplitWorkspaceRoute() {
  const location = useLocation();
  const { projectId, threadId, isThreadView } = useRouteState();
  const pluginMatch = matchPath(PLUGIN_PANEL_ROUTE_PATH, location.pathname);
  const pluginDetailMatch = matchPath(
    TOOLS_PLUGIN_DETAIL_ROUTE_PATH,
    location.pathname,
  );
  const legacyProjectMatch = matchPath(
    LEGACY_PROJECT_COMPOSE_ROUTE_PATH,
    location.pathname,
  );
  const pluginId = pluginMatch?.params.pluginId;
  const panelPath = pluginMatch?.params.panelPath;
  const pluginSubPath = pluginMatch?.params["*"] ?? "";
  const detailPluginId = pluginDetailMatch?.params.pluginId;

  const routeContent = useMemo<PaneContent | null>(() => {
    if (location.pathname === APP_ROOT_ROUTE_PATH) {
      return ROOT_COMPOSE_CONTENT;
    }
    if (isThreadView && projectId && threadId) {
      return { kind: "thread", projectId, threadId };
    }
    if (detailPluginId) {
      return { kind: "plugin-detail", pluginId: detailPluginId };
    }
    if (pluginId && panelPath) {
      return {
        kind: "plugin-panel",
        pluginId,
        panelPath,
        subPath: pluginSubPath,
      };
    }
    return null;
  }, [
    detailPluginId,
    isThreadView,
    location.pathname,
    panelPath,
    pluginId,
    pluginSubPath,
    projectId,
    threadId,
  ]);

  const layout = useAtomValue(splitLayoutAtom);

  const legacyProjectId = legacyProjectMatch?.params.projectId;
  if (legacyProjectId) {
    return <LegacyProjectComposeRedirect projectId={legacyProjectId} />;
  }
  if (routeContent === null) {
    return <Navigate to={APP_ROOT_ROUTE_PATH} replace />;
  }
  if (
    routeContent.kind === "plugin-detail" &&
    !holdsPluginDetailPane(layout, routeContent.pluginId)
  ) {
    return <ToolsView pluginId={routeContent.pluginId} />;
  }
  return <SplitThreadArea routeContent={routeContent} />;
}
