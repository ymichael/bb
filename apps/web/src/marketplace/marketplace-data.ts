import {
  parseMarketplaceV2Manifest,
  type MarketplaceV2Manifest,
} from "./marketplace-v2.js";
import {
  parseMarketplaceStats,
  type MarketplaceStats,
} from "./marketplace-stats.js";

export const MARKETPLACE_V2_MANIFEST_PATH = "/marketplace/v2/marketplace.json";
export const MARKETPLACE_STATS_PATH = "/marketplace/v1/stats.json";
export const MARKETPLACE_CACHE_DURATION_MS = 300_000;

export interface MarketplaceResource {
  etag: string;
  value: unknown;
}

export type PublicMarketplaceData =
  | {
      status: "available";
      manifest: MarketplaceV2Manifest;
      stats: MarketplaceStats | null;
    }
  | { status: "unavailable" };

export async function loadPublicMarketplace(
  readJson: (path: string) => Promise<unknown>,
): Promise<PublicMarketplaceData> {
  try {
    const manifest = parseMarketplaceV2Manifest(
      await readJson(MARKETPLACE_V2_MANIFEST_PATH),
    );
    let stats: MarketplaceStats | null = null;
    try {
      stats = parseMarketplaceStats(await readJson(MARKETPLACE_STATS_PATH));
    } catch {
      stats = null;
    }
    return { status: "available", manifest, stats };
  } catch {
    return { status: "unavailable" };
  }
}

export function createPublicMarketplaceCache(
  readResource: (path: string) => Promise<MarketplaceResource>,
  options: {
    now?: () => number;
    durationMs?: number;
  } = {},
): () => Promise<PublicMarketplaceData> {
  const now = options.now ?? Date.now;
  const durationMs = options.durationMs ?? MARKETPLACE_CACHE_DURATION_MS;
  let cached:
    | {
        expiresAt: number;
        manifestEtag: string;
        statsEtag: string | null;
        data: Extract<PublicMarketplaceData, { status: "available" }>;
      }
    | undefined;
  let pending: Promise<PublicMarketplaceData> | undefined;

  const refresh = async (): Promise<PublicMarketplaceData> => {
    let manifestResource: MarketplaceResource;
    try {
      manifestResource = await readResource(MARKETPLACE_V2_MANIFEST_PATH);
    } catch {
      return { status: "unavailable" };
    }

    let manifest: MarketplaceV2Manifest;
    if (cached?.manifestEtag === manifestResource.etag) {
      manifest = cached.data.manifest;
    } else {
      try {
        manifest = parseMarketplaceV2Manifest(manifestResource.value);
      } catch {
        return { status: "unavailable" };
      }
    }

    let statsResource: MarketplaceResource | undefined;
    try {
      statsResource = await readResource(MARKETPLACE_STATS_PATH);
    } catch {
      statsResource = undefined;
    }

    const statsEtag = statsResource?.etag ?? null;
    let stats: MarketplaceStats | null;
    if (cached?.statsEtag === statsEtag) {
      stats = cached.data.stats;
    } else if (statsResource === undefined) {
      stats = null;
    } else {
      try {
        stats = parseMarketplaceStats(statsResource.value);
      } catch {
        stats = null;
      }
    }

    if (
      cached !== undefined &&
      cached.manifestEtag === manifestResource.etag &&
      cached.statsEtag === statsEtag
    ) {
      cached = { ...cached, expiresAt: now() + durationMs };
      return cached.data;
    }

    const data: Extract<PublicMarketplaceData, { status: "available" }> = {
      status: "available",
      manifest,
      stats,
    };
    cached = {
      expiresAt: now() + durationMs,
      manifestEtag: manifestResource.etag,
      statsEtag,
      data,
    };
    return data;
  };

  return () => {
    if (cached !== undefined && now() < cached.expiresAt) {
      return Promise.resolve(cached.data);
    }
    if (pending !== undefined) return pending;
    pending = refresh().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
