import { describe, expect, it } from "vitest";
import {
  marketplaceEntryV1Schema,
  marketplaceEntryV2Schema,
} from "../src/plugin-marketplace-entry.js";

function entry(): Record<string, unknown> {
  return {
    id: "author-tools",
    displayName: "Author tools",
    description: "Tools for plugin authors.",
    icon: { url: "./author-tools.svg" },
    tags: ["plugin-development"],
    author: { name: "Author", github: "author" },
    source: {
      git: {
        url: "https://github.com/author/author-tools.git",
        range: "^1.0.0",
        tagPrefix: "author-tools/",
      },
    },
  };
}

describe("marketplace entry schemas", () => {
  it("keeps v1 strict", () => {
    expect(marketplaceEntryV1Schema.parse(entry())).toEqual(entry());
    expect(
      marketplaceEntryV1Schema.safeParse({ ...entry(), category: "utilities" })
        .success,
    ).toBe(false);
    expect(
      marketplaceEntryV1Schema.safeParse({ ...entry(), overview: "# Notes\n" })
        .success,
    ).toBe(false);
  });

  it("accepts a v2 overview text and rejects an empty one", () => {
    expect(
      marketplaceEntryV2Schema.parse({ ...entry(), overview: "# Notes\n" })
        .overview,
    ).toBe("# Notes\n");
    expect(
      marketplaceEntryV2Schema.safeParse({ ...entry(), overview: "" }).success,
    ).toBe(false);
  });

  it("accepts optional v2 fields and ignores discovery metadata keys", () => {
    expect(
      marketplaceEntryV2Schema.parse({
        ...entry(),
        category: "acme-tools",
        screenshots: ["./screenshots/author-tools/one.webp"],
        publishedAt: "2026-08-20T11:47:04-07:00",
        updatedAt: "2026-08-27T16:12:00Z",
        futureEntryField: true,
        icon: { url: "./author-tools.svg", futureIconField: true },
        author: {
          name: "Author",
          github: "author",
          futureAuthorField: true,
        },
        source: {
          git: {
            url: "https://github.com/author/author-tools.git",
            range: "^1.0.0",
          },
        },
      }),
    ).toEqual({
      ...entry(),
      source: {
        git: {
          url: "https://github.com/author/author-tools.git",
          range: "^1.0.0",
        },
      },
      category: "acme-tools",
      screenshots: ["./screenshots/author-tools/one.webp"],
      publishedAt: "2026-08-20T11:47:04-07:00",
      updatedAt: "2026-08-27T16:12:00Z",
    });
    expect(marketplaceEntryV2Schema.parse(entry())).toEqual(entry());
  });

  it("applies the registry screenshot and date rules", () => {
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...entry(),
        screenshots: ["http://example.com/one.png"],
      }).success,
    ).toBe(false);
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...entry(),
        screenshots: ["https://example.com/one.txt?file=.png"],
      }).success,
    ).toBe(true);
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...entry(),
        screenshots: Array.from(
          { length: 7 },
          (_value, index) => `https://example.com/${index}.png`,
        ),
      }).success,
    ).toBe(false);
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...entry(),
        publishedAt: "2026-08-20",
      }).success,
    ).toBe(false);
  });

  it("accepts the registry URL patterns", () => {
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...entry(),
        icon: { url: "https:///icon.svg" },
      }).success,
    ).toBe(true);
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...entry(),
        icon: { url: "HTTP://example.com/icon.svg" },
      }).success,
    ).toBe(true);
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...entry(),
        author: { name: "Author", url: "https://" },
      }).success,
    ).toBe(true);
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...entry(),
        source: {
          npm: { package: "author-tools", registry: "https://" },
        },
      }).success,
    ).toBe(true);
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...entry(),
        source: { git: { url: "https://", ref: "v1.0.0" } },
      }).success,
    ).toBe(true);
  });

  it("accepts the registry date-time format", () => {
    for (const publishedAt of [
      "2026-08-20t11:47:04z",
      "2026-08-20T11:47:04+0000",
      "2026-08-20T11:47:04+00",
      "2016-12-31T23:59:60Z",
    ]) {
      expect(
        marketplaceEntryV2Schema.safeParse({ ...entry(), publishedAt }).success,
      ).toBe(true);
    }
  });

  it("defers v2 semver range validity to the server", () => {
    for (const range of ["1.x-alpha", "1.2-alpha", "^1.2-alpha"]) {
      expect(
        marketplaceEntryV2Schema.safeParse({
          ...entry(),
          source: { npm: { package: "author-tools", range } },
        }).success,
      ).toBe(true);
    }
    for (const range of ["1.2+build", ">=1.2.3-alpha", "==1", "==1.2"]) {
      expect(
        marketplaceEntryV2Schema.safeParse({
          ...entry(),
          source: { npm: { package: "author-tools", range } },
        }).success,
      ).toBe(true);
    }
  });

  it("accepts a long semver range without expression evaluation", () => {
    const startedAt = performance.now();
    const result = marketplaceEntryV2Schema.safeParse({
      ...entry(),
      source: {
        npm: { package: "author-tools", range: `${" ".repeat(20_000)}!` },
      },
    });

    expect(result.success).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  it("accepts uppercase https schemes in v2 URL fields", () => {
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...entry(),
        author: { name: "Author", url: "HTTPS://example.com/author" },
        source: {
          npm: {
            package: "author-tools",
            registry: "HTTPS://registry.example.com/",
          },
        },
      }).success,
    ).toBe(true);
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...entry(),
        source: {
          git: {
            url: "HTTPS://github.com/author/author-tools.git",
            ref: "v1.0.0",
          },
        },
      }).success,
    ).toBe(true);
  });

  it("rejects conflicting known source fields", () => {
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...entry(),
        source: {
          npm: { package: "author-tools" },
          git: {
            url: "https://github.com/author/author-tools.git",
            ref: "v1.0.0",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...entry(),
        source: {
          git: {
            url: "https://github.com/author/author-tools.git",
            ref: "v1.0.0",
            range: "^1.0.0",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown source keys as the v2 tolerance exception", () => {
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...entry(),
        source: {
          npm: { package: "author-tools", regsitry: "https://npm.test/" },
        },
      }).success,
    ).toBe(false);
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...entry(),
        source: {
          git: {
            url: "https://github.com/author/author-tools.git",
            ref: "v1.0.0",
            futureGitField: true,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...entry(),
        source: {
          git: {
            url: "https://github.com/author/author-tools.git",
            ref: "v1.0.0",
          },
          futureSourceField: true,
        },
      }).success,
    ).toBe(false);
  });

  it("accepts a bundled source only in v2", () => {
    const bundled = {
      ...entry(),
      source: { bundled: { plugin: "docs" } },
    };
    expect(marketplaceEntryV2Schema.parse(bundled)).toEqual(bundled);
    expect(marketplaceEntryV1Schema.safeParse(bundled).success).toBe(false);
    expect(
      marketplaceEntryV2Schema.safeParse({
        ...bundled,
        source: {
          bundled: { plugin: "docs" },
          npm: { package: "bb-plugin-docs" },
        },
      }).success,
    ).toBe(false);
  });
});
