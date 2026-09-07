import { describe, expect, it } from "vitest";
import {
  PLUGIN_CATALOG_CATEGORIES,
  pluginCatalogCategory,
  pluginCatalogCategoryIdSchema,
  pluginMarketplaceCategorySchema,
  pluginMarketplaceCollectionIdSchema,
  pluginMarketplaceCollectionPluginIdSchema,
  pluginMarketplaceCollectionSchema,
} from "../src/plugin-catalog-category.js";

describe("plugin catalog categories", () => {
  it("keeps the agreed built-in category list", () => {
    expect(
      PLUGIN_CATALOG_CATEGORIES.map(({ id, displayName }) => ({
        id,
        displayName,
      })),
    ).toEqual([
      { id: "themes-and-appearance", displayName: "Themes & Appearance" },
      { id: "thread-management", displayName: "Thread Management" },
      { id: "thread-content", displayName: "Thread Content" },
      { id: "memory-and-context", displayName: "Memory & Context" },
      { id: "security", displayName: "Security" },
      { id: "agents-and-providers", displayName: "Agents & Providers" },
      {
        id: "token-usage-and-limits",
        displayName: "Token Usage & Limits",
      },
      { id: "notifications", displayName: "Notifications" },
      { id: "code-and-reviews", displayName: "Code & Reviews" },
      {
        id: "file-viewers-and-editors",
        displayName: "File Viewers & Editors",
      },
      { id: "cloud-and-remote", displayName: "Cloud & Remote" },
      { id: "command-line", displayName: "Command Line" },
      { id: "utilities", displayName: "Utilities" },
      { id: "plugin-development", displayName: "Plugin Development" },
      { id: "tasks-and-workflows", displayName: "Tasks & Workflows" },
    ]);
    expect(PLUGIN_CATALOG_CATEGORIES).toHaveLength(15);
    for (const category of PLUGIN_CATALOG_CATEGORIES) {
      expect(category.description).not.toHaveLength(0);
      expect(pluginCatalogCategory(category.id)).toBe(category);
    }
  });

  it("accepts marketplace-defined category and collection IDs", () => {
    expect(pluginCatalogCategoryIdSchema.parse("acme-tools")).toBe(
      "acme-tools",
    );
    expect(pluginCatalogCategoryIdSchema.safeParse("Acme tools").success).toBe(
      false,
    );
    expect(pluginMarketplaceCollectionIdSchema.parse("featured")).toBe(
      "featured",
    );
    expect(pluginMarketplaceCollectionPluginIdSchema.parse("acme-one")).toBe(
      "acme-one",
    );
    expect(
      pluginMarketplaceCategorySchema.parse({
        id: "acme-tools",
        displayName: "Acme tools",
        description: "Tools from Acme.",
        futureField: true,
      }),
    ).toEqual({
      id: "acme-tools",
      displayName: "Acme tools",
      description: "Tools from Acme.",
    });
    expect(
      pluginMarketplaceCollectionSchema.parse({
        id: "featured",
        displayName: "Featured",
        pluginIds: ["acme-one"],
        futureField: true,
      }),
    ).toEqual({
      id: "featured",
      displayName: "Featured",
      pluginIds: ["acme-one"],
    });
    expect(
      pluginMarketplaceCollectionSchema.safeParse({
        id: "featured",
        displayName: "Featured",
        pluginIds: ["acme-one", "acme-one"],
      }).success,
    ).toBe(false);
  });
});
