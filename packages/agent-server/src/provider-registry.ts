import {
  isThreadProviderId,
  THREAD_PROVIDER_IDS,
  type SystemProviderInfo,
  type ThreadProviderId,
} from "@beanbag/agent-core";
import { createClaudeCodeProviderAdapter } from "./claude-code-provider-adapter.js";
import { createCodexProviderAdapter } from "./codex-provider-adapter.js";
import { createPiProviderAdapter } from "./pi-provider-adapter.js";
import type { ProviderAdapter } from "./provider-adapter.js";

export interface CreateProviderAdapterOptions {
  providerId?: string;
}

function createProviderForId(
  providerId: ThreadProviderId,
): ProviderAdapter {
  switch (providerId) {
    case "codex":
      return createCodexProviderAdapter();
    case "claude-code":
      return createClaudeCodeProviderAdapter();
    case "pi":
      return createPiProviderAdapter();
    default:
      throw new Error(`Unsupported provider "${providerId}"`);
  }
}

export function listAvailableProviderInfos(): SystemProviderInfo[] {
  return THREAD_PROVIDER_IDS.map((providerId) => {
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

  if (!isThreadProviderId(providerId)) {
    throw new Error(
      `Unsupported provider "${providerId}". Supported providers: ${THREAD_PROVIDER_IDS.join(", ")}.`,
    );
  }

  return createProviderForId(providerId);
}
