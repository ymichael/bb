import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConnection,
  getPluginMarketplace,
  markInstalledPluginRemoved,
  migrate,
  upsertPluginMarketplace,
  upsertInstalledPlugin,
  type DbConnection,
} from "@bb/db";
import { ROOT_PLUGIN_SOURCE_SELECTION } from "@bb/server-contract";
import { PLUGIN_CATALOG_CATEGORIES } from "@bb/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginCatalogService } from "../../../src/services/plugin-catalog/plugin-catalog-service.js";
import type { MarketplaceFetch } from "../../../src/services/plugin-catalog/marketplace-http.js";
import {
  CURATED_MARKETPLACE_V1_URL,
  CURATED_MARKETPLACE_V2_URL,
} from "../../../src/services/plugin-catalog/marketplace-manifest.js";
import { BUNDLED_CURATED_MARKETPLACE } from "../../../src/services/plugin-catalog/curated-marketplace.js";
import {
  BUILTIN_PLUGINS,
  BUNDLED_PLUGINS,
  OFFICIAL_PLUGINS,
  listBundledPluginRegistrations,
} from "../../../src/services/plugins/builtin-registry.js";

const MANIFEST_URL = "https://marketplace.test/marketplace.json";
const ICON_URL = "https://marketplace.test/icons/widgets.svg";
const STATS_URL = "https://marketplace.test/stats.json";
const V1_MANIFEST_URL = CURATED_MARKETPLACE_V1_URL;
const V2_MANIFEST_URL = CURATED_MARKETPLACE_V2_URL;
const CUSTOM_V1_MANIFEST_URL =
  "https://marketplace.test/marketplace/v1/marketplace.json";
const SEED_ENTRY_COUNT = BUNDLED_CURATED_MARKETPLACE.plugins.length;

const VALID_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>',
);

function remoteEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "widgets",
    displayName: "Acme Widgets",
    description: "Widgets for threads.",
    icon: { url: "./icons/widgets.svg" },
    tags: ["interface", "widgets"],
    author: { name: "Acme", github: "acme" },
    source: {
      git: {
        url: "https://github.com/acme/plugins.git",
        subdir: "plugins/widgets",
        ref: "v1.0.0",
      },
    },
    ...overrides,
  };
}

function manifest(plugins: unknown[]): unknown {
  return {
    schemaVersion: 1,
    name: "bb-community",
    displayName: "BB Community",
    plugins,
  };
}

function manifestV2(
  plugins: unknown[],
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    schemaVersion: 2,
    name: "bb-community",
    displayName: "BB Community",
    plugins,
    ...overrides,
  };
}

