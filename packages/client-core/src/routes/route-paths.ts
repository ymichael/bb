import { PERSONAL_PROJECT_ID } from "@bb/domain";

export const APP_ROOT_ROUTE_PATH = "/";
export const AUTH_CALLBACK_ROUTE_PATH = "/auth/callback";
export const SETTINGS_ROUTE_PATH = "/settings";
export const SETTINGS_SECTION_ROUTE_PATH = "/settings/:section";
export const SETTINGS_PLUGINS_ROUTE_PATH = "/settings/plugins";
export const SETTINGS_PLUGIN_ROUTE_PATH = "/settings/plugins/:pluginId";
export const SETTINGS_MACHINE_ROUTE_PATH = "/settings/machines/:hostId";
export const TOOLS_ROUTE_PATH = "/extensions";
export const TOOLS_SKILLS_ROUTE_PATH = "/extensions/skills";
export const TOOLS_SKILL_DETAIL_ROUTE_PATH =
  "/extensions/skills/library/:skillId";
export const LEGACY_TOOLS_SKILL_DETAIL_ROUTE_PATH =
  "/extensions/skills/installed/:skillId";
export const TOOLS_REGISTRY_SKILLS_ROUTE_PATH = "/extensions/skills/registry";
export const TOOLS_REGISTRY_SKILL_DETAIL_ROUTE_PATH =
  "/extensions/skills/registry/:registrySkillId";
export const TOOLS_PLUGINS_ROUTE_PATH = "/extensions/plugins";
export const TOOLS_PLUGIN_BROWSE_ROUTE_PATH = "/extensions/plugins/browse";
export const TOOLS_PLUGIN_DETAIL_ROUTE_PATH = "/extensions/plugins/:pluginId";
export const LEGACY_TOOLS_PREFIX_ROUTE_PATH = "/tools";
export const LEGACY_TOOLS_SPLAT_ROUTE_PATH = "/tools/*";
export const LEGACY_TOOLS_AUTOMATIONS_ROUTE_PATH = "/tools/automations";
export const LEGACY_TOOLS_AUTOMATION_BROWSE_ROUTE_PATH =
  "/tools/automations/browse";
export const LEGACY_TOOLS_AUTOMATION_DETAIL_ROUTE_PATH =
  "/tools/automations/:projectId/:automationId";
export const LEGACY_TOOLS_AUTOMATION_EDIT_ROUTE_PATH =
  "/tools/automations/:projectId/:automationId/edit";
export const LEGACY_SKILLS_ROUTE_PATH = "/skills";
export const LEGACY_AUTOMATIONS_ROUTE_PATH = "/automations";
export const LEGACY_AUTOMATION_DETAIL_ROUTE_PATH =
  "/automations/:projectId/:automationId";
export const AUTOMATIONS_PLUGIN_ID = "automations";
export const AUTOMATIONS_PLUGIN_PANEL_PATH = "automations";
export const AUTOMATIONS_ROUTE_PATH = "/plugins/automations/automations";
export const AUTOMATIONS_BROWSE_ROUTE_PATH =
  "/plugins/automations/automations/browse";
export const AUTOMATION_DETAIL_ROUTE_PATH =
  "/plugins/automations/automations/:projectId/:automationId";
export const AUTOMATION_EDIT_ROUTE_PATH =
  "/plugins/automations/automations/:projectId/:automationId/edit";
export const SKILLS_ROUTE_PATH = TOOLS_SKILLS_ROUTE_PATH;
const ROOT_COMPOSE_ROUTE_PATH = APP_ROOT_ROUTE_PATH;
export const LEGACY_PROJECT_COMPOSE_ROUTE_PATH = "/projects/:projectId";
export const PROJECTLESS_ARCHIVED_ROUTE_PATH = "/archived";
const PROJECTLESS_THREAD_DETAIL_ROUTE_PATH = "/threads/:threadId";
export const PROJECT_SETTINGS_ROUTE_PATH = "/projects/:projectId/settings";
export const PROJECT_ARCHIVED_ROUTE_PATH = "/projects/:projectId/archived";
const THREAD_DETAIL_ROUTE_PATH = "/projects/:projectId/threads/:threadId";
export const PLUGIN_PANEL_ROUTE_PATH = "/plugins/:pluginId/:panelPath/*";

export interface ThreadRoutePathArgs {
  projectId: string;
  threadId: string;
}

export function isProjectlessProjectId(
  projectId: string | null | undefined,
): boolean {
  return projectId === PERSONAL_PROJECT_ID;
}

export function getRootComposeRoutePath(): string {
  return ROOT_COMPOSE_ROUTE_PATH;
}

export function getLegacyProjectComposeRoutePath(projectId: string): string {
  return `/projects/${projectId}`;
}

export function getProjectComposeRoutePath(projectId: string): string {
  return isProjectlessProjectId(projectId)
    ? getRootComposeRoutePath()
    : getLegacyProjectComposeRoutePath(projectId);
}

