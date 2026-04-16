import { z } from "zod";
import type {
  ProviderCapabilities,
  ProviderInfo,
} from "@bb/domain";

const AGENT_PROVIDER_ID_VALUES = ["codex", "claude-code", "pi"] as const;
export const agentProviderIdSchema = z.enum(AGENT_PROVIDER_ID_VALUES);
export type AgentProviderId = z.infer<typeof agentProviderIdSchema>;

const CLOUD_AUTH_CONSUMER_ID_VALUES = [
  "anthropic",
  "claude-code",
  "codex",
  "openai-codex",
] as const;
type CloudAuthConsumerId = (typeof CLOUD_AUTH_CONSUMER_ID_VALUES)[number];

export interface BuiltInAgentProviderInfo extends ProviderInfo {
  id: AgentProviderId;
}

export interface CloudAuthRuntimeConsumer {
  authConsumerId: CloudAuthConsumerId;
  runtimeProviderId: AgentProviderId;
}

export interface CloudAuthProviderCatalogEntry<TId extends string = string> {
  authMode: "subscription-oauth";
  displayName: string;
  id: TId;
  runtimeConsumers: CloudAuthRuntimeConsumer[];
}

export interface BuiltInAgentProviderCatalogEntry {
  cloudAuth: CloudAuthProviderCatalogEntry | null;
  info: BuiltInAgentProviderInfo;
}

type PiDefaultModelPerProvider = Partial<Record<string, string>>;

const CODEX_CAPABILITIES: ProviderCapabilities = {
  supportsRename: true,
  supportsServiceTier: true,
  supportedPermissionModes: ["full", "workspace-write", "readonly"],
};

const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  supportsRename: false,
  supportsServiceTier: false,
  supportedPermissionModes: ["full", "workspace-write", "readonly"],
};

const PI_CAPABILITIES: ProviderCapabilities = {
  supportsRename: false,
  supportsServiceTier: false,
  supportedPermissionModes: ["full"],
};

const CLAUDE_CLOUD_AUTH_PROVIDER = {
  authMode: "subscription-oauth",
  displayName: "Claude Code",
  id: "claude-code",
  runtimeConsumers: [
    {
      authConsumerId: "claude-code",
      runtimeProviderId: "claude-code",
    },
    {
      authConsumerId: "anthropic",
      runtimeProviderId: "pi",
    },
  ],
} satisfies CloudAuthProviderCatalogEntry<"claude-code">;

const CODEX_CLOUD_AUTH_PROVIDER = {
  authMode: "subscription-oauth",
  displayName: "Codex",
  id: "codex",
  runtimeConsumers: [
    {
      authConsumerId: "codex",
      runtimeProviderId: "codex",
    },
    {
      authConsumerId: "openai-codex",
      runtimeProviderId: "pi",
    },
  ],
} satisfies CloudAuthProviderCatalogEntry<"codex">;

const CLOUD_AUTH_PROVIDER_CATALOG = [
  CODEX_CLOUD_AUTH_PROVIDER,
  CLAUDE_CLOUD_AUTH_PROVIDER,
] as const;

const CLOUD_AUTH_PROVIDER_ID_VALUES = CLOUD_AUTH_PROVIDER_CATALOG.map(
  (provider) => provider.id,
) as [
  (typeof CLOUD_AUTH_PROVIDER_CATALOG)[number]["id"],
  ...(typeof CLOUD_AUTH_PROVIDER_CATALOG)[number]["id"][],
];

export const cloudAuthProviderIdSchema = z.enum(
  CLOUD_AUTH_PROVIDER_ID_VALUES,
);
export type CloudAuthProviderId = z.infer<typeof cloudAuthProviderIdSchema>;

const BUILT_IN_AGENT_PROVIDER_CATALOG: BuiltInAgentProviderCatalogEntry[] = [
  {
    cloudAuth: CODEX_CLOUD_AUTH_PROVIDER,
    info: {
      available: true,
      capabilities: CODEX_CAPABILITIES,
      displayName: "Codex",
      id: "codex",
    },
  },
  {
    cloudAuth: CLAUDE_CLOUD_AUTH_PROVIDER,
    info: {
      available: true,
      capabilities: CLAUDE_CAPABILITIES,
      displayName: "Claude Code",
      id: "claude-code",
    },
  },
  {
    cloudAuth: null,
    info: {
      available: true,
      capabilities: PI_CAPABILITIES,
      displayName: "Pi",
      id: "pi",
    },
  },
];

