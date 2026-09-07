import type {
  PluginProviderCapabilities,
  PluginProviderDeclaration,
  PluginProviderStrings,
} from "@get-bb/plugin-sdk";
import { ACP_FAMILY, type AcpAgentDefinition } from "./agents.js";

const ACP_BASE_CAPABILITIES: PluginProviderCapabilities = {
  supportsServiceTier: true,
  supportsNativeUserQuestion: false,
  supportsManualCompaction: false,
  supportsThreadArchive: false,
  supportsThreadRename: false,
  fork: "none",
  permissionModes: ["accept-edits", "full"],
  reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
};

const ACP_SERVICE_TIERS = [
  { id: "default", label: "Default" },
  { id: "fast", label: "Fast" },
] as const;

const DEFAULT_FORK = "none" as const;

function acpStrings(agent: AcpAgentDefinition): PluginProviderStrings {
  const signIn = agent.signInCommand;
  return {
    signInHint:
      signIn === undefined
        ? `Sign in to ${agent.displayName} on the machine, then reload.`
        : `Run \`${signIn}\` on the machine to sign in.`,
    expiredHint:
      signIn === undefined
        ? `Your ${agent.displayName} session expired. Sign in on the machine, then reload.`
        : `Your ${agent.displayName} session expired. Run \`${signIn}\`, then reload.`,
    installUrl: agent.installUrl ?? "https://agentclientprotocol.com",
    ...(agent.iconTint === undefined ? {} : { iconTint: agent.iconTint }),
  };
}

export function acpProviderDeclaration(
  agent: AcpAgentDefinition,
): PluginProviderDeclaration {
  return {
    id: agent.id,
    displayName: agent.displayName,
    family: ACP_FAMILY,
    ...(agent.icon === undefined ? {} : { icon: agent.icon }),
    strings: acpStrings(agent),
    serviceTiers: [...ACP_SERVICE_TIERS],
    ...(agent.visibility === undefined
      ? {}
      : { experimental_visibility: agent.visibility }),
    ...(agent.launch.nativeSkillRoots === undefined
      ? {}
      : {
          experimental_nativeSkillRoots: {
            user: [...agent.launch.nativeSkillRoots.user],
            project: [...agent.launch.nativeSkillRoots.project],
          },
        }),
    ...(agent.nativeRootsResolver === undefined
      ? {}
      : { experimental_resolvesNativeRoots: true }),
    experimental_bridgeOptions: {
      ...(agent.dialect === undefined ? {} : { acpDialect: agent.dialect }),
      ...(agent.parameterizedModelPicker === true
        ? { parameterizedModelPicker: true }
        : {}),
      ...(agent.primaryModels === undefined
        ? {}
        : { primaryModels: [...agent.primaryModels] }),
      ...(agent.reasoningProbePriorityModelIds === undefined
        ? {}
        : {
            reasoningProbePriorityModelIds: [
              ...agent.reasoningProbePriorityModelIds,
            ],
          }),
      acpLaunchSpec: { ...agent.launch },
    },
    models: { scope: "host" },
    maintenance: {
      health: true,
      usage: agent.providerUsage === true,
      installation: agent.providerInstallation === true,
    },
    capabilities: {
      ...ACP_BASE_CAPABILITIES,
      fork: agent.fork ?? DEFAULT_FORK,
      permissionModes: [...ACP_BASE_CAPABILITIES.permissionModes],
      ...(agent.supportsManualCompaction === true
        ? { supportsManualCompaction: true }
        : {}),
      reasoningLevels:
        agent.reasoningLevels === undefined
          ? [...ACP_BASE_CAPABILITIES.reasoningLevels]
          : [...agent.reasoningLevels],
    },
    composerActions: [],
  };
}