export function getSettingsRoutePath(section?: string): string {
  return section === undefined
    ? SETTINGS_ROUTE_PATH
    : `/settings/${encodeURIComponent(section)}`;
}

export function getSettingsMachineRoutePath(hostId: string): string {
  return `/settings/machines/${encodeURIComponent(hostId)}`;
}

export function getSkillsRoutePath(): string {
  return SKILLS_ROUTE_PATH;
}

export function getRegistrySkillsRoutePath(): string {
  return TOOLS_REGISTRY_SKILLS_ROUTE_PATH;
}

interface SkillDetailRoutePathArgs {
  skillId: string;
}

export function getSkillDetailRoutePath({
  skillId,
}: SkillDetailRoutePathArgs): string {
  return `${TOOLS_SKILLS_ROUTE_PATH}/library/${encodeURIComponent(skillId)}`;
}

interface RegistrySkillDetailRoutePathArgs {
  registrySkillId: string;
}

export function getRegistrySkillDetailRoutePath({
  registrySkillId,
}: RegistrySkillDetailRoutePathArgs): string {
  return `${TOOLS_SKILLS_ROUTE_PATH}/registry/${encodeURIComponent(
    registrySkillId,
  )}`;
}

export function getPluginsRoutePath(): string {
  return TOOLS_PLUGINS_ROUTE_PATH;
}

interface PluginDetailRoutePathArgs {
  pluginId: string;
  view?: "installed";
}

export function getPluginDetailRoutePath({
  pluginId,
  view,
}: PluginDetailRoutePathArgs): string {
  const path = `${TOOLS_PLUGINS_ROUTE_PATH}/${encodeURIComponent(pluginId)}`;
  return view === "installed"
    ? `${SETTINGS_PLUGINS_ROUTE_PATH}/${encodeURIComponent(pluginId)}?view=installed`
    : path;
}

export function getPluginConfigurationRoutePath(
  args: PluginDetailRoutePathArgs,
): string {
  return `/settings/plugins/${encodeURIComponent(args.pluginId)}`;
}

export function getAutomationsRoutePath(): string {
  return AUTOMATIONS_ROUTE_PATH;
}

interface AutomationDetailRoutePathArgs {
  projectId: string;
  automationId: string;
}

export function getAutomationDetailRoutePath({
  projectId,
  automationId,
}: AutomationDetailRoutePathArgs): string {
  return `${AUTOMATIONS_ROUTE_PATH}/${encodeURIComponent(
    projectId,
  )}/${encodeURIComponent(automationId)}`;
}

export function getAutomationEditRoutePath(
  args: AutomationDetailRoutePathArgs,
): string {
  return `${getAutomationDetailRoutePath(args)}/edit`;
}

export function getProjectSettingsRoutePath(projectId: string): string {
  return `/projects/${projectId}/settings`;
}

interface PluginPanelRoutePathArgs {
  pluginId: string;
  path: string;
  subPath?: string;
}

export function getPluginPanelRoutePath({
  pluginId,
  path,
  subPath,
}: PluginPanelRoutePathArgs): string {
  const root = `/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(path)}`;
  if (subPath === undefined || subPath === "") {
    return root;
  }
  const encoded = subPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return encoded.length > 0 ? `${root}/${encoded}` : root;
}

export function getThreadRoutePath(args: ThreadRoutePathArgs): string {
  return isProjectlessProjectId(args.projectId)
    ? `/threads/${args.threadId}`
    : `/projects/${args.projectId}/threads/${args.threadId}`;
}

const baseRoutePatterns: readonly string[] = [
  APP_ROOT_ROUTE_PATH,
  AUTH_CALLBACK_ROUTE_PATH,
  SETTINGS_ROUTE_PATH,
  SETTINGS_SECTION_ROUTE_PATH,
  SETTINGS_PLUGINS_ROUTE_PATH,
  SETTINGS_PLUGIN_ROUTE_PATH,
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
  AUTOMATIONS_ROUTE_PATH,
  AUTOMATIONS_BROWSE_ROUTE_PATH,
  AUTOMATION_DETAIL_ROUTE_PATH,
  AUTOMATION_EDIT_ROUTE_PATH,
  LEGACY_PROJECT_COMPOSE_ROUTE_PATH,
  PROJECTLESS_ARCHIVED_ROUTE_PATH,
  PROJECT_SETTINGS_ROUTE_PATH,
  PROJECT_ARCHIVED_ROUTE_PATH,
  PROJECTLESS_THREAD_DETAIL_ROUTE_PATH,
  THREAD_DETAIL_ROUTE_PATH,
  PLUGIN_PANEL_ROUTE_PATH,
];

export const ROUTE_PATTERNS = baseRoutePatterns;

export function stripRoutePathSuffix(path: string): string {
  const queryIndex = path.indexOf("?");
  const hashIndex = path.indexOf("#");
  const suffixIndex =
    queryIndex === -1
      ? hashIndex
      : hashIndex === -1
        ? queryIndex
        : Math.min(queryIndex, hashIndex);
  return suffixIndex === -1 ? path : path.slice(0, suffixIndex);
}
