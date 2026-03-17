import {
  DEFAULT_THREAD_PROVIDER_ID,
  isThreadProviderId,
  THREAD_PROVIDER_IDS,
  type SystemProviderInfo,
  type ThreadProviderId,
} from "@bb/core";
import { createClaudeCodeProviderAdapter } from "./claude-code-provider-adapter.js";
import { createCodexProviderAdapter } from "./codex-provider-adapter.js";
import { createPiProviderAdapter } from "./pi-provider-adapter.js";
import type { ProviderAdapter } from "./provider-adapter.js";

export interface CreateProviderAdapterOptions {
  providerId?: string;
}

export function createProviderForId(
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

/**
 * Resolve the default provider ID.
 *
 * Checks the server/provider override (`BB_PROVIDER`), then the
 * test/env-var override (`BB_E2E_PROVIDER`),
 * then falls back to the compile-time default (codex).
 */
export function resolveDefaultProviderId(
  env: NodeJS.ProcessEnv = process.env,
): ThreadProviderId {
  const configuredDefault = env.BB_PROVIDER;
  if (configuredDefault && isThreadProviderId(configuredDefault.trim().toLowerCase())) {
    return configuredDefault.trim().toLowerCase() as ThreadProviderId;
  }

  const testOverride = env.BB_E2E_PROVIDER;
  if (testOverride && isThreadProviderId(testOverride.trim().toLowerCase())) {
    return testOverride.trim().toLowerCase() as ThreadProviderId;
  }
  return DEFAULT_THREAD_PROVIDER_ID; // "codex"
}

export function createProviderAdapter(
  opts?: CreateProviderAdapterOptions,
): ProviderAdapter {
  const providerId = (
    opts?.providerId ??
    resolveDefaultProviderId()
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
