import { describe, expect, it } from "vitest";

import { MARKETPLACE_V2_FIXTURE } from "./marketplace-v2.fixture.js";
import { parseMarketplaceV2Manifest } from "./marketplace-v2.js";

describe("parseMarketplaceV2Manifest", () => {
  it("parses the v2 fixture and fills omitted arrays at the boundary", () => {
    const parsed = parseMarketplaceV2Manifest({
      ...MARKETPLACE_V2_FIXTURE,
      collections: undefined,
      plugins: [
        {
          ...MARKETPLACE_V2_FIXTURE.plugins[0],
          tags: undefined,
          screenshots: undefined,
        },
      ],
    });
    expect(parsed.collections).toEqual([]);
    expect(parsed.plugins[0]?.tags).toEqual([]);
    expect(parsed.plugins[0]?.screenshots).toEqual([]);
  });

  it("ignores unknown keys at each document level", () => {
    const parsed = parseMarketplaceV2Manifest({
      ...MARKETPLACE_V2_FIXTURE,
      futureDocumentField: true,
      categories: [
        { ...MARKETPLACE_V2_FIXTURE.categories[0], futureCategoryField: true },
      ],
      collections: [
        {
          ...MARKETPLACE_V2_FIXTURE.collections[0],
          futureCollectionField: true,
        },
      ],
      plugins: [
        {
          ...MARKETPLACE_V2_FIXTURE.plugins[0],
          futureEntryField: true,
          author: {
            ...MARKETPLACE_V2_FIXTURE.plugins[0]?.author,
            futureAuthorField: true,
          },
        },
      ],
    });
    expect(parsed).not.toHaveProperty("futureDocumentField");
    expect(parsed.categories[0]).not.toHaveProperty("futureCategoryField");
    expect(parsed.collections[0]).not.toHaveProperty("futureCollectionField");
    expect(parsed.plugins[0]).not.toHaveProperty("futureEntryField");
    expect(parsed.plugins[0]?.author).not.toHaveProperty("futureAuthorField");
  });

  it("accepts an unknown category id and rejects an invalid id", () => {
    expect(parseMarketplaceV2Manifest(MARKETPLACE_V2_FIXTURE)).toMatchObject({
      plugins: expect.arrayContaining([
        expect.objectContaining({
          id: "orphan-tool",
          category: "future-tools",
        }),
      ]),
    });
    expect(() =>
      parseMarketplaceV2Manifest({
        ...MARKETPLACE_V2_FIXTURE,
        plugins: [
          { ...MARKETPLACE_V2_FIXTURE.plugins[0], category: "Bad Category" },
        ],
      }),
    ).toThrow(/category/u);
  });

  it("rejects unsafe subdirectories and duplicate collection members", () => {
    const entry = MARKETPLACE_V2_FIXTURE.plugins[1];
    const collection = MARKETPLACE_V2_FIXTURE.collections[0];
    if (
      entry === undefined ||
      !("git" in entry.source) ||
      collection === undefined
    ) {
      throw new Error("The fixture needs a Git plugin and a collection");
    }
    const git = entry.source.git;
    for (const subdir of ["../outside", ".git/hooks", "plugins/../outside"]) {
      expect(() =>
        parseMarketplaceV2Manifest({
          ...MARKETPLACE_V2_FIXTURE,
          plugins: [
            {
              ...entry,
              source: { git: { ...git, subdir } },
            },
          ],
        }),
      ).toThrow(/subdir/u);
    }
    expect(() =>
      parseMarketplaceV2Manifest({
        ...MARKETPLACE_V2_FIXTURE,
        collections: [
          {
            ...collection,
            pluginIds: ["prompt-library", "prompt-library"],
          },
        ],
      }),
    ).toThrow(/duplicate plugin id/u);
  });

  it("accepts an empty catalog and truncates display arrays", () => {
    expect(
      parseMarketplaceV2Manifest({
        ...MARKETPLACE_V2_FIXTURE,
        plugins: [],
      }).plugins,
    ).toEqual([]);

    const entry = MARKETPLACE_V2_FIXTURE.plugins[0];
    if (entry === undefined) throw new Error("The fixture needs a plugin");
    const parsed = parseMarketplaceV2Manifest({
      ...MARKETPLACE_V2_FIXTURE,
      plugins: [
        {
          ...entry,
          tags: Array.from({ length: 12 }, (_, index) => `tag-${index}`),
          screenshots: Array.from(
            { length: 8 },
            (_, index) =>
              `https://getbb.app/marketplace/v2/screenshots/plugin/${index}.png`,
          ),
        },
      ],
    });
    expect(parsed.plugins[0]?.tags).toHaveLength(10);
    expect(parsed.plugins[0]?.screenshots).toHaveLength(6);
  });
});