const builtInAgentProviderById = new Map(
  BUILT_IN_AGENT_PROVIDER_CATALOG.map((provider) => [provider.info.id, provider]),
);

const cloudAuthProviderById = new Map(
  CLOUD_AUTH_PROVIDER_CATALOG.map((provider) => [provider.id, provider] as const),
);

/**
 * Best default model per provider. Subset of pi-mono's `defaultModelPerProvider`:
 * https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/model-resolver.ts
 */
export const PI_DEFAULT_MODEL_PER_PROVIDER: PiDefaultModelPerProvider = {
  anthropic: "claude-opus-4-7",
  openai: "gpt-5.4",
  "openai-codex": "gpt-5.4",
  "amazon-bedrock": "us.anthropic.claude-opus-4-7",
  google: "gemini-2.5-pro",
  "google-gemini-cli": "gemini-2.5-pro",
  "google-vertex": "gemini-3-pro-preview",
  openrouter: "openai/gpt-5.1-codex",
  "vercel-ai-gateway": "anthropic/claude-opus-4.7",
  xai: "grok-4-fast-non-reasoning",
  mistral: "devstral-medium-latest",
};

function cloneCapabilities(capabilities: ProviderCapabilities): ProviderCapabilities {
  return {
    supportsRename: capabilities.supportsRename,
    supportsServiceTier: capabilities.supportsServiceTier,
    supportedPermissionModes: [...capabilities.supportedPermissionModes],
  };
}

function cloneBuiltInAgentProviderInfo(
  info: BuiltInAgentProviderInfo,
): BuiltInAgentProviderInfo {
  return {
    available: info.available,
    capabilities: cloneCapabilities(info.capabilities),
    displayName: info.displayName,
    id: info.id,
  };
}

function cloneCloudAuthRuntimeConsumer(
  consumer: CloudAuthRuntimeConsumer,
): CloudAuthRuntimeConsumer {
  return {
    authConsumerId: consumer.authConsumerId,
    runtimeProviderId: consumer.runtimeProviderId,
  };
}

function cloneCloudAuthProviderCatalogEntry<TId extends string>(
  entry: CloudAuthProviderCatalogEntry<TId>,
): CloudAuthProviderCatalogEntry<TId> {
  return {
    authMode: entry.authMode,
    displayName: entry.displayName,
    id: entry.id,
    runtimeConsumers: entry.runtimeConsumers.map(cloneCloudAuthRuntimeConsumer),
  };
}

export function isAgentProviderId(value: string): value is AgentProviderId {
  return agentProviderIdSchema.safeParse(value).success;
}

export function listBuiltInAgentProviderInfos(): BuiltInAgentProviderInfo[] {
  return BUILT_IN_AGENT_PROVIDER_CATALOG.map((provider) =>
    cloneBuiltInAgentProviderInfo(provider.info)
  );
}

export function getBuiltInAgentProviderInfo(
  providerId: AgentProviderId,
): BuiltInAgentProviderInfo {
  const provider = builtInAgentProviderById.get(providerId);
  if (!provider) {
    throw new Error(`Unsupported agent provider "${providerId}".`);
  }
  return cloneBuiltInAgentProviderInfo(provider.info);
}

export function listCloudAuthProviders(): CloudAuthProviderCatalogEntry<CloudAuthProviderId>[] {
  return CLOUD_AUTH_PROVIDER_CATALOG.map((provider) =>
    cloneCloudAuthProviderCatalogEntry(provider)
  );
}

export function getCloudAuthProvider(
  providerId: CloudAuthProviderId,
): CloudAuthProviderCatalogEntry<CloudAuthProviderId> {
  const provider = cloudAuthProviderById.get(providerId);
  if (!provider) {
    throw new Error(`Unsupported cloud auth provider "${providerId}".`);
  }
  return cloneCloudAuthProviderCatalogEntry(provider);
}

export function resolvePiDefaultModelId(providerId: string): string | undefined {
  return PI_DEFAULT_MODEL_PER_PROVIDER[providerId];
}
