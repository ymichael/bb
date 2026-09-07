import type { PluginListItem } from "@/hooks/queries/plugin-settings-queries";

export function pluginNeedsAttention(
  plugin: Pick<PluginListItem, "enabled" | "status">,
): boolean {
  return (
    plugin.enabled &&
    (plugin.status === "incompatible" ||
      plugin.status === "error" ||
      plugin.status === "missing")
  );
}

export function pluginsNeedingAttention(
  plugins: readonly PluginListItem[],
): PluginListItem[] {
  return plugins.filter(pluginNeedsAttention);
}

export function pluginAttentionLabel(
  plugins: readonly PluginListItem[],
): string {
  if (plugins.length !== 1) return `${plugins.length} plugins are not running`;
  const [plugin] = plugins;
  const name = plugin.name ?? plugin.id;
  const word =
    plugin.status === "incompatible" ? "incompatible" : "not running";
  const detail = plugin.statusDetail ?? "";
  return detail.length > 0 && detail.length <= 80
    ? `${name} is ${word}: ${detail}`
    : `${name} is ${word}`;
}
