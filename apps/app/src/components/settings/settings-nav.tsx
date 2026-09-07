import { useMemo } from "react";
import { matchPath, useLocation } from "react-router-dom";
import { useHostDaemon, useLocalHostDaemonAccess } from "@/hooks/useHostDaemon";
import { usePluginSlots, type PluginFileOpenerSlot } from "@/lib/plugin-slots";
import { usePluginList } from "@/hooks/queries/plugin-settings-queries";
import {
  SETTINGS_MACHINE_ROUTE_PATH,
  SETTINGS_PLUGIN_ROUTE_PATH,
  SETTINGS_SECTION_ROUTE_PATH,
} from "@/lib/route-paths";
import {
  isSettingsSectionId,
  SETTINGS_NAV_SECTIONS,
  type SettingsNavSection,
  type SettingsSectionId,
} from "./settings-sections";
import {
  buildPluginSettingsEntries,
  type PluginSettingsEntry,
} from "./plugin-settings-entries";

export interface SettingsNavState {
  activeSection: SettingsSectionId | null;
  hasUnknownSection: boolean;
  activePluginId: string | null;
  pluginEntries: readonly PluginSettingsEntry[];
  sections: readonly SettingsNavSection[];
}

export function useSettingsNavSections(
  fileOpeners: readonly PluginFileOpenerSlot[],
): readonly SettingsNavSection[] {
  const { hasDaemon } = useHostDaemon();
  const { accessState } = useLocalHostDaemonAccess();

  return useMemo(
    () =>
      SETTINGS_NAV_SECTIONS.filter(
        (section) =>
          section.id !== "files" ||
          hasDaemon ||
          accessState !== "unavailable" ||
          fileOpeners.length > 0,
      ),
    [accessState, fileOpeners.length, hasDaemon],
  );
}

export function useSettingsNavState(): SettingsNavState {
  const location = useLocation();
  const { fileOpeners, settingsSections } = usePluginSlots();
  const sections = useSettingsNavSections(fileOpeners);
  const pluginListQuery = usePluginList({ enabled: true });

  const sectionMatch = matchPath(
    SETTINGS_SECTION_ROUTE_PATH,
    location.pathname,
  );
  const pluginMatch = matchPath(SETTINGS_PLUGIN_ROUTE_PATH, location.pathname);
  const isInstalledDetail =
    new URLSearchParams(location.search).get("view") === "installed";
  const activePluginId = isInstalledDetail
    ? null
    : (pluginMatch?.params.pluginId ?? null);
  const machineMatch = matchPath(
    SETTINGS_MACHINE_ROUTE_PATH,
    location.pathname,
  );
  const activeMachineId = machineMatch?.params.hostId ?? null;
  const sectionParam = sectionMatch?.params.section;
  const hasUnknownSection =
    sectionParam !== undefined && !isSettingsSectionId(sectionParam);
  const activeSection: SettingsSectionId | null =
    isInstalledDetail && pluginMatch !== null
      ? "plugins"
      : activeMachineId !== null
        ? "machines"
        : activePluginId !== null
          ? null
          : sectionParam !== undefined && isSettingsSectionId(sectionParam)
            ? sectionParam
            : "general";

  const installedPlugins = pluginListQuery.data?.plugins ?? [];
  const pluginEntries = buildPluginSettingsEntries({
    installedPlugins,
    settingsSections,
  });

  return {
    activePluginId,
    activeSection,
    hasUnknownSection,
    pluginEntries,
    sections,
  };
}
