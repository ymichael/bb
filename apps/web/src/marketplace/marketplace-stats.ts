import { z } from "zod";

import {
  MARKETPLACE_ID_PATTERN,
  type MarketplaceStats,
} from "./marketplace-model.js";

const marketplaceStatsSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  plugins: z.record(
    z.string(),
    z.object({ installs: z.number().int().nonnegative() }),
  ),
});

export type { MarketplaceStats } from "./marketplace-model.js";

export function parseMarketplaceStats(input: unknown): MarketplaceStats {
  const parsed = marketplaceStatsSchema.parse(input);
  return {
    ...parsed,
    plugins: Object.fromEntries(
      Object.entries(parsed.plugins).filter(([entryId]) =>
        MARKETPLACE_ID_PATTERN.test(entryId),
      ),
    ),
  };
}
