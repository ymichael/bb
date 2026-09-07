import { isNotFound } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { stringifySiteSearch } from "../lib/search-serialization.js";
import {
  loadPublicMarketplace,
  type PublicMarketplaceData,
} from "./marketplace-data.js";
import {
  marketplaceHtmlCacheControl,
  marketplaceResponseStatus,
} from "./marketplace-response-status.js";
import {
  marketplaceAuthorRouteEntries,
  marketplaceIndexMeta,
  marketplacePluginRouteEntry,
  validateMarketplaceSearch,
} from "./marketplace-route-data.js";
import {
  MARKETPLACE_STATS_FIXTURE,
  MARKETPLACE_V2_FIXTURE,
} from "./marketplace-v2.fixture.js";
import {
  PublicMarketplacePage,
  PublicMarketplaceUnavailablePage,
} from "./public-marketplace.js";

const AVAILABLE_MARKETPLACE: PublicMarketplaceData = {
  status: "available",
  manifest: MARKETPLACE_V2_FIXTURE,
  stats: MARKETPLACE_STATS_FIXTURE,
};

describe("marketplace routes", () => {
  it.each([
    {
      name: "missing object",
      read: async () => {
        throw new Error("missing");
      },
    },
    {
      name: "invalid object",
      read: async () => ({ schemaVersion: 2, plugins: "invalid" }),
    },
  ])("returns a noindex 503 for a $name", async ({ read }) => {
    const marketplace = await loadPublicMarketplace(read);
    expect(marketplace).toEqual({ status: "unavailable" });
    expect(marketplaceResponseStatus("/marketplace", [marketplace])).toBe(503);
    expect(marketplaceHtmlCacheControl("/marketplace", 503)).toBe("no-store");
    expect(marketplaceIndexMeta(false)).toContainEqual({
      name: "robots",
      content: "noindex",
    });
    expect(
      renderToStaticMarkup(<PublicMarketplaceUnavailablePage />),
    ).toContain("The Marketplace is not available");
  });

  it("returns notFound for an unknown plugin and author", () => {
    for (const select of [
      () => marketplacePluginRouteEntry(AVAILABLE_MARKETPLACE, "missing"),
      () => marketplaceAuthorRouteEntries(AVAILABLE_MARKETPLACE, "missing"),
    ]) {
      try {
        select();
        throw new Error("The route did not return notFound");
      } catch (error) {
        expect(isNotFound(error)).toBe(true);
      }
    }
  });

  it("keeps the first category parameter and round-trips it", () => {
    const first = validateMarketplaceSearch({
      category: ["thread-content", "code-and-reviews"],
      sort: "recently-added",
    });
    expect(first).toEqual({
      category: "thread-content",
      sort: "recently-added",
    });
    const encoded = stringifySiteSearch(first);
    const params = new URLSearchParams(encoded);
    const second = validateMarketplaceSearch({
      category: params.getAll("category"),
      sort: params.get("sort"),
    });
    expect(second).toEqual(first);
    expect(encoded).toBe("?sort=recently-added&category=thread-content");
    expect(validateMarketplaceSearch({})).toEqual({});
  });

  it("keeps an empty catalog available", async () => {
    const marketplace = await loadPublicMarketplace(async (path) =>
      path.endsWith("stats.json")
        ? MARKETPLACE_STATS_FIXTURE
        : { ...MARKETPLACE_V2_FIXTURE, plugins: [] },
    );
    expect(marketplace).toMatchObject({
      status: "available",
      manifest: { plugins: [] },
    });
    expect(marketplaceResponseStatus("/marketplace", [marketplace])).toBeNull();
  });

  it("renders the Marketplace through SSR in the dark theme", () => {
    const html = renderToStaticMarkup(
      <html className="dark">
        <body>
          <PublicMarketplacePage
            manifest={MARKETPLACE_V2_FIXTURE}
            stats={MARKETPLACE_STATS_FIXTURE}
            state={{}}
            onStateChange={() => {}}
          />
        </body>
      </html>,
    );
    expect(html).toContain('<html class="dark">');
    expect(html).toContain("Make bb yours.");
    expect(html).toContain("New &amp; notable");
    expect(html).toContain("marketplace-shelf-notable");
  });
});
