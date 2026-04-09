import { z } from "zod";
import type {
  ProviderCapabilities,
  ProviderInfo,
} from "@bb/domain";

const AGENT_PROVIDER_ID_VALUES = ["codex", "claude-code", "pi"] as const;
export const agentProviderIdSchema = z.enum(AGENT_PROVIDER_ID_VALUES);
export type AgentProviderId = z.infer<typeof agentProviderIdSchema>;

const CLOUD_AUTH_PROVIDER_ID_VALUES = ["claude-code", "codex"] as const;
export const cloudAuthProviderIdSchema = z.enum(CLOUD_AUTH_PROVIDER_ID_VALUES);
export type CloudAuthProviderId = z.infer<typeof cloudAuthProviderIdSchema>;

const CLOUD_AUTH_CONSUMER_ID_VALUES = [
  "anthropic",
  "claude-code",
  "codex",
  "openai-codex",
] as const;
export const cloudAuthConsumerIdSchema = z.enum(CLOUD_AUTH_CONSUMER_ID_VALUES);
export type CloudAuthConsumerId = z.infer<typeof cloudAuthConsumerIdSchema>;

const CLOUD_AUTH_MODE_VALUES = ["subscription-oauth"] as const;
export const cloudAuthModeSchema = z.enum(CLOUD_AUTH_MODE_VALUES);
export type CloudAuthMode = z.infer<typeof cloudAuthModeSchema>;

export interface BuiltInAgentProviderInfo extends ProviderInfo {
  id: AgentProviderId;
}

export interface CloudAuthRuntimeConsumer {
  authConsumerId: CloudAuthConsumerId;
  runtimeProviderId: AgentProviderId;
}

export interface CloudAuthProviderCatalogEntry {
  authMode: CloudAuthMode;
  displayName: string;
  id: CloudAuthProviderId;
  runtimeConsumers: CloudAuthRuntimeConsumer[];
}

export interface BuiltInAgentProviderCatalogEntry {
  cloudAuth: CloudAuthProviderCatalogEntry | null;
  info: BuiltInAgentProviderInfo;
}

type PiDefaultModelPerProvider = Partial<Record<string, string>>;

const RENAME_AND_SERVICE_TIER_CAPABILITIES: ProviderCapabilities = {
  supportsRename: true,
  supportsServiceTier: true,
};

const BASIC_CAPABILITIES: ProviderCapabilities = {
  supportsRename: false,
  supportsServiceTier: false,
};

const BUILT_IN_AGENT_PROVIDER_CATALOG: BuiltInAgentProviderCatalogEntry[] = [
  {
    cloudAuth: {
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
    },
    info: {
      available: true,
      capabilities: RENAME_AND_SERVICE_TIER_CAPABILITIES,
      displayName: "Codex",
      id: "codex",
    },
  },
  {
    cloudAuth: {
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
    },
    info: {
      available: true,
      capabilities: BASIC_CAPABILITIES,
      displayName: "Claude Code",
      id: "claude-code",
    },
  },
  {
    cloudAuth: null,
    info: {
      available: true,
      capabilities: BASIC_CAPABILITIES,
      displayName: "Pi",
      id: "pi",
    },
  },
];

const builtInAgentProviderById = new Map(
  BUILT_IN_AGENT_PROVIDER_CATALOG.map((provider) => [provider.info.id, provider]),
);

const cloudAuthProviderById = new Map(
  BUILT_IN_AGENT_PROVIDER_CATALOG.flatMap((provider) =>
    provider.cloudAuth ? [[provider.cloudAuth.id, provider.cloudAuth] as const] : [],
  ),
);

const CLOUD_AUTH_PROVIDER_ORDER: CloudAuthProviderId[] = ["claude-code", "codex"];

/**
 * Best default model per provider. Subset of pi-mono's `defaultModelPerProvider`:
 * https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/model-resolver.ts
 */
export const PI_DEFAULT_MODEL_PER_PROVIDER: PiDefaultModelPerProvider = {
  anthropic: "claude-opus-4-6",
  openai: "gpt-5.4",
  "openai-codex": "gpt-5.4",
  "amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
  google: "gemini-2.5-pro",
  "google-gemini-cli": "gemini-2.5-pro",
  "google-vertex": "gemini-3-pro-preview",
  openrouter: "openai/gpt-5.1-codex",
  "vercel-ai-gateway": "anthropic/claude-opus-4-6",
  xai: "grok-4-fast-non-reasoning",
  mistral: "devstral-medium-latest",
};

function cloneCapabilities(capabilities: ProviderCapabilities): ProviderCapabilities {
  return {
    supportsRename: capabilities.supportsRename,
    supportsServiceTier: capabilities.supportsServiceTier,
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

function cloneCloudAuthProviderCatalogEntry(
  entry: CloudAuthProviderCatalogEntry,
): CloudAuthProviderCatalogEntry {
  return {
    authMode: entry.authMode,
    displayName: entry.displayName,
    id: entry.id,
    runtimeConsumers: entry.runtimeConsumers.map(cloneCloudAuthRuntimeConsumer),
  };
}

function cloneBuiltInAgentProviderCatalogEntry(
  entry: BuiltInAgentProviderCatalogEntry,
): BuiltInAgentProviderCatalogEntry {
  return {
    cloudAuth: entry.cloudAuth
      ? cloneCloudAuthProviderCatalogEntry(entry.cloudAuth)
      : null,
    info: cloneBuiltInAgentProviderInfo(entry.info),
  };
}

export function isAgentProviderId(value: string): value is AgentProviderId {
  return agentProviderIdSchema.safeParse(value).success;
}

export function isCloudAuthProviderId(value: string): value is CloudAuthProviderId {
  return cloudAuthProviderIdSchema.safeParse(value).success;
}

export function listBuiltInAgentProviders(): BuiltInAgentProviderCatalogEntry[] {
  return BUILT_IN_AGENT_PROVIDER_CATALOG.map(cloneBuiltInAgentProviderCatalogEntry);
}

export function listBuiltInAgentProviderInfos(): BuiltInAgentProviderInfo[] {
  return BUILT_IN_AGENT_PROVIDER_CATALOG.map((provider) =>
    cloneBuiltInAgentProviderInfo(provider.info)
  );
}

export function getBuiltInAgentProvider(
  providerId: AgentProviderId,
): BuiltInAgentProviderCatalogEntry {
  const provider = builtInAgentProviderById.get(providerId);
  if (!provider) {
    throw new Error(`Unsupported agent provider "${providerId}".`);
  }
  return cloneBuiltInAgentProviderCatalogEntry(provider);
}

export function getBuiltInAgentProviderInfo(
  providerId: AgentProviderId,
): BuiltInAgentProviderInfo {
  return getBuiltInAgentProvider(providerId).info;
}

export function listCloudAuthProviders(): CloudAuthProviderCatalogEntry[] {
  return CLOUD_AUTH_PROVIDER_ORDER.map((providerId) =>
    getCloudAuthProvider(providerId)
  );
}

export function getCloudAuthProvider(
  providerId: CloudAuthProviderId,
): CloudAuthProviderCatalogEntry {
  const provider = cloudAuthProviderById.get(providerId);
  if (!provider) {
    throw new Error(`Unsupported cloud auth provider "${providerId}".`);
  }
  return cloneCloudAuthProviderCatalogEntry(provider);
}

export function resolvePiDefaultModelId(providerId: string): string | undefined {
  return PI_DEFAULT_MODEL_PER_PROVIDER[providerId];
}
