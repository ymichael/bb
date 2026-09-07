import type { MarketplaceV2Entry } from "./marketplace-v2.js";

export const MARKETPLACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export interface MarketplaceStats {
  schemaVersion: 1;
  generatedAt: string;
  plugins: Record<string, { installs: number }>;
}

export function marketplaceEntryInstalls(
  entry: MarketplaceV2Entry,
  stats: MarketplaceStats | null,
): number | undefined {
  return stats?.plugins[entry.id]?.installs;
}
