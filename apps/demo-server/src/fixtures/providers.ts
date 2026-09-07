import type { AvailableModel, ProviderInfo } from "@bb/domain";
import type { SystemExecutionOptionsResponse } from "@bb/server-contract";

function provider(
  info: Pick<
    ProviderInfo,
    "id" | "displayName" | "capabilities" | "composerActions"
  >,
): ProviderInfo {
  return {
    ...info,
    pluginId: `provider-${info.id}`,
    available: true,
    logoUrl: `/api/v1/system/providers/${info.id}/logo`,
    maintenance: { health: false, usage: false, installation: false },
  };
}

const SKILLS_ACTION = { kind: "skills", trigger: "/" } as const;
const PLAN_ACTION = {
  kind: "plan",
  command: { trigger: "/", name: "plan", trailingText: " " },
} as const;

export const PROVIDERS: readonly ProviderInfo[] = [
  provider({
    id: "codex",
    displayName: "Codex",
    capabilities: {
      supportsThreadArchive: true,
      supportsThreadRename: true,
      supportsServiceTier: true,
      supportsNativeUserQuestion: false,
      permissionModes: ["accept-edits", "auto", "full"],
      supportsFork: true,
      supportsSessionRewind: true,
      modelCatalogScope: "workspace",
    },
    composerActions: [
      SKILLS_ACTION,
      PLAN_ACTION,
      {
        kind: "goal",
        command: { trigger: "/", name: "goal", trailingText: " " },
      },
    ],
  }),
  provider({
    id: "claude-code",
    displayName: "Claude Code",
    capabilities: {
      supportsThreadArchive: false,
      supportsThreadRename: false,
      supportsServiceTier: false,
      supportsNativeUserQuestion: true,
      permissionModes: ["accept-edits", "auto", "full"],
      supportsFork: true,
      supportsSessionRewind: true,
      modelCatalogScope: "workspace",
    },
    composerActions: [SKILLS_ACTION, PLAN_ACTION],
  }),
  provider({
    id: "pi",
    displayName: "Pi",
    capabilities: {
      supportsThreadArchive: false,
      supportsThreadRename: false,
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      permissionModes: ["full"],
      supportsFork: true,
      supportsSessionRewind: true,
      modelCatalogScope: "workspace",
    },
    composerActions: [SKILLS_ACTION],
  }),
];

const REASONING_EFFORTS = [
  {
    reasoningEffort: "low",
    description: "Fast responses with lighter reasoning",
  },
  {
    reasoningEffort: "medium",
    description: "Balances speed and reasoning depth for everyday tasks",
  },
  {
    reasoningEffort: "high",
    description: "Greater reasoning depth for complex problems",
  },
  {
    reasoningEffort: "xhigh",
    description: "Extra high reasoning depth for complex problems",
  },
] as const;

export const DEFAULT_MODEL = "gpt-5.6-sol";

const MODELS: readonly AvailableModel[] = [
  {
    id: DEFAULT_MODEL,
    model: DEFAULT_MODEL,
    displayName: "GPT-5.6-Sol",
    description: "Latest frontier agentic coding model.",
    supportedReasoningEfforts: [...REASONING_EFFORTS],
    defaultReasoningEffort: "high",
    isDefault: true,
  },
  {
    id: "gpt-5.6-luna",
    model: "gpt-5.6-luna",
    displayName: "GPT-5.6-Luna",
    description: "Fast and affordable agentic coding model.",
    supportedReasoningEfforts: [...REASONING_EFFORTS],
    defaultReasoningEffort: "medium",
    isDefault: false,
  },
];

export const SYSTEM_EXECUTION_OPTIONS: SystemExecutionOptionsResponse = {
  providers: [...PROVIDERS],
  permissionCeiling: "full",
  models: [...MODELS],
  selectedOnlyModels: [],
  modelLoadError: null,
};
