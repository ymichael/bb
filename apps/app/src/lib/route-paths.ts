import { matchPath } from "react-router-dom";
import {
  PLUGIN_PANEL_ROUTE_PATH,
  ROUTE_PATTERNS,
  TOOLS_ROUTE_PATH,
  stripRoutePathSuffix,
} from "@bb/client-core";

export {
  APP_ROOT_ROUTE_PATH,
  AUTH_CALLBACK_ROUTE_PATH,
  SETTINGS_ROUTE_PATH,
  SETTINGS_SECTION_ROUTE_PATH,
  SETTINGS_PLUGINS_ROUTE_PATH,
  SETTINGS_PLUGIN_ROUTE_PATH,
  SETTINGS_MACHINE_ROUTE_PATH,
  TOOLS_ROUTE_PATH,
  TOOLS_SKILLS_ROUTE_PATH,
  TOOLS_SKILL_DETAIL_ROUTE_PATH,
  LEGACY_TOOLS_SKILL_DETAIL_ROUTE_PATH,
  TOOLS_REGISTRY_SKILLS_ROUTE_PATH,
  TOOLS_REGISTRY_SKILL_DETAIL_ROUTE_PATH,
  TOOLS_PLUGINS_ROUTE_PATH,
  TOOLS_PLUGIN_BROWSE_ROUTE_PATH,
  TOOLS_PLUGIN_DETAIL_ROUTE_PATH,
  LEGACY_TOOLS_PREFIX_ROUTE_PATH,
  LEGACY_TOOLS_SPLAT_ROUTE_PATH,
  LEGACY_TOOLS_AUTOMATIONS_ROUTE_PATH,
  LEGACY_TOOLS_AUTOMATION_BROWSE_ROUTE_PATH,
  LEGACY_TOOLS_AUTOMATION_DETAIL_ROUTE_PATH,
  LEGACY_TOOLS_AUTOMATION_EDIT_ROUTE_PATH,
  LEGACY_SKILLS_ROUTE_PATH,
  LEGACY_AUTOMATIONS_ROUTE_PATH,
  LEGACY_AUTOMATION_DETAIL_ROUTE_PATH,
  AUTOMATIONS_PLUGIN_ID,
  AUTOMATIONS_PLUGIN_PANEL_PATH,
  AUTOMATIONS_ROUTE_PATH,
  AUTOMATIONS_BROWSE_ROUTE_PATH,
  AUTOMATION_DETAIL_ROUTE_PATH,
  AUTOMATION_EDIT_ROUTE_PATH,
  SKILLS_ROUTE_PATH,
  LEGACY_PROJECT_COMPOSE_ROUTE_PATH,
  PROJECTLESS_ARCHIVED_ROUTE_PATH,
  PROJECT_SETTINGS_ROUTE_PATH,
  PROJECT_ARCHIVED_ROUTE_PATH,
  PLUGIN_PANEL_ROUTE_PATH,
  isProjectlessProjectId,
  getRootComposeRoutePath,
  getLegacyProjectComposeRoutePath,
  getProjectComposeRoutePath,
  getSettingsRoutePath,
  getSettingsMachineRoutePath,
  getSkillsRoutePath,
  getRegistrySkillsRoutePath,
  getSkillDetailRoutePath,
  getRegistrySkillDetailRoutePath,
  getPluginsRoutePath,
  getPluginDetailRoutePath,
  getPluginConfigurationRoutePath,
  getAutomationsRoutePath,
  getAutomationDetailRoutePath,
  getAutomationEditRoutePath,
  getProjectSettingsRoutePath,
  getPluginPanelRoutePath,
  getThreadRoutePath,
} from "@bb/client-core";
export type { ThreadRoutePathArgs } from "@bb/client-core";

export function getPluginPanelRoutePluginId(pathname: string): string | null {
  return matchPath(PLUGIN_PANEL_ROUTE_PATH, pathname)?.params.pluginId ?? null;
}

interface IsRoutePathArgs {
  path: string;
}

interface ResolveRouteHrefArgs {
  currentOrigin: string;
  href: string;
}

interface RouteHrefResolution {
  path: string;
}

export function isToolsRoutePath(pathname: string): boolean {
  return (
    pathname === TOOLS_ROUTE_PATH ||
    matchPath(`${TOOLS_ROUTE_PATH}/*`, pathname) !== null
  );
}

const ABSOLUTE_HTTP_URL_PATTERN = /^https?:\/\//iu;

export function isRoutePath({ path }: IsRoutePathArgs): boolean {
  const pathname = stripRoutePathSuffix(path);
  return ROUTE_PATTERNS.some(
    (pattern) => matchPath(pattern, pathname) !== null,
  );
}

export function resolveRouteHref({
  currentOrigin,
  href,
}: ResolveRouteHrefArgs): RouteHrefResolution | null {
  if (
    href.length === 0 ||
    href.startsWith("//") ||
    (!href.startsWith("/") && !ABSOLUTE_HTTP_URL_PATTERN.test(href))
  ) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(href, currentOrigin);
  } catch {
    return null;
  }

  if (url.origin !== currentOrigin || !isRoutePath({ path: url.pathname })) {
    return null;
  }

  return {
    path: `${url.pathname}${url.search}${url.hash}`,
  };
}
