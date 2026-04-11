/**
 * Provider registry.
 *
 * Manages the set of available built-in provider metadata and adapter factories
 * (codex, claude-code, pi).
 */

import {
  getBuiltInAgentProviderInfo,
  isAgentProviderId,
  listBuiltInAgentProviderInfos,
} from "@bb/agent-providers";
import { createClaudeCodeProviderAdapter } from "./claude-code/adapter.js";
import { claudeCodeVisibilityMetadata } from "./claude-code/visibility.js";
import { createCodexProviderAdapter } from "./codex/adapter.js";
import { codexVisibilityMetadata } from "./codex/visibility.js";
import { createPiProviderAdapter } from "./pi/adapter.js";
import { piVisibilityMetadata } from "./pi/visibility.js";
import type {
  ProviderAdapter,
  ProviderAdapterFactoryOptions,
} from "./provider-adapter.js";
import type { ProviderVisibilityMetadata } from "./provider-visibility.js";
import type { ProviderInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

type ProviderFactory = (
  options?: ProviderAdapterFactoryOptions,
) => ProviderAdapter;
interface BuiltInProviderDescriptor {
  createAdapter: ProviderFactory;
  info: ProviderInfo;
  visibility: ProviderVisibilityMetadata;
}

const builtInProviders = [
  {
    // Codex app-server events already carry Codex-owned turn ids; the
    // runtime-generated prefix is only for adapters that synthesize bb turn ids.
    createAdapter: () => createCodexProviderAdapter(),
    info: getBuiltInAgentProviderInfo("codex"),
    visibility: codexVisibilityMetadata,
  },
  {
    createAdapter: (options) => createClaudeCodeProviderAdapter(options),
    info: getBuiltInAgentProviderInfo("claude-code"),
    visibility: claudeCodeVisibilityMetadata,
  },
  {
    createAdapter: (options) => createPiProviderAdapter(options),
    info: getBuiltInAgentProviderInfo("pi"),
    visibility: piVisibilityMetadata,
  },
] satisfies BuiltInProviderDescriptor[];

const builtInProvidersById = new Map(
  builtInProviders.map((descriptor) => [descriptor.info.id, descriptor]),
);

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Create a provider adapter by ID.
 *
 * Looks up built-in providers. Throws if the ID is not found.
 */
export function createProviderForId(
  providerId: string,
  options?: ProviderAdapterFactoryOptions,
): ProviderAdapter {
  if (!isAgentProviderId(providerId)) {
    const allIds = builtInProviders.map((provider) => provider.info.id);
    throw new Error(
      `Unsupported provider "${providerId}". Available providers: ${allIds.join(", ")}.`,
    );
  }

  const descriptor = builtInProvidersById.get(providerId);

  if (!descriptor) {
    const allIds = builtInProviders.map((provider) => provider.info.id);
    throw new Error(
      `Unsupported provider "${providerId}". Available providers: ${allIds.join(", ")}.`,
    );
  }

  return descriptor.createAdapter(options);
}

export function getProviderVisibilityMetadata(
  providerId: string,
): ProviderVisibilityMetadata {
  if (!isAgentProviderId(providerId)) {
    const allIds = builtInProviders.map((provider) => provider.info.id);
    throw new Error(
      `Unsupported provider "${providerId}". Available providers: ${allIds.join(", ")}.`,
    );
  }

  const metadata = builtInProvidersById.get(providerId)?.visibility;

  if (!metadata) {
    const allIds = builtInProviders.map((provider) => provider.info.id);
    throw new Error(
      `Unsupported provider "${providerId}". Available providers: ${allIds.join(", ")}.`,
    );
  }

  return metadata;
}

/**
 * List info for all available built-in providers.
 */
export function listAvailableProviderInfos(): ProviderInfo[] {
  return listBuiltInAgentProviderInfos();
}
