import { notFound } from "@tanstack/react-router";

import { unfurlMeta } from "../landing/site.js";
import type { PublicMarketplaceData } from "./marketplace-data.js";
import type { MarketplaceV2Entry } from "./marketplace-v2.js";
import {
  isMarketplaceSort,
  marketplaceAuthorEntries,
  parseMarketplaceCategory,
} from "./marketplace-view-model.js";

export const MARKETPLACE_PAGE_TITLE = "Plugin Marketplace — bb";
export const MARKETPLACE_PAGE_DESCRIPTION =
  "Find community plugins that add new features to bb.";

export function validateMarketplaceSearch(search: Record<string, unknown>) {
  const category = parseMarketplaceCategory(search.category);
  return {
    ...(category === undefined ? {} : { category }),
    ...(isMarketplaceSort(search.sort) ? { sort: search.sort } : {}),
  };
}

export function marketplaceIndexMeta(available: boolean) {
  return [
    { title: MARKETPLACE_PAGE_TITLE },
    { name: "description", content: MARKETPLACE_PAGE_DESCRIPTION },
    { name: "robots", content: available ? "index, follow" : "noindex" },
    ...unfurlMeta(
      MARKETPLACE_PAGE_TITLE,
      MARKETPLACE_PAGE_DESCRIPTION,
      "/marketplace",
    ),
  ];
}

export function marketplacePluginRouteEntry(
  marketplace: PublicMarketplaceData | undefined,
  pluginId: string,
): MarketplaceV2Entry | null {
  if (marketplace === undefined || marketplace.status === "unavailable") {
    return null;
  }
  const entry = marketplace.manifest.plugins.find(
    (candidate) => candidate.id === pluginId,
  );
  if (entry === undefined) throw notFound();
  return entry;
}

export function marketplaceAuthorRouteEntries(
  marketplace: PublicMarketplaceData | undefined,
  github: string,
): MarketplaceV2Entry[] | null {
  if (marketplace === undefined || marketplace.status === "unavailable") {
    return null;
  }
  const entries = marketplaceAuthorEntries(marketplace.manifest, github);
  if (entries.length === 0) throw notFound();
  return entries;
}
