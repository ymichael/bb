import { describe, expect, it } from "vitest";
import {
  installedPluginSchema,
  pluginCatalogInstallRequestSchema,
  pluginCatalogSearchResponseSchema,
  pluginCatalogSearchResultSchema,
  pluginCatalogStatusSchema,
  pluginSettingDescriptorSchema,
} from "../src/index.js";

describe("plugin contracts", () => {
  it("accepts finite number setting descriptors", () => {
    expect(
      pluginSettingDescriptorSchema.parse({
        type: "number",
        label: "Retries",
        default: 3,
      }),
    ).toEqual({ type: "number", label: "Retries", default: 3 });
    expect(
      pluginSettingDescriptorSchema.safeParse({
        type: "number",
        label: "Retries",
        default: Number.POSITIVE_INFINITY,
      }).success,
    ).toBe(false);
  });

  it("accepts catalog install coordinates without marketplace nesting", () => {
    expect(
      pluginCatalogInstallRequestSchema.parse({
        entryId: "notes",
      }),
    ).toEqual({ entryId: "notes" });
    expect(() =>
      pluginCatalogInstallRequestSchema.parse({
        entryId: "notes",
        version: "1.2.0",
      }),
    ).toThrow();
    expect(() =>
      pluginCatalogInstallRequestSchema.parse({
        marketplace: { marketplaceId: "official", entryId: "notes" },
      }),
    ).toThrow();
  });

  it("keeps status to the bundled plugin count and search fields required", () => {
    const status = {
      pluginCount: 13,
      includedPluginCount: 8,
      optionalPluginCount: 5,
    };
    expect(pluginCatalogStatusSchema.parse(status)).toEqual(status);
    expect(
      pluginCatalogStatusSchema.parse({ ...status, lastError: null }),
    ).toEqual(status);

    expect(() =>
      pluginCatalogSearchResultSchema.parse({
        entryId: "notes",
        displayName: "Notes",
        description: "Notes",
        icon: null,
        category: "Productivity",
        source: "builtin:notes",
        installed: false,
        compatible: true,
        incompatibleReason: null,
      }),
    ).toThrow();
  });

  it("parses v2 discovery metadata and defaults search arrays", () => {
    const required = {
      entryId: "notes",
      pluginId: "notes",
      displayName: "Notes",
      description: "Notes",
      icon: null,
      iconUrl: null,
      source: "git:https://github.com/acme/notes.git@v1",
      marketplace: "acme",
      marketplaceDisplayName: "Acme",
      publisherKey: "acme",
      publisherLabel: "Acme",
      official: false,
      author: null,
      installed: false,
      compatible: true,
      incompatibleReason: null,
    };
    expect(pluginCatalogSearchResultSchema.parse(required)).toMatchObject({
      screenshots: [],
      collections: [],
    });
    expect(
      pluginCatalogSearchResultSchema.parse({
        ...required,
        categoryId: "acme-tools",
        category: "Acme tools",
        screenshots: ["https://cdn.example.com/notes.png"],
        collections: [{ id: "featured", rank: 0 }],
        publishedAt: "2026-08-20T11:47:04-07:00",
        updatedAt: "2026-08-27T16:12:00Z",
      }),
    ).toMatchObject({
      categoryId: "acme-tools",
      category: "Acme tools",
      collections: [{ id: "featured", rank: 0 }],
    });
    expect(
      pluginCatalogSearchResultSchema.safeParse({
        ...required,
        categoryId: "Acme tools",
      }).success,
    ).toBe(false);
  });

  it("requires complete collections on the catalog search response", () => {
    expect(
      pluginCatalogSearchResponseSchema.parse({
        results: [],
        collections: [
          {
            id: "featured",
            displayName: "Featured",
            pluginIds: ["notes", "tasks"],
          },
        ],
      }),
    ).toEqual({
      results: [],
      collections: [
        {
          id: "featured",
          displayName: "Featured",
          pluginIds: ["notes", "tasks"],
        },
      ],
    });
    expect(
      pluginCatalogSearchResponseSchema.safeParse({ results: [] }).success,
    ).toBe(false);
  });

  it("requires server-filled installed plugin discovery arrays", () => {
    expect(
      installedPluginSchema.shape.screenshots.safeParse(undefined).success,
    ).toBe(false);
    expect(
      installedPluginSchema.shape.collections.safeParse(undefined).success,
    ).toBe(false);
  });
});
