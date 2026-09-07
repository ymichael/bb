export interface PluginSettingsCandidate {
  enabled: boolean;
  hasSettings: boolean;
  icon: string | null;
  id: string;
  name: string | null;
}

interface PluginSettingsSectionOwner {
  pluginId: string;
}

export interface PluginSettingsEntry {
  icon: string | null;
  id: string;
  label: string;
}

interface BuildPluginSettingsEntriesArgs {
  installedPlugins: readonly PluginSettingsCandidate[];
  settingsSections: readonly PluginSettingsSectionOwner[];
}

export function buildPluginSettingsEntries(
  args: BuildPluginSettingsEntriesArgs,
): readonly PluginSettingsEntry[] {
  const pluginsWithCustomSettings = new Set(
    args.settingsSections.map((section) => section.pluginId),
  );
  return args.installedPlugins
    .filter(
      (plugin) =>
        plugin.enabled &&
        (plugin.hasSettings || pluginsWithCustomSettings.has(plugin.id)),
    )
    .map((plugin) => ({
      id: plugin.id,
      label: plugin.name ?? plugin.id,
      icon: plugin.icon,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}
