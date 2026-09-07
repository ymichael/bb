import type { PluginMentionSearchGroup } from "./queries/plugin-contribution-queries";
import type { PromptMentionSuggestion } from "@bb/client-core";

type PluginMentionSuggestion = Extract<
  PromptMentionSuggestion,
  { kind: "plugin" }
>;
export function buildPluginMentionSuggestions(
  groups: readonly PluginMentionSearchGroup[],
): PluginMentionSuggestion[] {
  const suggestions: PluginMentionSuggestion[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      const title = item.title.trim();
      if (title.length === 0) continue;
      suggestions.push({
        kind: "plugin",
        pluginId: group.pluginId,
        providerId: group.providerId,
        itemId: item.itemId,
        providerLabel: group.label,
        title,
        subtitle: item.subtitle,
        icon: item.icon,
        replacement: title,
      });
    }
  }
  return suggestions;
}
