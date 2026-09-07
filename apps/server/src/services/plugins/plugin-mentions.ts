import type { PromptInput } from "@bb/domain";
import { ApiError } from "../../errors.js";
import { resolvePluginMention } from "./plugin-agent-contributions.js";

type PluginMentionResource = Extract<
  Extract<PromptInput, { type: "text" }>["mentions"][number]["resource"],
  { kind: "plugin" }
>;

function collectPluginMentionResources(
  input: readonly PromptInput[],
): PluginMentionResource[] {
  const seen = new Set<string>();
  const resources: PluginMentionResource[] = [];
  for (const item of input) {
    if (item.type !== "text") continue;
    for (const mention of item.mentions) {
      const resource = mention.resource;
      if (resource.kind !== "plugin") continue;
      const key = `${resource.pluginId}::${resource.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resources.push(resource);
    }
  }
  return resources;
}

export async function resolvePluginMentionContextInputs(
  input: readonly PromptInput[],
): Promise<PromptInput[]> {
  const resources = collectPluginMentionResources(input);
  if (resources.length === 0) return [];
  const contextInputs: PromptInput[] = [];
  for (const resource of resources) {
    const result = await resolvePluginMention({
      pluginId: resource.pluginId,
      itemId: resource.itemId,
    });
    if (!result.ok) {
      throw new ApiError(
        422,
        "plugin_mention_resolve_failed",
        `Could not resolve @${resource.label} (plugin "${resource.pluginId}"): ${result.error}`,
      );
    }
    contextInputs.push({
      type: "text",
      text: `Context for @${resource.label} (resolved by plugin "${resource.pluginId}"):\n\n${result.context}`,
      mentions: [],
      visibility: "agent-only",
    });
  }
  return contextInputs;
}
