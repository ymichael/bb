import {
  pluginCatalogInstallRequestSchema,
  pluginMarketplaceAddRequestSchema,
  pluginMarketplaceNameSchema,
  pluginMarketplaceRefreshRequestSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type {
  PluginCatalogEntrySelector,
  PluginCatalogService,
} from "../services/plugin-catalog/plugin-catalog-service.js";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function entrySelector(
  entryId: string | undefined,
  marketplace: string | undefined,
): PluginCatalogEntrySelector | null {
  const parsed = pluginCatalogInstallRequestSchema.safeParse({
    entryId,
    ...(marketplace === undefined ? {} : { marketplace }),
  });
  return parsed.success ? parsed.data : null;
}

export function registerPluginCatalogRoutes(
  app: Hono,
  catalog: PluginCatalogService,
): void {
  app.get("/plugin-catalog", (context) =>
    context.json({ catalog: catalog.status() }),
  );

  app.get("/plugin-catalog/search", async (context) =>
    context.json({
      results: await catalog.search(context.req.query("q") ?? ""),
      collections: catalog.collections(),
    }),
  );

  app.get("/plugin-catalog/icons/:marketplace/:entryId", async (context) => {
    const icon = await catalog.icon(
      context.req.param("marketplace"),
      context.req.param("entryId"),
    );
    if (icon === undefined) {
      return context.json({ ok: false, error: "unknown catalog icon" }, 404);
    }
    return context.body(new Uint8Array(icon.bytes), 200, {
      "content-type": icon.contentType,
      "cache-control":
        context.req.query("h") === icon.hash
          ? "public, max-age=31536000, immutable"
          : "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
    });
  });

  app.get("/plugin-catalog/install-plan", async (context) => {
    const selector = entrySelector(
      context.req.query("entryId"),
      context.req.query("marketplace"),
    );
    if (selector === null) {
      return context.json(
        { error: "expected ?entryId=<id>[&marketplace=<name>]" },
        422,
      );
    }
    try {
      return context.json({ plan: await catalog.installPlan(selector) });
    } catch (error) {
      return context.json({ error: message(error) }, 422);
    }
  });

  app.post("/plugin-catalog/install", async (context) => {
    const json: unknown = await context.req.json().catch(() => null);
    const body = pluginCatalogInstallRequestSchema.safeParse(json);
    if (!body.success) {
      return context.json(
        {
          error:
            'expected { "entryId": string, "marketplace"?: string, "confirmedSource"?: object }',
        },
        422,
      );
    }
    try {
      return context.json({
        ok: true as const,
        plugin: await catalog.install(body.data),
      });
    } catch (error) {
      return context.json({ error: message(error) }, 422);
    }
  });

  app.get("/marketplaces", (context) =>
    context.json({ marketplaces: catalog.listMarketplaces() }),
  );

  app.post("/marketplaces", async (context) => {
    const json: unknown = await context.req.json().catch(() => null);
    const body = pluginMarketplaceAddRequestSchema.safeParse(json);
    if (!body.success) {
      return context.json({ error: 'expected { "source": string }' }, 422);
    }
    try {
      return context.json({
        ok: true as const,
        marketplace: await catalog.addMarketplace(body.data.source),
      });
    } catch (error) {
      return context.json({ error: message(error) }, 422);
    }
  });

  app.post("/marketplaces/refresh", async (context) => {
    const json: unknown = await context.req.json().catch(() => null);
    const body = pluginMarketplaceRefreshRequestSchema.safeParse(json ?? {});
    if (!body.success) {
      return context.json({ error: 'expected { "name"?: string }' }, 422);
    }
    try {
      return context.json({
        results: await catalog.refreshMarketplaces(body.data),
      });
    } catch (error) {
      return context.json({ error: message(error) }, 422);
    }
  });

  app.delete("/marketplaces/:name", async (context) => {
    const parsedName = pluginMarketplaceNameSchema.safeParse(
      context.req.param("name"),
    );
    if (!parsedName.success) {
      return context.json(
        { error: `invalid marketplace name "${context.req.param("name")}"` },
        422,
      );
    }
    try {
      const removed = await catalog.removeMarketplace(parsedName.data);
      return context.json({
        ok: true as const,
        convertedPluginIds: removed.convertedPluginIds,
      });
    } catch (error) {
      return context.json({ error: message(error) }, 422);
    }
  });
}
