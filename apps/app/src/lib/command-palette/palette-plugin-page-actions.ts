import type { PluginNavPanelSlot } from "@/lib/plugin-slots";
import { getPluginPanelRoutePath } from "@/lib/route-paths";
import type { PaletteAction } from "./palette-action";

interface BuildPluginPagePaletteActionsArgs {
  navigate: (path: string) => void;
  panels: readonly PluginNavPanelSlot[];
}

export function buildPluginPagePaletteActions(
  args: BuildPluginPagePaletteActionsArgs,
): PaletteAction[] {
  return args.panels.map((panel) => ({
    id: `plugin-page:${panel.pluginId}/${panel.id}`,
    group: "Plugin pages",
    title: panel.title,
    shortcut: null,
    run: () =>
      args.navigate(
        getPluginPanelRoutePath({
          pluginId: panel.pluginId,
          path: panel.path,
        }),
      ),
  }));
}
