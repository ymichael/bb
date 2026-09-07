import {
  getSettingsSectionRoutePath,
  type SettingsNavSection,
} from "@/components/settings/settings-sections";
import type { PluginSettingsEntry } from "@/components/settings/plugin-settings-entries";
import { getPluginConfigurationRoutePath } from "@/lib/route-paths";
import type { PaletteAction } from "./palette-action";

interface BuildSettingsPaletteActionsArgs {
  navigate: (path: string) => void;
  pluginEntries: readonly PluginSettingsEntry[];
  sections: readonly SettingsNavSection[];
}

export function buildSettingsPaletteActions(
  args: BuildSettingsPaletteActionsArgs,
): PaletteAction[] {
  return [
    ...args.sections.map((section) => ({
      id: `settings:${section.id}`,
      group: "Settings",
      title: `${section.label} settings`,
      shortcut: null,
      run: () => args.navigate(getSettingsSectionRoutePath(section.id)),
    })),
    ...args.pluginEntries.map((plugin) => ({
      id: `settings:plugin:${plugin.id}`,
      group: "Plugin settings",
      title: `${plugin.label} settings`,
      shortcut: null,
      run: () =>
        args.navigate(getPluginConfigurationRoutePath({ pluginId: plugin.id })),
    })),
  ];
}
