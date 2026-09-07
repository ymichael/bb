import { providerInfoSchema } from "@bb/domain";
import { z } from "zod";
import { createLastKnownCache } from "@/lib/last-known-cache";

const providerListCache = createLastKnownCache({
  prefix: "bb.provider-list",
  version: "2",
  schema: z.array(providerInfoSchema),
  maxEntries: 16,
});

export function providerListCacheKey({
  environmentId,
  hostId,
}: {
  environmentId: string | null;
  hostId: string | null;
}): string {
  return providerListCache.key(environmentId, hostId);
}

export const readCachedProviderList = providerListCache.read;
export const writeCachedProviderList = providerListCache.write;
