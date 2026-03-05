import type { SystemProviderInfo } from "@beanbag/agent-core";
import { createCodexProviderAdapter } from "./codex-provider-adapter.js";
import type { ProviderAdapter } from "./provider-adapter.js";

export interface CreateProviderAdapterOptions {
  providerId?: string;
}

const SUPPORTED_PROVIDER_IDS = ["codex"] as const;
type SupportedProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

function createProviderForId(
  providerId: SupportedProviderId,
): ProviderAdapter {
  switch (providerId) {
    case "codex":
      return createCodexProviderAdapter();
    default:
      throw new Error(`Unsupported provider "${providerId}"`);
  }
}

export function listAvailableProviderInfos(): SystemProviderInfo[] {
  return SUPPORTED_PROVIDER_IDS.map((providerId) => {
    const provider = createProviderForId(providerId);
    return {
      id: provider.id,
      displayName: provider.displayName,
      capabilities: { ...provider.capabilities },
    };
  });
}

export function createProviderAdapter(
  opts?: CreateProviderAdapterOptions,
): ProviderAdapter {
  const providerId = (
    opts?.providerId ??
    process.env.BEANBAG_PROVIDER ??
    "codex"
  )
    .trim()
    .toLowerCase();

  if (!SUPPORTED_PROVIDER_IDS.includes(providerId as SupportedProviderId)) {
    throw new Error(
      `Unsupported provider "${providerId}". Supported providers: ${SUPPORTED_PROVIDER_IDS.join(", ")}.`,
    );
  }

  return createProviderForId(providerId as SupportedProviderId);
}
