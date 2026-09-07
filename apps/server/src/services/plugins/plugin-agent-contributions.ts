import type { ToolCallResponse } from "@bb/domain";
import type { HostDaemonContributedEnvEntry } from "@bb/host-daemon-contract";
import type { ExperimentalPluginProviderEnvContext } from "@get-bb/plugin-sdk";
import type {
  PluginAgentConfigurationContext,
  PluginAgentToolContext,
  PluginAgentToolRecord,
} from "./plugin-api.js";
import type {
  PluginAgentToolContribution,
  PluginMentionResolveResult,
  PluginService,
  PluginSkillRootContribution,
} from "./plugin-service.js";

type PluginAgentContributions = Pick<
  PluginService,
  | "listSkillRootContributions"
  | "listAgentTools"
  | "listInstructionContributions"
  | "findAgentTool"
  | "invokeAgentTool"
  | "resolveMention"
> &
  Partial<
    Pick<
      PluginService,
      | "resolveAgentConfiguration"
      | "resolveProviderEnv"
      | "resolveProviderEnvHealth"
    >
  >;

let contributions: PluginAgentContributions | undefined;

export function setPluginAgentContributions(
  next: PluginAgentContributions | undefined,
): void {
  contributions = next;
}

export function getPluginSkillRootContributions(): PluginSkillRootContribution[] {
  return contributions?.listSkillRootContributions() ?? [];
}

export function listPluginAgentTools(): PluginAgentToolContribution[] {
  return contributions?.listAgentTools() ?? [];
}

export async function resolvePluginAgentConfiguration(args: {
  context: PluginAgentConfigurationContext;
  skillIdsByPlugin: ReadonlyMap<string, readonly string[]>;
}) {
  const active = contributions;
  if (!active?.resolveAgentConfiguration) {
    return {
      tools: active?.listAgentTools() ?? [],
      selectedSkillIdsByPlugin: new Map<string, ReadonlySet<string>>(),
      dynamicInstructions: [] as Array<{ pluginId: string; text: string }>,
    };
  }
  return active.resolveAgentConfiguration(args);
}

export function listPluginInstructionContributions(): Array<{
  pluginId: string;
  provider: (ctx: { threadId: string; projectId: string }) => string | null;
}> {
  return contributions?.listInstructionContributions() ?? [];
}

export async function resolvePluginProviderEnv(args: {
  providerId: string;
  context: ExperimentalPluginProviderEnvContext;
}): Promise<HostDaemonContributedEnvEntry[]> {
  const active = contributions;
  if (!active?.resolveProviderEnv) return [];
  return (await active.resolveProviderEnv(args)).entries;
}

export async function resolvePluginProviderEnvHealth(args: {
  providerId: string;
  hostId: string;
}) {
  const active = contributions;
  if (!active?.resolveProviderEnvHealth) return null;
  return active.resolveProviderEnvHealth({
    providerId: args.providerId,
    context: { hostId: args.hostId },
  });
}

export function findPluginAgentTool(
  name: string,
): { pluginId: string; record: PluginAgentToolRecord } | undefined {
  return contributions?.findAgentTool(name);
}

export async function resolvePluginMention(args: {
  pluginId: string;
  itemId: string;
}): Promise<PluginMentionResolveResult> {
  const active = contributions;
  if (!active) {
    return {
      ok: false,
      error: "plugin mention resolution is unavailable on this server",
    };
  }
  return active.resolveMention(args);
}

export async function invokePluginAgentTool(
  tool: { pluginId: string; record: PluginAgentToolRecord },
  args: { input: unknown; ctx: PluginAgentToolContext },
): Promise<ToolCallResponse> {
  const active = contributions;
  if (!active) {
    return {
      success: false,
      contentItems: [
        { type: "inputText", text: `Unsupported tool: ${tool.record.name}` },
      ],
    };
  }
  return active.invokeAgentTool({
    pluginId: tool.pluginId,
    record: tool.record,
    input: args.input,
    ctx: args.ctx,
  });
}