function jsonResponse(
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("plugin catalog service", () => {
  let db: DbConnection;
  let installedNames: string[];
  let installedCatalogEntries: unknown[];

  let dataDir: string;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    installedNames = [];
    installedCatalogEntries = [];
    dataDir = await mkdtemp(join(tmpdir(), "bb-catalog-data-"));
  });

  afterEach(async () => {
    db.$client.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function service(options?: {
    bundledPlugins?: Parameters<
      typeof createPluginCatalogService
    >[0]["bundledPlugins"];
    fetch?: MarketplaceFetch;
    marketplaceUrl?: string;
    warn?: (message: string) => void;
  }) {
    return createPluginCatalogService({
      db,
      appVersion: "1.0.0",
      marketplaceUrl: options?.marketplaceUrl ?? MANIFEST_URL,
      dataDir,
      plugins: {
        installOfficialPlugin: async (name: string) => {
          installedNames.push(name);
          throw new Error("installation stopped by test");
        },
        installCatalogPlugin: async (args: unknown) => {
          installedCatalogEntries.push(args);
          throw new Error("catalog installation stopped by test");
        },
        resolveCatalogNpmSource: async () => ({
          outcome: "unavailable" as const,
          detail: "no registry in this test",
        }),
      },
      ...(options?.bundledPlugins === undefined
        ? {}
        : { bundledPlugins: options.bundledPlugins }),
      ...(options?.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options?.warn === undefined ? {} : { warn: options.warn }),
    });
  }

  function registerInstalledOfficial(args: {
    pluginId: string;
    name: string;
  }): void {
    upsertInstalledPlugin(db, {
      id: args.pluginId,
      source: `builtin:${args.name}`,
      provenance: {
        kind: "catalog",
        marketplace: "bb-official",
        entryId: args.name,
      },
      sourceIntent: { kind: "builtin", name: args.name },
      exactResolution: { kind: "builtin" },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: `/bundled/${args.name}`,
      version: "0.0.1",
      enabled: true,
    });
  }

  it("lists bundled plugins and the seeded official catalog", async () => {
    const catalog = service();
    expect(catalog.status()).toEqual({
      pluginCount: BUNDLED_PLUGINS.length + SEED_ENTRY_COUNT,
      includedPluginCount: BUILTIN_PLUGINS.length,
      optionalPluginCount: OFFICIAL_PLUGINS.length + SEED_ENTRY_COUNT,
    });

    const results = await catalog.search("");
    expect(results.map((entry) => entry.entryId).sort()).toEqual(
      [
        ...BUNDLED_PLUGINS.map((plugin) => plugin.name),
        ...BUNDLED_CURATED_MARKETPLACE.plugins.map((entry) => entry.id),
      ].sort(),
    );
    const docs = results.find((entry) => entry.entryId === "docs");
    expect(docs).toMatchObject({
      pluginId: "simple-notes",
      displayName: "Docs",
      icon: "FileText",
      iconUrl: null,
      category: "File Viewers & Editors",
      screenshots: [],
      collections: [
        {
          id: "bb-official",
          rank: BUNDLED_PLUGINS.findIndex(
            (plugin) => plugin.pluginId === "simple-notes",
          ),
        },
      ],
      source: "builtin:docs",
      marketplace: "bb-official",
      marketplaceDisplayName: "BB Official",
      publisherKey: "bb-official",
      publisherLabel: "BB Official",
      author: { name: "BB", url: null },
      installed: false,
      compatible: true,
    });
    expect(catalog.collections()).toEqual([
      {
        id: "bb-official",
        displayName: "BB Official",
        pluginIds: BUNDLED_PLUGINS.map((plugin) => plugin.pluginId),
      },
    ]);
    for (const category of PLUGIN_CATALOG_CATEGORIES) {
      const categoryNames = results
        .filter((entry) => entry.category === category.displayName)
        .map((entry) => entry.displayName);
      expect(categoryNames).toEqual(
        [...categoryNames].sort((a, b) => a.localeCompare(b)),
      );
    }
  });

  it("groups a catalog entry by its curated tag", async () => {
    const catalog = service();
    const [hoverCards] = await catalog.search("thread-hover-cards");
    expect(hoverCards).toMatchObject({
      entryId: "thread-hover-cards",
      pluginId: "thread-hover-cards",
      category: "Interface",
      icon: "ZoomIn",
      iconUrl: null,
      source:
        "git:https://github.com/brsbl/bb-plugins.git@30f91fd977ba1ce60532af27a68534464fb62516",
      installed: false,
      compatible: true,
      incompatibleReason: null,
    });
  });

  it("matches queries against entry id, plugin id, manifest text, and tags", async () => {
    const catalog = service();
    expect(
      (await catalog.search("docs")).map((entry) => entry.entryId),
    ).toContain("docs");
    expect(
      (await catalog.search("simple-notes")).map((entry) => entry.entryId),
    ).toEqual(["docs"]);
    expect(
      (await catalog.search("sidebar")).map((entry) => entry.entryId),
    ).toContain("thread-hover-cards");
    expect(await catalog.search("no-such-plugin")).toEqual([]);
  });

  it("reflects install and remove in the installed flag", async () => {
    const catalog = service();
    registerInstalledOfficial({ pluginId: "simple-notes", name: "docs" });
    expect((await catalog.search("docs"))[0]?.installed).toBe(true);

    markInstalledPluginRemoved(db, "simple-notes");
    expect((await catalog.search("docs"))[0]?.installed).toBe(false);
  });

  it("delegates install to the plugin service by bundled name", async () => {
    const catalog = service();
    await expect(catalog.install({ entryId: "docs" })).rejects.toThrow(
      "installation stopped by test",
    );
    expect(installedNames).toEqual(["docs"]);
  });

  it("rejects unknown catalog entries", async () => {
    const catalog = service();
    await expect(
      catalog.install({ entryId: "does-not-exist" }),
    ).rejects.toThrow('unknown plugin catalog entry "does-not-exist"');
  });

  it("drops entries whose bundled manifest is unreadable", async () => {
    const missingRoot = await mkdtemp(join(tmpdir(), "bb-missing-plugin-"));
    await rm(missingRoot, { recursive: true, force: true });
    const warnings: string[] = [];
    const registrations = listBundledPluginRegistrations();
    const github = registrations.find((plugin) => plugin.name === "github");
    const workflows = registrations.find(
      (plugin) => plugin.name === "workflows",
    );
    if (github === undefined || workflows === undefined) {
      throw new Error("bundled registration missing");
    }
    const catalog = service({
      bundledPlugins: [
        {
          ...github,
          rootDir: missingRoot,
        },
        workflows,
      ],
      warn: (message) => warnings.push(message),
    });
    const results = await catalog.search("");
    expect(results.map((entry) => entry.entryId)).not.toContain("github");
    expect(results.map((entry) => entry.entryId)).toContain("workflows");
    expect(warnings.some((warning) => warning.includes("github"))).toBe(true);
  });

  it("serves a bundled entry's own compact icon from the catalog route", async () => {
    const registrations = listBundledPluginRegistrations();
    const withSvg = registrations.find(
      (plugin) => plugin.name === "provider-acp",
    );
    const withGlyph = registrations.find(
      (plugin) => plugin.name === "workflows",
    );
    if (withSvg === undefined || withGlyph === undefined) {
      throw new Error("expected bundled registrations");
    }
    const catalog = service({ bundledPlugins: [withSvg, withGlyph] });

    const results = await catalog.search("");
    const svgEntry = results.find((entry) => entry.entryId === withSvg.name);
    const glyphEntry = results.find(
      (entry) => entry.entryId === withGlyph.name,
    );
    expect(svgEntry?.icon?.startsWith("./")).toBe(true);
    const icon = await catalog.icon("bb-official", withSvg.name);
    expect(icon?.contentType).toBe("image/svg+xml");
    expect(svgEntry?.iconUrl).toBe(
      `/api/v1/plugin-catalog/icons/bb-official/${withSvg.name}?h=${icon?.hash}`,
    );
    expect(new TextDecoder().decode(icon?.bytes)).toContain("<svg");
    expect(svgEntry?.iconTinted).toBe(true);

    expect(glyphEntry?.iconUrl).toBeNull();
    expect(glyphEntry?.iconTinted).toBe(false);
    expect(await catalog.icon("bb-official", withGlyph.name)).toBeUndefined();
  });

  describe("refresh", () => {
    it("keeps the saved v1 catalog during an offline v2 URL upgrade", async () => {
      const savedManifest = manifest([remoteEntry({ icon: "Zap" })]);
      upsertPluginMarketplace(db, {
        name: "bb-community",
        sourceKind: "https",
        manifestUrl: V1_MANIFEST_URL,
        sourceGitRef: null,
        sourceGitCommit: null,
        manifestJson: JSON.stringify(savedManifest),
        statsJson: null,
        etag: '"v1"',
        lastModified: "Wed, 02 Sep 2026 00:00:00 GMT",
        lastSuccessfulRefreshAt: 1_000,
        lastAttemptedRefreshAt: 1_000,
        lastError: null,
      });

      const catalog = service({
        marketplaceUrl: V2_MANIFEST_URL,
        fetch: async () => new Response(null, { status: 503 }),
      });

      expect(await catalog.search("widgets")).toHaveLength(1);
      expect(getPluginMarketplace(db, "bb-community")).toMatchObject({
        manifestUrl: V2_MANIFEST_URL,
        manifestJson: JSON.stringify(savedManifest),
        etag: null,
        lastModified: null,
        lastSuccessfulRefreshAt: 1_000,
      });
      await expect(catalog.refresh(2_000)).rejects.toThrow("HTTP 503");
      expect(await catalog.search("widgets")).toHaveLength(1);
    });

    it("requests v2 first and falls back to v1 only after a 404", async () => {
      const requests: string[] = [];
      const catalog = service({
        marketplaceUrl: V2_MANIFEST_URL,
        fetch: async (url) => {
          requests.push(url);
          if (url === V2_MANIFEST_URL) {
            return new Response(null, { status: 404 });
          }
          if (url === V1_MANIFEST_URL) {
            return jsonResponse(manifest([remoteEntry({ icon: "Zap" })]));
          }
          return new Response(null, { status: 404 });
        },
      });

      await catalog.refresh(1_000);
      expect(requests.slice(0, 2)).toEqual([V2_MANIFEST_URL, V1_MANIFEST_URL]);
      expect(await catalog.search("widgets")).toHaveLength(1);
    });

    it("keeps a stored v2 catalog after a transient v2 404", async () => {
      const requests: string[] = [];
      const warnings: string[] = [];
      let v2Available = true;
      const catalog = service({
        marketplaceUrl: V2_MANIFEST_URL,
        warn: (message) => warnings.push(message),
        fetch: async (url) => {
          requests.push(url);
          if (url === V2_MANIFEST_URL) {
            return v2Available
              ? jsonResponse(
                  manifestV2([
                    remoteEntry({ icon: "Zap", category: "security" }),
                  ]),
                )
              : new Response(null, { status: 404 });
          }
          if (url === V1_MANIFEST_URL) {
            return jsonResponse(manifest([remoteEntry({ icon: "Zap" })]));
          }
          return new Response(null, { status: 404 });
        },
      });

      await catalog.refresh(1_000);
      v2Available = false;
      requests.length = 0;
      await catalog.refresh(2_000);

      expect(
        requests.filter(
          (url) => url === V1_MANIFEST_URL || url === V2_MANIFEST_URL,
        ),
      ).toEqual([V2_MANIFEST_URL]);
      expect(await catalog.search("widgets")).toMatchObject([
        { entryId: "widgets", categoryId: "security" },
      ]);
      expect(
        JSON.parse(
          getPluginMarketplace(db, "bb-community")?.manifestJson ?? "null",
        ),
      ).toMatchObject({ schemaVersion: 2 });
      expect(warnings).toContainEqual(
        expect.stringContaining("kept the stored v2 catalog"),
      );
    });

    it("does not fall back to v1 after a v2 server error", async () => {
      const requests: string[] = [];
      const catalog = service({
        marketplaceUrl: V2_MANIFEST_URL,
        fetch: async (url) => {
          requests.push(url);
          return new Response(null, { status: 500 });
        },
      });

      await expect(catalog.refresh(1_000)).rejects.toThrow("HTTP 500");
      expect(requests).toEqual([V2_MANIFEST_URL]);
    });

    it("requests a custom configured v1 URL without a v2 rewrite", async () => {
      const requests: string[] = [];
      const catalog = service({
        marketplaceUrl: CUSTOM_V1_MANIFEST_URL,
        fetch: async (url) => {
          requests.push(url);
          return jsonResponse(manifest([remoteEntry({ icon: "Zap" })]));
        },
      });

      await catalog.refresh(1_000);
      expect(requests[0]).toBe(CUSTOM_V1_MANIFEST_URL);
      expect(requests).toHaveLength(2);
      expect(await catalog.search("widgets")).toHaveLength(1);
    });

    it("projects v2 categories, screenshots, dates, and collections", async () => {
      const catalog = service({
        fetch: async (url) =>
          url === MANIFEST_URL
            ? jsonResponse(
                manifestV2(
                  [
                    remoteEntry({
                      icon: "Zap",
                      author: {
                        name: "Acme",
                        github: "acme",
                        url: "https://acme.dev",
                      },
                      category: "acme-tools",
                      screenshots: ["./screenshots/widgets/widgets.webp"],
                      overview: "# Widgets\n\nLong-form text.\n",
                      publishedAt: "2026-08-20T11:47:04-07:00",
                      updatedAt: "2026-08-27T16:12:00Z",
                    }),
                    remoteEntry({
                      id: "uncategorized",
                      icon: "Zap",
                      category: "missing-category",
                      overview: `${"a".repeat(4001)}\n`,
                    }),
                  ],
                  {
                    categories: [
                      {
                        id: "acme-tools",
                        displayName: "Acme tools",
                        description: "Tools from Acme.",
                      },
                    ],
                    collections: [
                      {
                        id: "new-and-notable",
                        displayName: "New & notable",
                        pluginIds: ["missing-plugin", "widgets"],
                      },
                    ],
                  },
                ),
              )
            : new Response(null, { status: 404 }),
      });

      await catalog.refresh(1_000);
      const widgets = (await catalog.search("widgets")).find(
        (entry) => entry.entryId === "widgets",
      );
      expect(widgets).toMatchObject({
        author: {
          name: "Acme",
          github: "acme",
          url: "https://acme.dev",
        },
        categoryId: "acme-tools",
        category: "Acme tools",
        screenshots: [
          "https://marketplace.test/screenshots/widgets/widgets.webp",
        ],
        overview: "# Widgets\n\nLong-form text.\n",
        collections: [{ id: "new-and-notable", rank: 0 }],
        publishedAt: "2026-08-20T11:47:04-07:00",
        updatedAt: "2026-08-27T16:12:00Z",
      });
      const uncategorized = (await catalog.search("uncategorized"))[0];
      expect(uncategorized).not.toHaveProperty("categoryId");
      expect(uncategorized).not.toHaveProperty("category");
      expect(uncategorized).not.toHaveProperty("overview");
      expect(uncategorized?.collections).toEqual([]);
      expect(catalog.collections()).toEqual([
        {
          id: "bb-official",
          displayName: "BB Official",
          pluginIds: BUNDLED_PLUGINS.map((plugin) => plugin.pluginId),
        },
        {
          id: "new-and-notable",
          displayName: "New & notable",
          pluginIds: ["widgets"],
        },
      ]);
    });

    it("ignores collections from a third-party marketplace", async () => {
      const catalog = service();
      upsertPluginMarketplace(db, {
        name: "acme",
        sourceKind: "path",
        manifestUrl: dataDir,
        sourceGitRef: null,
        sourceGitCommit: null,
        manifestJson: JSON.stringify(
          manifestV2([remoteEntry({ icon: "Zap" })], {
            name: "acme",
            displayName: "Acme",
            collections: [
              {
                id: "featured",
                displayName: "Featured",
                pluginIds: ["widgets"],
              },
            ],
          }),
        ),
        statsJson: null,
        etag: null,
        lastModified: null,
        lastSuccessfulRefreshAt: 1_000,
        lastAttemptedRefreshAt: 1_000,
        lastError: null,
      });

      expect((await catalog.search("widgets"))[0]?.collections).toEqual([]);
      expect(catalog.collections()).toEqual([
        {
          id: "bb-official",
          displayName: "BB Official",
          pluginIds: BUNDLED_PLUGINS.map((plugin) => plugin.pluginId),
        },
      ]);
    });

    it("fails at load when reserved marketplace collection ids collide", () => {
      upsertPluginMarketplace(db, {
        name: "bb-community",
        sourceKind: "https",
        manifestUrl: MANIFEST_URL,
        sourceGitRef: null,
        sourceGitCommit: null,
        manifestJson: JSON.stringify(
          manifestV2([], {
            collections: [
              {
                id: "bb-official",
                displayName: "Duplicate",
                pluginIds: [],
              },
            ],
          }),
        ),
        statsJson: null,
        etag: null,
        lastModified: null,
        lastSuccessfulRefreshAt: 1_000,
        lastAttemptedRefreshAt: 1_000,
        lastError: null,
      });

      expect(() => service()).toThrow(
        'duplicate reserved marketplace collection id "bb-official" in "bb-official" and "bb-community"',
      );
    });

    it("tints a catalog SVG but keeps a raster icon's own colors", async () => {
      const PNG = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
      ]);
      const fetchImpl: MarketplaceFetch = async (url) => {
        if (url === MANIFEST_URL) {
          return jsonResponse(
            manifest([
              remoteEntry({
                id: "raster",
                icon: { url: "./icons/raster.png" },
              }),
              remoteEntry({ id: "glyph", icon: { url: "./icons/glyph.svg" } }),
            ]),
          );
        }
        return url.endsWith(".png")
          ? new Response(PNG, {
              status: 200,
              headers: { "content-type": "image/png" },
            })
          : new Response(VALID_SVG, {
              status: 200,
              headers: { "content-type": "image/svg+xml" },
            });
      };
      const catalog = service({ fetch: fetchImpl });

      await catalog.refresh(1_000);
      const tinted = Object.fromEntries(
        (await catalog.search("")).map((entry) => [
          entry.entryId,
          { iconUrl: entry.iconUrl !== null, iconTinted: entry.iconTinted },
        ]),
      );
      expect(tinted).toMatchObject({
        raster: { iconUrl: true, iconTinted: false },
        glyph: { iconUrl: true, iconTinted: true },
      });
    });

    it("replaces the catalog, caches icons, and revalidates with the ETag", async () => {
      const requests: Array<{ url: string; headers: Headers }> = [];
      const fetchImpl: MarketplaceFetch = async (url, init) => {
        requests.push({ url, headers: new Headers(init.headers) });
        if (url === MANIFEST_URL) {
          return requests.filter((request) => request.url === MANIFEST_URL)
            .length === 1
            ? jsonResponse(manifest([remoteEntry()]), { etag: '"v1"' })
            : new Response(null, { status: 304 });
        }
        return new Response(VALID_SVG, {
          status: 200,
          headers: { "content-type": "image/svg+xml", etag: '"icon-1"' },
        });
      };
      const catalog = service({ fetch: fetchImpl });

      await catalog.refresh(1_000);
      const results = await catalog.search("widgets");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        entryId: "widgets",
        displayName: "Acme Widgets",
        category: "Interface",
        icon: null,
        source:
          "git:https://github.com/acme/plugins.git@v1.0.0#plugins/widgets",
      });
      expect(results[0]?.iconUrl).toBe(
        "/api/v1/plugin-catalog/icons/bb-community/widgets?h=" +
          (await catalog.icon("bb-community", "widgets"))?.hash,
      );
      expect(await catalog.icon("bb-community", "widgets")).toMatchObject({
        contentType: "image/svg+xml",
      });
      expect(results[0]?.iconTinted).toBe(true);
      expect((await catalog.search("thread-hover-cards")).length).toBe(0);
      expect(requests[1]?.url).toBe(ICON_URL);

      await catalog.refresh(2_000);
      const conditional = requests.filter(
        (request) => request.url === MANIFEST_URL,
      )[1];
      expect(conditional?.headers.get("if-none-match")).toBe('"v1"');
      expect((await catalog.search("widgets"))[0]?.displayName).toBe(
        "Acme Widgets",
      );
      expect(
        requests.filter((request) => request.url === ICON_URL),
      ).toHaveLength(1);
      const row = getPluginMarketplace(db, "bb-community");
      expect(row).toMatchObject({
        etag: '"v1"',
        lastSuccessfulRefreshAt: 2_000,
        lastError: null,
      });
    });

    it("keeps the last-known-good catalog when the payload is invalid", async () => {
      const catalog = service({
        fetch: async () =>
          jsonResponse(manifest([remoteEntry({ id: "Not Valid" })])),
      });
      await expect(catalog.refresh(5_000)).rejects.toThrow(
        /invalid marketplace manifest/,
      );
      expect((await catalog.search("thread-hover-cards")).length).toBe(1);
      expect(getPluginMarketplace(db, "bb-community")).toMatchObject({
        lastAttemptedRefreshAt: 5_000,
        lastSuccessfulRefreshAt: null,
      });
      expect(getPluginMarketplace(db, "bb-community")?.lastError).toMatch(
        /invalid marketplace manifest/,
      );
    });

    it("keeps the last-known-good catalog when the request fails", async () => {
      const catalog = service({
        fetch: async () => new Response("nope", { status: 503 }),
      });
      await expect(catalog.refresh(7_000)).rejects.toThrow("HTTP 503");
      expect((await catalog.search("")).length).toBe(
        BUNDLED_PLUGINS.length + SEED_ENTRY_COUNT,
      );
      expect(getPluginMarketplace(db, "bb-community")?.lastError).toContain(
        "HTTP 503",
      );
    });

    it("refuses a manifest published under another marketplace name", async () => {
      const catalog = service({
        fetch: async () =>
          jsonResponse({
            ...(manifest([remoteEntry()]) as Record<string, unknown>),
            name: "someone-else",
          }),
      });
      await expect(catalog.refresh(9_000)).rejects.toThrow(/someone-else/);
      expect((await catalog.search("widgets")).length).toBe(0);
    });

    it("falls back to the bundled snapshot when the stored catalog is unreadable", async () => {
      service();
      const stored = getPluginMarketplace(db, "bb-community");
      if (stored === undefined) throw new Error("catalog row missing");
      db.$client
        .prepare("UPDATE plugin_marketplaces SET manifest_json = ?")
        .run("{not json");
      const warnings: string[] = [];
      const catalog = service({ warn: (message) => warnings.push(message) });
      expect((await catalog.search("thread-hover-cards")).length).toBe(1);
      expect(warnings.some((warning) => warning.includes("bundled"))).toBe(
        true,
      );
    });

    it("keeps an entry whose icon fails validation and warns", async () => {
      const warnings: string[] = [];
      const catalog = service({
        warn: (message) => warnings.push(message),
        fetch: async (url) =>
          url === MANIFEST_URL
            ? jsonResponse(manifest([remoteEntry()]))
            : new Response(Buffer.from("<html>not an icon</html>"), {
                status: 200,
              }),
      });
      await catalog.refresh(1_000);
      const [entry] = await catalog.search("widgets");
      expect(entry).toMatchObject({ entryId: "widgets", iconUrl: null });
      expect(await catalog.icon("bb-community", "widgets")).toBeUndefined();
      expect(warnings.some((warning) => warning.includes("widgets"))).toBe(
        true,
      );
    });

    it("refuses an icon larger than the cap", async () => {
      const warnings: string[] = [];
      const catalog = service({
        warn: (message) => warnings.push(message),
        fetch: async (url) =>
          url === MANIFEST_URL
            ? jsonResponse(manifest([remoteEntry()]))
            : new Response(Buffer.alloc(300 * 1024, 0x41), { status: 200 }),
      });
      await catalog.refresh(1_000);
      expect(await catalog.icon("bb-community", "widgets")).toBeUndefined();
      expect(
        warnings.some((warning) => warning.includes("exceeds 262144 bytes")),
      ).toBe(true);
    });

    it("keeps cached icons while retrying a missing one on a 304", async () => {
      let iconRequests = 0;
      let failFirstIcon = true;
      const catalog = service({
        warn: () => {},
        fetch: async (url) => {
          if (url === MANIFEST_URL) {
            return iconRequests === 0
              ? jsonResponse(
                  manifest([
                    remoteEntry(),
                    remoteEntry({
                      id: "gadgets",
                      icon: { url: "./icons/gadgets.svg" },
                    }),
                  ]),
                  { etag: '"v1"' },
                )
              : new Response(null, { status: 304 });
          }
          iconRequests += 1;
          if (url.endsWith("gadgets.svg") && failFirstIcon) {
            failFirstIcon = false;
            return new Response("boom", { status: 500 });
          }
          return new Response(VALID_SVG, { status: 200 });
        },
      });
      await catalog.refresh(1_000);
      expect(await catalog.icon("bb-community", "widgets")).toBeDefined();
      expect(await catalog.icon("bb-community", "gadgets")).toBeUndefined();

      await catalog.refresh(2_000);
      expect(await catalog.icon("bb-community", "widgets")).toBeDefined();
      expect(await catalog.icon("bb-community", "gadgets")).toBeDefined();
    });

    it("drops a cached icon the refreshed manifest no longer lists", async () => {
      let listIcon = true;
      const catalog = service({
        fetch: async (url) =>
          url === MANIFEST_URL
            ? jsonResponse(
                manifest([
                  listIcon ? remoteEntry() : remoteEntry({ icon: "Zap" }),
                ]),
              )
            : new Response(VALID_SVG, { status: 200 }),
      });
      await catalog.refresh(1_000);
      expect(await catalog.icon("bb-community", "widgets")).toBeDefined();
      listIcon = false;
      await catalog.refresh(2_000);
      expect(await catalog.icon("bb-community", "widgets")).toBeUndefined();
    });

    it("drops a cached icon when its replacement URL fails", async () => {
      let iconUrl = "./icons/widgets.svg";
      const catalog = service({
        warn: () => {},
        fetch: async (url) => {
          if (url === MANIFEST_URL) {
            return jsonResponse(
              manifest([remoteEntry({ icon: { url: iconUrl } })]),
            );
          }
          return url.endsWith("widgets.svg")
            ? new Response(VALID_SVG, { status: 200 })
            : new Response("nope", { status: 503 });
        },
      });
      await catalog.refresh(1_000);
      expect(await catalog.icon("bb-community", "widgets")).toBeDefined();

      iconUrl = "./icons/replacement.svg";
      await catalog.refresh(2_000);
      expect(await catalog.icon("bb-community", "widgets")).toBeUndefined();
    });

    it("keeps the prior snapshot when an icon-table commit fails", async () => {
      db.$client.exec(`
        CREATE TRIGGER reject_marketplace_icon
        BEFORE INSERT ON plugin_marketplace_icons
        BEGIN
          SELECT RAISE(ABORT, 'icon write failed');
        END;
      `);
      const catalog = service({
        fetch: async (url) =>
          url === MANIFEST_URL
            ? jsonResponse(manifest([remoteEntry()]))
            : new Response(VALID_SVG, { status: 200 }),
      });

      await expect(catalog.refresh(3_000)).rejects.toThrow("icon write failed");
      expect(await catalog.search("widgets")).toEqual([]);
      expect(await catalog.search("thread-hover-cards")).toHaveLength(1);
      expect(getPluginMarketplace(db, "bb-community")).toMatchObject({
        lastSuccessfulRefreshAt: null,
        lastAttemptedRefreshAt: 3_000,
        lastError: expect.stringContaining("icon write failed"),
      });
    });
  });

  describe("install counts", () => {
    function statsResponse(
      plugins: Record<string, { installs: number }>,
      generatedAt = "2026-08-21T00:00:00.000Z",
    ): Response {
      return jsonResponse({ schemaVersion: 1, generatedAt, plugins });
    }

    function fetchWith(
      stats: () => Response,
      entries: unknown[] = [remoteEntry()],
    ): MarketplaceFetch {
      return async (url) => {
        if (url === MANIFEST_URL) return jsonResponse(manifest(entries));
        if (url === STATS_URL) return stats();
        return new Response(VALID_SVG, {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        });
      };
    }

    it("reports counts for curated entries and bundled plugins", async () => {
      const bundled = listBundledPluginRegistrations().find(
        (plugin) =>
          plugin.name === "docs" && plugin.pluginId === "simple-notes",
      );
      if (bundled === undefined) throw new Error("docs registration missing");
      const catalog = service({
        fetch: fetchWith(() =>
          statsResponse({
            widgets: { installs: 4_210 },
            [bundled.pluginId]: { installs: 12 },
          }),
        ),
      });

      await catalog.refresh(1_000);
      const byId = new Map(
        (await catalog.search("")).map((entry) => [entry.entryId, entry]),
      );
      expect(byId.get("widgets")?.installs).toBe(4_210);
      expect(byId.get(bundled.name)?.installs).toBe(12);
    });

    it("leaves an entry the sidecar does not name uncounted", async () => {
      const catalog = service({
        fetch: fetchWith(() => statsResponse({ other: { installs: 9 } })),
      });

      await catalog.refresh(1_000);
      expect((await catalog.search("widgets"))[0]?.installs).toBeNull();
    });

    it("re-reads the sidecar when the manifest is unchanged", async () => {
      let manifestReads = 0;
      let installs = 5;
      const catalog = service({
        fetch: async (url) => {
          if (url === MANIFEST_URL) {
            manifestReads += 1;
            return manifestReads === 1
              ? jsonResponse(manifest([remoteEntry()]), { etag: '"v1"' })
              : new Response(null, { status: 304 });
          }
          if (url === STATS_URL) {
            return statsResponse({ widgets: { installs } });
          }
          return new Response(VALID_SVG, {
            status: 200,
            headers: { "content-type": "image/svg+xml" },
          });
        },
      });

      await catalog.refresh(1_000);
      expect((await catalog.search("widgets"))[0]?.installs).toBe(5);
      installs = 40;
      await catalog.refresh(2_000);
      expect((await catalog.search("widgets"))[0]?.installs).toBe(40);
    });

    it("keeps the stored counts when the sidecar fails, and the refresh still succeeds", async () => {
      const warnings: string[] = [];
      let sidecarBroken = false;
      const catalog = service({
        warn: (message) => warnings.push(message),
        fetch: fetchWith(() =>
          sidecarBroken
            ? new Response("nope", { status: 500 })
            : statsResponse({ widgets: { installs: 7 } }),
        ),
      });

      await catalog.refresh(1_000);
      sidecarBroken = true;
      await catalog.refresh(2_000);
      expect((await catalog.search("widgets"))[0]?.installs).toBe(7);
      expect(getPluginMarketplace(db, "bb-community")).toMatchObject({
        lastSuccessfulRefreshAt: 2_000,
        lastError: null,
      });
      expect(warnings.join("\n")).toMatch(/install counts were not refreshed/u);
    });

    it("rejects a malformed sidecar whole rather than counting part of it", async () => {
      const catalog = service({
        fetch: fetchWith(() =>
          jsonResponse({
            schemaVersion: 1,
            generatedAt: "2026-08-21T00:00:00.000Z",
            plugins: { widgets: { installs: -1 } },
          }),
        ),
      });

      await catalog.refresh(1_000);
      expect((await catalog.search("widgets"))[0]?.installs).toBeNull();
    });

    it("does not count entries of a third-party marketplace", async () => {
      const thirdPartyManifest =
        "https://acme.test/marketplace/marketplace.json";
      const statsRequests: string[] = [];
      const catalog = service({
        fetch: async (url) => {
          if (url === MANIFEST_URL) return jsonResponse(manifest([]));
          if (url.endsWith("/stats.json")) {
            statsRequests.push(url);
            return statsResponse({ widgets: { installs: 999 } });
          }
          if (url === thirdPartyManifest) {
            return jsonResponse({
              schemaVersion: 1,
              name: "acme",
              displayName: "Acme",
              plugins: [remoteEntry({ icon: "ZoomIn" })],
            });
          }
          return new Response(null, { status: 404 });
        },
      });

      await catalog.addMarketplace(thirdPartyManifest);
      await catalog.refreshMarketplaces({ attemptedAt: 2_000 });
      expect((await catalog.search("widgets"))[0]?.installs).toBeNull();
      expect(statsRequests).toEqual([STATS_URL]);
    });
  });

  describe("catalog installs", () => {
    async function refreshedCatalog(entry: Record<string, unknown>) {
      const catalog = service({
        fetch: async (url) =>
          url === MANIFEST_URL
            ? jsonResponse(manifest([entry]))
            : new Response(VALID_SVG, { status: 200 }),
      });
      await catalog.refresh(1_000);
      return catalog;
    }

    it("routes a subdirectory entry through the install pipeline", async () => {
      const catalog = await refreshedCatalog(remoteEntry());
      await expect(catalog.install({ entryId: "widgets" })).rejects.toThrow(
        "catalog installation stopped by test",
      );
      expect(installedCatalogEntries).toEqual([
        {
          marketplace: "bb-community",
          entryId: "widgets",
          pluginId: "widgets",
          source: "git:https://github.com/acme/plugins.git@v1.0.0",
          selection: { kind: "subdirectory", path: "plugins/widgets" },
        },
      ]);
      expect(installedNames).toEqual([]);
    });

    it("routes an npm entry with its dist-tag and registry", async () => {
      const catalog = await refreshedCatalog(
        remoteEntry({
          icon: "Zap",
          source: {
            npm: {
              package: "bb-plugin-widgets",
              tag: "beta",
              registry: "https://npm.acme.test",
            },
          },
        }),
      );
      await expect(catalog.install({ entryId: "widgets" })).rejects.toThrow(
        "catalog installation stopped by test",
      );
      expect(installedCatalogEntries).toEqual([
        {
          marketplace: "bb-community",
          entryId: "widgets",
          pluginId: "widgets",
          source: "npm:bb-plugin-widgets@beta",
          selection: ROOT_PLUGIN_SOURCE_SELECTION,
          npmRegistry: "https://npm.acme.test",
        },
      ]);
    });

    it("offers a marketplace entry without judging compatibility", async () => {
      const catalog = await refreshedCatalog(remoteEntry({ icon: "Zap" }));
      const [entry] = await catalog.search("widgets");
      expect(entry).toMatchObject({
        compatible: true,
        incompatibleReason: null,
      });
      const plan = await catalog.installPlan({ entryId: "widgets" });
      expect(plan).toMatchObject({
        compatible: true,
        incompatibleReason: null,
      });
      await expect(catalog.install({ entryId: "widgets" })).rejects.toThrow(
        "catalog installation stopped by test",
      );
    });

    it("reads the installed flag from catalog provenance", async () => {
      const catalog = service();
      upsertInstalledPlugin(db, {
        id: "hover-cards",
        source:
          "git:https://github.com/brsbl/bb-plugins.git@30f91fd977ba1ce60532af27a68534464fb62516",
        provenance: {
          kind: "catalog",
          marketplace: "bb-community",
          entryId: "thread-hover-cards",
        },
        sourceIntent: {
          kind: "git",
          url: "https://github.com/brsbl/bb-plugins.git",
          subdirectory: null,
          selector: {
            kind: "ref",
            ref: "30f91fd977ba1ce60532af27a68534464fb62516",
            refKind: "commit",
          },
        },
        exactResolution: {
          kind: "git",
          commit: "30f91fd977ba1ce60532af27a68534464fb62516",
        },
        updateState: {
          lastCheckAt: null,
          availableCompatibleVersion: null,
          newestIncompatibleVersion: null,
          statusDetail: null,
        },
        activeArtifactId: null,
        rootDir: "/managed/thread-hover-cards",
        version: "0.1.0",
        enabled: true,
      });
      expect((await catalog.search("thread-hover-cards"))[0]?.installed).toBe(
        true,
      );
    });
  });

  describe("catalog limits and trust", () => {
    it("refuses a manifest that lists more than the entry limit", async () => {
      const oversize = manifest(
        Array.from({ length: 257 }, (_unused, index) =>
          remoteEntry({ id: `widgets-${index}` }),
        ),
      );
      const catalog = service({
        fetch: async () => jsonResponse(oversize),
      });

      await expect(catalog.refresh(1_000)).rejects.toThrow(
        /at most 256 plugins/u,
      );
      expect(getPluginMarketplace(db, "bb-community")?.lastError).toMatch(
        /at most 256 plugins/u,
      );
    });

    it("refuses a catalog whose icons pass the total byte budget", async () => {
      const bigSvg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>${"a".repeat(200 * 1024)}</title><path d="M0 0h16v16H0z"/></svg>`,
      );
      const entries = Array.from({ length: 64 }, (_unused, index) =>
        remoteEntry({
          id: `widgets-${index}`,
          icon: { url: `./icons/widgets-${index}.svg` },
        }),
      );
      const catalog = service({
        fetch: async (url) =>
          url === MANIFEST_URL
            ? jsonResponse(manifest(entries))
            : new Response(bigSvg, {
                status: 200,
                headers: { "content-type": "image/svg+xml" },
              }),
      });

      await expect(catalog.refresh(1_000)).rejects.toThrow(
        /exceed the 8388608 byte total limit/u,
      );
    });

    it("fetches entry icons concurrently", async () => {
      let inFlight = 0;
      let peak = 0;
      const entries = Array.from({ length: 12 }, (_unused, index) =>
        remoteEntry({
          id: `widgets-${index}`,
          icon: { url: `./icons/widgets-${index}.svg` },
        }),
      );
      const catalog = service({
        fetch: async (url) => {
          if (url === MANIFEST_URL) return jsonResponse(manifest(entries));
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return new Response(VALID_SVG, {
            status: 200,
            headers: { "content-type": "image/svg+xml" },
          });
        },
      });

      await catalog.refresh(1_000);
      expect(peak).toBeGreaterThan(1);
      expect(await catalog.search("widgets-11")).toHaveLength(1);
    });

    it("drops an icon aimed at a non-public address", async () => {
      const warnings: string[] = [];
      const iconRequests: string[] = [];
      const catalog = service({
        warn: (message) => warnings.push(message),
        fetch: async (url) => {
          if (url === MANIFEST_URL) {
            return jsonResponse(
              manifest([
                remoteEntry({ icon: { url: "https://127.0.0.1/widgets.svg" } }),
              ]),
            );
          }
          if (url === STATS_URL) return new Response(null, { status: 404 });
          iconRequests.push(url);
          return new Response(VALID_SVG, {
            status: 200,
            headers: { "content-type": "image/svg+xml" },
          });
        },
      });

      await catalog.refresh(1_000);
      expect(iconRequests).toEqual([]);
      expect(await catalog.icon("bb-community", "widgets")).toBeUndefined();
      expect(warnings.join("\n")).toMatch(/non-public address 127\.0\.0\.1/u);
    });

    it("drops a remote entry that claims a bundled plugin id", async () => {
      const bundled = listBundledPluginRegistrations();
      const occupied = bundled[0];
      if (occupied === undefined) throw new Error("no bundled plugin");
      const catalog = service({
        fetch: async (url) =>
          url === MANIFEST_URL
            ? jsonResponse(
                manifest([
                  remoteEntry({ id: occupied.pluginId }),
                  remoteEntry({ id: "widgets" }),
                ]),
              )
            : new Response(VALID_SVG, {
                status: 200,
                headers: { "content-type": "image/svg+xml" },
              }),
      });

      await catalog.refresh(1_000);
      const results = await catalog.search("");
      expect(
        results.filter((entry) => entry.pluginId === occupied.pluginId),
      ).toHaveLength(1);
      expect(
        results.find((entry) => entry.pluginId === occupied.pluginId)?.source,
      ).toBe(`builtin:${occupied.name}`);
      expect(results.some((entry) => entry.entryId === "widgets")).toBe(true);
      expect(getPluginMarketplace(db, "bb-community")?.lastError).toMatch(
        new RegExp(`matches a bundled plugin: ${occupied.pluginId}`, "u"),
      );
    });

    it("names the pinned npm registry in the entry source display", async () => {
      const catalog = service({
        fetch: async (url) =>
          url === MANIFEST_URL
            ? jsonResponse(
                manifest([
                  remoteEntry({
                    icon: "ZoomIn",
                    source: {
                      npm: {
                        package: "bb-plugin-widgets",
                        range: "^1.0.0",
                        registry: "https://npm.acme.test",
                      },
                    },
                  }),
                ]),
              )
            : new Response(null, { status: 404 }),
      });

      await catalog.refresh(1_000);
      expect((await catalog.search("widgets"))[0]?.source).toBe(
        "npm:bb-plugin-widgets@^1.0.0 (registry https://npm.acme.test)",
      );
    });
  });
});
