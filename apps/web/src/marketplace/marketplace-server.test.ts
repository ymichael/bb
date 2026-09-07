import { describe, expect, it } from "vitest";

import {
  createPublicMarketplaceCache,
  loadPublicMarketplace,
  MARKETPLACE_STATS_PATH,
  MARKETPLACE_V2_MANIFEST_PATH,
} from "./marketplace-data.js";
import {
  marketplaceHtmlCacheControl,
  marketplaceResponseStatus,
} from "./marketplace-response-status.js";
import {
  MARKETPLACE_STATS_FIXTURE,
  MARKETPLACE_V2_FIXTURE,
} from "./marketplace-v2.fixture.js";

describe("loadPublicMarketplace", () => {
  it("sets status 503 when the v2 document cannot load", async () => {
    const marketplace = await loadPublicMarketplace(async () => {
      throw new Error("offline");
    });
    expect(marketplace).toEqual({ status: "unavailable" });
    expect(marketplaceResponseStatus("/marketplace", [marketplace])).toBe(503);
  });

  it("keeps the normal status when the v2 document loads", () => {
    expect(
      marketplaceResponseStatus("/marketplace/author/acme-tools", [
        {
          status: "available",
          manifest: MARKETPLACE_V2_FIXTURE,
          stats: MARKETPLACE_STATS_FIXTURE,
        },
      ]),
    ).toBeNull();
  });

  it("does not change another route status", () => {
    expect(
      marketplaceResponseStatus("/dashboard", [{ status: "unavailable" }]),
    ).toBeNull();
  });

  it("keeps the catalog available when only stats fail", async () => {
    await expect(
      loadPublicMarketplace(async (path) => {
        if (path === MARKETPLACE_V2_MANIFEST_PATH) {
          return MARKETPLACE_V2_FIXTURE;
        }
        throw new Error("stats offline");
      }),
    ).resolves.toEqual({
      status: "available",
      manifest: MARKETPLACE_V2_FIXTURE,
      stats: null,
    });
  });

  it("loads v2 and stats through their public paths", async () => {
    const paths: string[] = [];
    const data = await loadPublicMarketplace(async (path) => {
      paths.push(path);
      return path === MARKETPLACE_STATS_PATH
        ? MARKETPLACE_STATS_FIXTURE
        : MARKETPLACE_V2_FIXTURE;
    });
    expect(paths).toEqual([
      MARKETPLACE_V2_MANIFEST_PATH,
      MARKETPLACE_STATS_PATH,
    ]);
    expect(data).toEqual({
      status: "available",
      manifest: MARKETPLACE_V2_FIXTURE,
      stats: MARKETPLACE_STATS_FIXTURE,
    });
  });

  it("caches parsed R2 data by ETag for five minutes", async () => {
    let now = 1_000;
    let reads = 0;
    let statsEtag = "stats-1";
    let installs = 1_204;
    const load = createPublicMarketplaceCache(
      async (path) => {
        reads += 1;
        if (path === MARKETPLACE_V2_MANIFEST_PATH) {
          return { etag: "manifest-1", value: MARKETPLACE_V2_FIXTURE };
        }
        return {
          etag: statsEtag,
          value: {
            ...MARKETPLACE_STATS_FIXTURE,
            plugins: { "prompt-library": { installs } },
          },
        };
      },
      { now: () => now },
    );

    const first = await load();
    expect(await load()).toBe(first);
    expect(reads).toBe(2);

    now += 300_000;
    expect(await load()).toBe(first);
    expect(reads).toBe(4);

    now += 300_000;
    statsEtag = "stats-2";
    installs = 2_000;
    const changed = await load();
    expect(changed).not.toBe(first);
    expect(changed).toMatchObject({
      status: "available",
      stats: { plugins: { "prompt-library": { installs: 2_000 } } },
    });
    expect(reads).toBe(6);
  });

  it("does not cache an unavailable manifest", async () => {
    let reads = 0;
    const load = createPublicMarketplaceCache(async () => {
      reads += 1;
      throw new Error("missing");
    });
    await expect(load()).resolves.toEqual({ status: "unavailable" });
    await expect(load()).resolves.toEqual({ status: "unavailable" });
    expect(reads).toBe(2);
  });

  it("sets HTML cache headers without changing object routes", () => {
    for (const pathname of [
      "/marketplace",
      "/marketplace/plugin-id",
      "/marketplace/author/get-bb",
    ]) {
      expect(marketplaceHtmlCacheControl(pathname, 200)).toBe(
        "public, max-age=300, must-revalidate",
      );
      expect(marketplaceHtmlCacheControl(pathname, 503)).toBe("no-store");
    }
    expect(
      marketplaceHtmlCacheControl("/marketplace/v2/marketplace.json", 200),
    ).toBeNull();
    expect(marketplaceHtmlCacheControl("/blog", 200)).toBeNull();
  });
});
