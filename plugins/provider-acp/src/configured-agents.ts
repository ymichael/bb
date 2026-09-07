import {
  customAcpAgentDefinition,
  formatCustomAcpProviderId,
  parseCustomAcpAgents,
  type AcpAgentDefinition,
} from "./agents.js";
import { legacyAgentDeprecationMessage } from "./legacy-config.js";

export interface ResolveConfiguredAcpAgentsArgs {
  settingValue: string | undefined;
  legacyEntries: readonly unknown[];
  legacyProblem?: string;
  reservedProviderIds: ReadonlySet<string>;
  shippedAgents: readonly AcpAgentDefinition[];
}

export interface ResolveConfiguredAcpAgentsResult {
  agents: AcpAgentDefinition[];
  warnings: string[];
}

export function resolveConfiguredAcpAgents(
  args: ResolveConfiguredAcpAgentsArgs,
): ResolveConfiguredAcpAgentsResult {
  const warnings: string[] = [];
  const entries: unknown[] = [];
  const trimmed = args.settingValue?.trim() ?? "";
  if (trimmed.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      parsed = undefined;
      warnings.push(
        `The ACP "customAgents" setting is not valid JSON; ignoring it: ${String(error)}`,
      );
    }
    if (parsed !== undefined) {
      if (Array.isArray(parsed)) {
        entries.push(...parsed);
      } else {
        warnings.push(
          'The ACP "customAgents" setting must be a JSON array; ignoring it.',
        );
      }
    }
  }

  const configured = parseCustomAcpAgents({
    entries,
    reservedProviderIds: args.reservedProviderIds,
  });
  for (const problem of configured.problems) {
    warnings.push(`ACP custom agent setting: ${problem}`);
  }

  if (args.legacyProblem !== undefined) {
    warnings.push(`Deprecated ACP agent config: ${args.legacyProblem}`);
  }
  const legacy = parseCustomAcpAgents({
    entries: args.legacyEntries,
    reservedProviderIds: args.reservedProviderIds,
  });
  for (const problem of legacy.problems) {
    warnings.push(`Deprecated ACP agent config: ${problem}`);
  }

  const bySlug = new Map(configured.agents.map((agent) => [agent.id, agent]));
  for (const agent of legacy.agents) {
    if (bySlug.has(agent.id)) {
      continue;
    }
    warnings.push(legacyAgentDeprecationMessage(agent));
    bySlug.set(agent.id, agent);
  }
  const shippedById = new Map(
    args.shippedAgents.map((agent) => [agent.id, agent]),
  );
  return {
    agents: [...bySlug.values()].map((agent) =>
      customAcpAgentDefinition(
        agent,
        shippedById.get(formatCustomAcpProviderId(agent.id)),
      ),
    ),
    warnings,
  };
}
