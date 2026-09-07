import { createServerFn } from "@tanstack/react-start";

import { getEnv } from "../server/env.js";
import { serveMarketplaceObject } from "../server/marketplace.js";
import {
  createPublicMarketplaceCache,
  type MarketplaceResource,
  type PublicMarketplaceData,
} from "./marketplace-data.js";

async function marketplaceResource(path: string): Promise<MarketplaceResource> {
  const response = await serveMarketplaceObject({
    bucket: getEnv().MARKETPLACE,
    request: new Request(`https://getbb.app${path}`),
  });
  if (!response.ok) {
    throw new Error(`Marketplace resource unavailable: ${response.status}`);
  }
  const etag = response.headers.get("etag");
  if (etag === null) {
    throw new Error("Marketplace resource has no ETag");
  }
  return { etag, value: await response.json() };
}

const loadCachedPublicMarketplace =
  createPublicMarketplaceCache(marketplaceResource);

export const getPublicMarketplace = createServerFn({ method: "GET" }).handler(
  async (): Promise<PublicMarketplaceData> => loadCachedPublicMarketplace(),
);
