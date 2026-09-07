import type { PluginListItem } from "@/hooks/queries/plugin-settings-queries";

const USER_FILTER_ID = "user";

export function pluginPublisherFilterId(plugin: PluginListItem): string {
  return plugin.publisherLabel === null
    ? USER_FILTER_ID
    : `publisher:${plugin.publisherLabel}`;
}

export function pluginPublisherFilterOptions(
  plugins: readonly PluginListItem[],
): { id: string; label: string }[] {
  const publishers = new Set<string>();
  let hasUserPlugin = false;
  for (const plugin of plugins) {
    if (plugin.publisherLabel === null) hasUserPlugin = true;
    else publishers.add(plugin.publisherLabel);
  }
  const options = [...publishers]
    .sort((left, right) => left.localeCompare(right))
    .map((label) => ({ id: `publisher:${label}`, label }));
  if (hasUserPlugin) options.push({ id: USER_FILTER_ID, label: "User" });
  return options;
}
