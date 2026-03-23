/**
 * Provider registry.
 *
 * Manages the set of available built-in provider adapters (codex, claude-code, pi).
 */

import { createClaudeCodeProviderAdapter } from "./claude-code/adapter.js";
import { createCodexProviderAdapter } from "./codex/adapter.js";
import { createPiProviderAdapter } from "./pi/adapter.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import type { ProviderInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

type ProviderFactory = () => ProviderAdapter;

const builtInFactories = new Map<string, ProviderFactory>([
  ["codex", createCodexProviderAdapter],
  ["claude-code", createClaudeCodeProviderAdapter],
  ["pi", createPiProviderAdapter],
]);

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Create a provider adapter by ID.
 *
 * Looks up built-in providers. Throws if the ID is not found.
 */
export function createProviderForId(providerId: string): ProviderAdapter {
  const factory = builtInFactories.get(providerId);

  if (!factory) {
    const allIds = [...builtInFactories.keys()];
    throw new Error(
      `Unsupported provider "${providerId}". Available providers: ${allIds.join(", ")}.`,
    );
  }

  return factory();
}

/**
 * List info for all available built-in providers.
 */
export function listAvailableProviderInfos(): ProviderInfo[] {
  const infos: ProviderInfo[] = [];

  for (const [id] of builtInFactories) {
    const provider = createProviderForId(id);
    infos.push({
      id: provider.id,
      displayName: provider.displayName,
      capabilities: { ...provider.capabilities },
      available: true,
    });
  }

  return infos;
}

/**
 * Resolve the default provider ID from environment variables.
 *
 * Checks `BB_DEFAULT_PROVIDER`, then `BB_E2E_PROVIDER`, then falls back
 * to the compile-time default (codex).
 */
export function resolveDefaultProviderId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredDefault = env.BB_DEFAULT_PROVIDER?.trim().toLowerCase();
  if (configuredDefault && isKnownProviderId(configuredDefault)) {
    return configuredDefault;
  }

  const testOverride = env.BB_E2E_PROVIDER?.trim().toLowerCase();
  if (testOverride && isKnownProviderId(testOverride)) {
    return testOverride;
  }

  return "codex";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isKnownProviderId(id: string): boolean {
  return builtInFactories.has(id);
}
