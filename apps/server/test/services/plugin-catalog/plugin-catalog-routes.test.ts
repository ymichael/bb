import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, migrate, type DbConnection } from "@bb/db";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerPluginCatalogRoutes } from "../../../src/routes/plugin-catalog.js";
import { createPluginCatalogService } from "../../../src/services/plugin-catalog/plugin-catalog-service.js";
import { BUNDLED_CURATED_MARKETPLACE } from "../../../src/services/plugin-catalog/curated-marketplace.js";
import {
  BUILTIN_PLUGINS,
  BUNDLED_PLUGINS,
  OFFICIAL_PLUGINS,
} from "../../../src/services/plugins/builtin-registry.js";

const MANIFEST_URL = "https://marketplace.test/marketplace.json";
const SEED_ENTRY_COUNT = BUNDLED_CURATED_MARKETPLACE.plugins.length;
const VALID_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h16v16H0z"/></svg>',
);

describe("plugin catalog routes", () => {
  let db: DbConnection;

  let dataDir: string;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    dataDir = await mkdtemp(join(tmpdir(), "bb-catalog-routes-"));
  });

  afterEach(async () => {
    db.$client.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function catalogApp(
    fetchImpl?: Parameters<typeof createPluginCatalogService>[0]["fetch"],
  ) {
    const catalog = createPluginCatalogService({
      db,
      appVersion: "1.0.0",
      marketplaceUrl: MANIFEST_URL,
      dataDir,
      plugins: {
        installOfficialPlugin: async () => {
          throw new Error("unexpected install");
        },
        installCatalogPlugin: async () => {
          throw new Error("unexpected catalog install");
        },
        resolveCatalogNpmSource: async () => ({
          outcome: "unavailable" as const,
          detail: "no registry in this test",
        }),
      },
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    });
    const app = new Hono();
    registerPluginCatalogRoutes(app, catalog);
    return { app, catalog };
  }

  it("serves status/search and validates install requests", async () => {
    const { app } = catalogApp();

    const status = await app.request("/plugin-catalog");
    await expect(status.json()).resolves.toMatchObject({
      catalog: {
        pluginCount: BUNDLED_PLUGINS.length + SEED_ENTRY_COUNT,
        includedPluginCount: BUILTIN_PLUGINS.length,
        optionalPluginCount: OFFICIAL_PLUGINS.length + SEED_ENTRY_COUNT,
      },
    });
    const search = await app.request(
      "/plugin-catalog/search?q=durable%20memory",
    );
    await expect(search.json()).resolves.toMatchObject({
      results: [{ entryId: "memory", installed: false }],
      collections: [{ id: "bb-official", displayName: "BB Official" }],
    });

    const refresh = await app.request("/plugin-catalog/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(refresh.status).toBe(404);

    const install = await app.request("/plugin-catalog/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "memory" }),
    });
    expect(install.status).toBe(422);
    await expect(install.json()).resolves.toMatchObject({
      error: expect.stringContaining("unexpected install"),
    });

    const versionOverride = await app.request("/plugin-catalog/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "memory", version: "0.2.0" }),
    });
    expect(versionOverride.status).toBe(422);
  });

  it("serves a cached icon with hash-gated caching and refuses unknown ones", async () => {
    const { app, catalog } = catalogApp(async (url) =>
      url === MANIFEST_URL
        ? new Response(
            JSON.stringify({
              schemaVersion: 1,
              name: "bb-community",
              displayName: "BB Community",
              plugins: [
                {
                  id: "widgets",
                  displayName: "Acme Widgets",
                  description: "Widgets for threads.",
                  icon: { url: "./icons/widgets.svg" },
                  author: { name: "Acme" },
                  source: {
                    git: {
                      url: "https://github.com/acme/plugins.git",
                      ref: "v1.0.0",
                    },
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response(VALID_SVG, { status: 200 }),
    );
    await catalog.refresh(1_000);
    const hash = (await catalog.icon("bb-community", "widgets"))?.hash;
    expect(hash).toBeDefined();

    const hashed = await app.request(
      `/plugin-catalog/icons/bb-community/widgets?h=${hash}`,
    );
    expect(hashed.status).toBe(200);
    expect(hashed.headers.get("content-type")).toBe("image/svg+xml");
    expect(hashed.headers.get("cache-control")).toContain("immutable");
    expect(await hashed.text()).toBe(VALID_SVG.toString());

    const stale = await app.request(
      "/plugin-catalog/icons/bb-community/widgets?h=stale",
    );
    expect(stale.headers.get("cache-control")).toBe("no-store");

    const missing = await app.request(
      "/plugin-catalog/icons/bb-community/nothing",
    );
    expect(missing.status).toBe(404);
  });

  describe("marketplace routes", () => {
    const ACME_URL = "https://acme.test/marketplace.json";

    function acmeCatalog(): unknown {
      return {
        schemaVersion: 1,
        name: "acme-plugins",
        displayName: "Acme Plugins",
        plugins: [
          {
            id: "notes",
            displayName: "Acme Notes",
            description: "Notes beside a thread.",
            icon: "Zap",
            author: { name: "Acme" },
            source: {
              npm: { package: "bb-plugin-notes", range: "^1.0.0" },
            },
          },
        ],
      };
    }

    function acmeApp() {
      return catalogApp(async (url) =>
        url === ACME_URL
          ? new Response(JSON.stringify(acmeCatalog()), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response("not found", { status: 404 }),
      );
    }

    async function postJson(
      app: ReturnType<typeof catalogApp>["app"],
      path: string,
      body: unknown,
    ): Promise<Response> {
      return app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("adds, lists, refreshes, and removes through the routes", async () => {
      const { app } = acmeApp();

      const added = await postJson(app, "/marketplaces", { source: ACME_URL });
      expect(added.status).toBe(200);
      await expect(added.json()).resolves.toMatchObject({
        ok: true,
        marketplace: { name: "acme-plugins", official: false, entryCount: 1 },
      });

      const listed = await app.request("/marketplaces");
      await expect(listed.json()).resolves.toMatchObject({
        marketplaces: [
          { name: "bb-official", official: true, sourceKind: "path" },
          { name: "bb-community" },
          { name: "acme-plugins" },
        ],
      });

      const refreshed = await postJson(app, "/marketplaces/refresh", {
        name: "acme-plugins",
      });
      await expect(refreshed.json()).resolves.toMatchObject({
        results: [{ name: "acme-plugins", ok: true, error: null }],
      });

      const removed = await app.request("/marketplaces/acme-plugins", {
        method: "DELETE",
      });
      expect(removed.status).toBe(200);
      await expect(removed.json()).resolves.toEqual({
        ok: true,
        convertedPluginIds: [],
      });
    });

    it("validates request bodies and marketplace names at the boundary", async () => {
      const { app } = acmeApp();

      const badBody = await postJson(app, "/marketplaces", { url: ACME_URL });
      expect(badBody.status).toBe(422);

      const badName = await app.request("/marketplaces/Not%20A%20Name", {
        method: "DELETE",
      });
      expect(badName.status).toBe(422);

      const badRefresh = await postJson(app, "/marketplaces/refresh", {
        name: "Not A Name",
      });
      expect(badRefresh.status).toBe(422);

      const longName = "a".repeat(65);
      const longRemoval = await app.request(`/marketplaces/${longName}`, {
        method: "DELETE",
      });
      expect(longRemoval.status).toBe(422);

      const longPlan = await app.request(
        `/plugin-catalog/install-plan?entryId=notes&marketplace=${longName}`,
      );
      expect(longPlan.status).toBe(422);

      const reserved = await app.request("/marketplaces/bb-community", {
        method: "DELETE",
      });
      expect(reserved.status).toBe(422);
      await expect(reserved.json()).resolves.toMatchObject({
        error: expect.stringContaining("cannot be removed"),
      });
    });

    it("serves an install plan and refuses an unknown selector", async () => {
      const { app } = acmeApp();
      await postJson(app, "/marketplaces", { source: ACME_URL });

      const plan = await app.request(
        "/plugin-catalog/install-plan?entryId=notes&marketplace=acme-plugins",
      );
      expect(plan.status).toBe(200);
      await expect(plan.json()).resolves.toMatchObject({
        plan: {
          kind: "marketplace",
          marketplace: "acme-plugins",
          official: false,
          source: "npm:bb-plugin-notes@^1.0.0",
          resolvedSource: {
            kind: "npm",
            package: "bb-plugin-notes",
            range: "^1.0.0",
            unresolvedReason: "no registry in this test",
          },
        },
      });

      const missingEntry = await app.request(
        "/plugin-catalog/install-plan?entryId=nope",
      );
      expect(missingEntry.status).toBe(422);

      const missingArgs = await app.request("/plugin-catalog/install-plan");
      expect(missingArgs.status).toBe(422);
    });

    it("routes an install to the named marketplace", async () => {
      const { app } = acmeApp();
      await postJson(app, "/marketplaces", { source: ACME_URL });

      const install = await postJson(app, "/plugin-catalog/install", {
        entryId: "notes",
        marketplace: "acme-plugins",
        confirmedSource: {
          kind: "npm",
          package: "bb-plugin-notes",
          range: "^1.0.0",
          unresolvedReason: "no registry in this test",
        },
      });
      expect(install.status).toBe(422);
      await expect(install.json()).resolves.toMatchObject({
        error: expect.stringContaining("the npm source could not be resolved"),
      });

      const unknownMarketplace = await postJson(
        app,
        "/plugin-catalog/install",
        { entryId: "notes", marketplace: "nope" },
      );
      expect(unknownMarketplace.status).toBe(422);
      await expect(unknownMarketplace.json()).resolves.toMatchObject({
        error: expect.stringContaining('unknown marketplace "nope"'),
      });
    });
  });
});
