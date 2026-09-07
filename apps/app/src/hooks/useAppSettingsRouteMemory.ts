import { useEffect, useRef } from "react";
import { matchPath, useLocation } from "react-router-dom";
import {
  getRootComposeRoutePath,
  getPluginsRoutePath,
  isToolsRoutePath,
  SETTINGS_ROUTE_PATH,
} from "@/lib/route-paths";

interface AppSettingsRouteMemory {
  appRoutePath: string;
  settingsRoutePath: string;
  toolsRoutePath: string;
  toolsBackRoutePath: string;
}

function getLocationRoutePath(location: {
  pathname: string;
  search: string;
  hash: string;
}): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

function isGlobalSettingsRoute(pathname: string): boolean {
  return matchPath(`${SETTINGS_ROUTE_PATH}/*`, pathname) !== null;
}

export function useAppSettingsRouteMemory(): AppSettingsRouteMemory {
  const location = useLocation();
  const currentRoutePath = getLocationRoutePath(location);
  const isSettingsRoute = isGlobalSettingsRoute(location.pathname);
  const isCurrentToolsRoute = isToolsRoutePath(location.pathname);
  const lastAppRoutePathRef = useRef(
    isSettingsRoute ? getRootComposeRoutePath() : currentRoutePath,
  );
  const lastCoreAppRoutePathRef = useRef(
    isSettingsRoute || isCurrentToolsRoute
      ? getRootComposeRoutePath()
      : currentRoutePath,
  );
  const lastSettingsRoutePathRef = useRef(
    isSettingsRoute ? currentRoutePath : SETTINGS_ROUTE_PATH,
  );

  useEffect(() => {
    if (isSettingsRoute) {
      lastSettingsRoutePathRef.current = currentRoutePath;
      return;
    }
    lastAppRoutePathRef.current = currentRoutePath;
    if (isCurrentToolsRoute) {
      return;
    }
    lastCoreAppRoutePathRef.current = currentRoutePath;
  }, [currentRoutePath, isCurrentToolsRoute, isSettingsRoute]);

  return {
    appRoutePath: isSettingsRoute
      ? lastAppRoutePathRef.current
      : currentRoutePath,
    settingsRoutePath: isSettingsRoute
      ? currentRoutePath
      : lastSettingsRoutePathRef.current,
    toolsRoutePath: isCurrentToolsRoute
      ? currentRoutePath
      : getPluginsRoutePath(),
    toolsBackRoutePath: isCurrentToolsRoute
      ? lastCoreAppRoutePathRef.current
      : currentRoutePath,
  };
}
