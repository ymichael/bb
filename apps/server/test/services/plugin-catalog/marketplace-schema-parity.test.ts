import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  parseBundledMarketplaceManifest,
  parseMarketplaceManifest,
} from "../../../src/services/plugin-catalog/marketplace-manifest.js";

const SCHEMA_PATHS = {
  1: fileURLToPath(
    new URL(
      "../../../../web/public/schemas/marketplace.schema.json",
      import.meta.url,
    ),
  ),
  2: fileURLToPath(
    new URL(
      "../../../../web/public/schemas/marketplace-v2.schema.json",
      import.meta.url,
    ),
  ),
} as const;

const publishedSchemaSchema = z.record(z.string(), z.unknown());

async function compilePublishedSchema(
  version: keyof typeof SCHEMA_PATHS,
): Promise<(value: unknown) => boolean> {
  const schema = publishedSchemaSchema.parse(
    JSON.parse(await readFile(SCHEMA_PATHS[version], "utf8")),
  );
  const ajv = new Ajv2020({ strict: false });
  ajv.addFormat("date-time", (value) => {
    const normalized = value
      .replace(/^(.{10})t/iu, "$1T")
      .replace(/z$/iu, "Z")
      .replace(/([+-]\d\d)(\d\d)$/u, "$1:$2")
      .replace(/([+-]\d\d)$/u, "$1:00");
    return z.iso.datetime({ offset: true }).safeParse(normalized).success;
  });
  ajv.addFormat("uri", (value) => {
    try {
      return new URL(value).protocol.length > 0;
    } catch {
      return false;
    }
  });
  return ajv.compile(schema);
}

interface Fixture {
  readonly label: string;
  readonly valid: boolean;
  readonly manifest: unknown;
}

function manifestWith(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "acme",
    displayName: "Acme plugins",
    plugins: [
      {
        id: "acme-plugin",
        displayName: "Acme",
        description: "An Acme plugin.",
        icon: "ZoomIn",
        author: { name: "Acme" },
        source: { npm: { package: "bb-plugin-acme" } },
        ...entry,
      },
    ],
  };
}

function iconFixture(label: string, url: string, valid: boolean): Fixture {
  return { label, valid, manifest: manifestWith({ icon: { url } }) };
}

function rangeFixture(label: string, range: string, valid: boolean): Fixture {
  return {
    label,
    valid,
    manifest: manifestWith({
      source: { npm: { package: "bb-plugin-acme", range } },
    }),
  };
}

function enginesFixture(label: string, engines: unknown): Fixture {
  return { label, valid: false, manifest: manifestWith({ engines }) };
}

const fixtures: readonly Fixture[] = [
  { label: "minimal npm entry", valid: true, manifest: manifestWith({}) },
  {
    label: "git entry",
    valid: true,
    manifest: manifestWith({
      source: {
        git: {
          url: "https://example.com/acme/plugin.git",
          ref: "v1.2.3",
          subdir: "plugins/acme",
        },
      },
    }),
  },
  {
    label: "git semver range entry",
    valid: true,
    manifest: manifestWith({
      source: {
        git: {
          url: "https://example.com/acme/plugin.git",
          range: "^1.2.3",
          tagPrefix: "acme/",
          subdir: "plugins/acme",
        },
      },
    }),
  },
  {
    label: "invalid git semver range",
    valid: false,
    manifest: manifestWith({
      source: {
        git: {
          url: "https://example.com/acme/plugin.git",
          range: "latest",
        },
      },
    }),
  },
  {
    label: "unknown entry field",
    valid: false,
    manifest: manifestWith({ surprise: true }),
  },
  {
    label: "npm range and tag together",
    valid: false,
    manifest: manifestWith({
      source: {
        npm: { package: "bb-plugin-acme", range: "^1.0.0", tag: "beta" },
      },
    }),
  },

  iconFixture("absolute https icon", "https://cdn.example.com/a.svg", true),
  iconFixture("relative icon", "icons/acme.png", true),
  iconFixture("dot-relative icon", "./acme.webp", true),
  iconFixture("uppercase extension", "https://cdn.example.com/A.PNG", true),
  iconFixture(
    "query after the extension",
    "https://cdn.example.com/a.svg?v=2",
    true,
  ),
  iconFixture("ftp icon", "ftp://host.example.com/icon.svg", false),
  iconFixture("plain http icon", "http://cdn.example.com/a.svg", false),
  iconFixture("data URL icon", "data:image/svg+xml,a.svg", false),
  iconFixture("javascript URL icon", "javascript:a.svg", false),
  iconFixture("unsupported extension", "https://cdn.example.com/a.gif", false),
  iconFixture("no extension", "https://cdn.example.com/a", false),
  {
    label: "unknown icon field",
    valid: false,
    manifest: manifestWith({ icon: { url: "./acme.svg", logo: true } }),
  },

  rangeFixture("caret range", "^1.2.3", true),
  rangeFixture("comparator pair", ">=1.0.0 <2.0.0", true),
  rangeFixture("hyphen range", "1.2.3 - 2.3.4", true),
  rangeFixture("alternatives", "1.x || >=2.5.0", true),
  rangeFixture("prerelease comparator", ">1.2.3-alpha.3", true),
  rangeFixture("star", "*", true),
  rangeFixture("prose", "latest", false),
  rangeFixture("bare operator", ">=", false),
  rangeFixture("four segments", "1.2.3.4", false),
  rangeFixture("garbage alternative", "1.0.0 || garbage", false),

  enginesFixture("engines.bb range", { bb: ">=0.30.0" }),
  enginesFixture("engines.bbPluginSdk range", { bbPluginSdk: "^0.5.0" }),
  enginesFixture("empty engines object", {}),

  {
    label: "marketplace name at the route limit",
    valid: true,
    manifest: { ...manifestWith({}), name: "a".repeat(64) },
  },
  {
    label: "marketplace name past the route limit",
    valid: false,
    manifest: { ...manifestWith({}), name: "a".repeat(65) },
  },
];

function manifestV2With(
  entry: Record<string, unknown>,
  manifestFields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...manifestWith(entry),
    schemaVersion: 2,
    ...manifestFields,
  };
}

const v2Fixtures: readonly Fixture[] = [
  {
    label: "minimal v2 entry",
    valid: true,
    manifest: manifestV2With({}),
  },
  {
    label: "all v2 fields",
    valid: true,
    manifest: manifestV2With(
      {
        category: "acme-tools",
        screenshots: ["https://cdn.example.com/acme.webp"],
        publishedAt: "2026-08-20T11:47:04-07:00",
        updatedAt: "2026-08-27T16:12:00Z",
      },
      {
        $schema: "https://getbb.app/schemas/marketplace-v2.schema.json",
        categories: [
          {
            id: "acme-tools",
            displayName: "Acme tools",
            description: "Tools from Acme.",
          },
        ],
        collections: [
          {
            id: "featured",
            displayName: "Featured",
            pluginIds: ["acme-plugin"],
          },
        ],
      },
    ),
  },
  {
    label: "unknown v2 category reference",
    valid: true,
    manifest: manifestV2With({ category: "unknown-category" }),
  },
  {
    label: "invalid v2 category pattern",
    valid: false,
    manifest: manifestV2With({ category: "Acme tools" }),
  },
  {
    label: "too many screenshots",
    valid: false,
    manifest: manifestV2With({
      screenshots: Array.from(
        { length: 7 },
        (_value, index) => `https://cdn.example.com/${index}.png`,
      ),
    }),
  },
  {
    label: "http screenshot",
    valid: false,
    manifest: manifestV2With({
      screenshots: ["http://cdn.example.com/acme.png"],
    }),
  },
  {
    label: "malformed absolute v2 icon URL",
    valid: true,
    manifest: manifestV2With({ icon: { url: "https:///icon.svg" } }),
  },
  {
    label: "uppercase http v2 icon URL",
    valid: true,
    manifest: manifestV2With({ icon: { url: "HTTP://example.com/icon.svg" } }),
  },
  {
    label: "screenshot extension in the query",
    valid: true,
    manifest: manifestV2With({
      screenshots: ["https://cdn.example.com/acme.txt?file=.png"],
    }),
  },
  {
    label: "partial prerelease range",
    valid: true,
    manifest: manifestV2With({
      source: { npm: { package: "bb-plugin-acme", range: "1.x-alpha" } },
    }),
  },
  {
    label: "partial range with build metadata",
    valid: true,
    manifest: manifestV2With({
      source: { npm: { package: "bb-plugin-acme", range: "1.2+build" } },
    }),
  },
  {
    label: "full prerelease range",
    valid: true,
    manifest: manifestV2With({
      source: {
        npm: { package: "bb-plugin-acme", range: ">=1.2.3-alpha" },
      },
    }),
  },
  {
    label: "double equals partial range",
    valid: true,
    manifest: manifestV2With({
      source: { npm: { package: "bb-plugin-acme", range: "==1.2" } },
    }),
  },
  {
    label: "range over the v2 length limit",
    valid: true,
    manifest: manifestV2With({
      source: {
        npm: {
          package: "bb-plugin-acme",
          range: ">=1.0.0 ".repeat(33).trim(),
        },
      },
    }),
  },
  {
    label: "uppercase https URL fields",
    valid: false,
    manifest: manifestV2With({
      author: { name: "Acme", url: "HTTPS://example.com/acme" },
      source: {
        npm: {
          package: "bb-plugin-acme",
          registry: "HTTPS://registry.example.com/",
        },
      },
    }),
  },
  {
    label: "malformed author URL",
    valid: true,
    manifest: manifestV2With({
      author: { name: "Acme", url: "https://" },
    }),
  },
  {
    label: "malformed npm registry URL",
    valid: true,
    manifest: manifestV2With({
      source: {
        npm: { package: "bb-plugin-acme", registry: "https://" },
      },
    }),
  },
  {
    label: "malformed git URL",
    valid: true,
    manifest: manifestV2With({
      source: { git: { url: "https://", ref: "v1.2.3" } },
    }),
  },
  {
    label: "date without time or offset",
    valid: false,
    manifest: manifestV2With({ publishedAt: "2026-08-20" }),
  },
  {
    label: "lowercase date-time with a basic offset",
    valid: true,
    manifest: manifestV2With({ publishedAt: "2026-08-20t11:47:04+0000" }),
  },
  {
    label: "duplicate collection plugin id",
    valid: false,
    manifest: manifestV2With(
      {},
      {
        collections: [
          {
            id: "featured",
            displayName: "Featured",
            pluginIds: ["acme-plugin", "acme-plugin"],
          },
        ],
      },
    ),
  },
];

describe("published marketplace schema parity", () => {
  it("agrees with the runtime parser on every fixture", async () => {
    const validate = await compilePublishedSchema(1);

    const disagreements = fixtures.flatMap((fixture) => {
      const published = validate(fixture.manifest);
      let runtime = true;
      try {
        parseMarketplaceManifest(fixture.manifest, "fixture");
      } catch {
        runtime = false;
      }
      return published === fixture.valid && (!published || runtime)
        ? []
        : [
            `${fixture.label}: expected ${fixture.valid ? "valid" : "invalid"}, published schema said ${published}, runtime parser said ${runtime}`,
          ];
    });

    expect(disagreements).toEqual([]);
  });

  it("agrees with the v2 runtime parser on known fields", async () => {
    const validate = await compilePublishedSchema(2);
    const disagreements = v2Fixtures.flatMap((fixture) => {
      const published = validate(fixture.manifest);
      let runtime = true;
      try {
        parseMarketplaceManifest(fixture.manifest, "fixture");
      } catch {
        runtime = false;
      }
      return published === fixture.valid && (!published || runtime)
        ? []
        : [
            `${fixture.label}: expected ${fixture.valid ? "valid" : "invalid"}, published schema said ${published}, runtime parser said ${runtime}`,
          ];
    });

    expect(disagreements).toEqual([]);
  });

  it("keeps the v2 publisher strict and the consumer tolerant", async () => {
    const validate = await compilePublishedSchema(2);
    const manifest = manifestV2With(
      {
        futureEntryField: true,
        author: { name: "Acme", futureAuthorField: true },
      },
      { futureManifestField: true },
    );

    expect(validate(manifest)).toBe(false);
    expect(parseMarketplaceManifest(manifest, "fixture")).toEqual(
      manifestV2With({}),
    );
  });

  it("keeps source objects strict as the v2 tolerance exception", async () => {
    const validate = await compilePublishedSchema(2);
    const manifests = [
      manifestV2With({
        source: {
          npm: { package: "bb-plugin-acme", regsitry: "https://npm.test/" },
        },
      }),
      manifestV2With({
        source: {
          git: {
            url: "https://example.com/acme.git",
            ref: "v1.0.0",
            futureField: true,
          },
        },
      }),
    ];

    for (const manifest of manifests) {
      expect(validate(manifest)).toBe(false);
      expect(() => parseMarketplaceManifest(manifest, "fixture")).toThrow();
    }
  });

  it("keeps the bundled source out of the public publisher schema", async () => {
    const validate = await compilePublishedSchema(2);
    const manifest = {
      ...manifestV2With({ source: { bundled: { plugin: "docs" } } }),
      name: "bb-official",
      displayName: "BB Official",
    };

    expect(validate(manifest)).toBe(false);
    expect(parseBundledMarketplaceManifest(manifest, "fixture")).toMatchObject({
      name: "bb-official",
    });
    expect(() => parseMarketplaceManifest(manifest, "fixture")).toThrow(
      /not allowed in fetched or third-party documents/u,
    );
  });

  it("caps the entry count in both contracts", async () => {
    for (const version of [1, 2] as const) {
      const validate = await compilePublishedSchema(version);
      const oversize = {
        schemaVersion: version,
        name: "acme",
        displayName: "Acme plugins",
        plugins: Array.from({ length: 257 }, (_unused, index) => ({
          id: `acme-plugin-${index}`,
          displayName: "Acme",
          description: "An Acme plugin.",
          icon: "ZoomIn",
          author: { name: "Acme" },
          source: { npm: { package: `bb-plugin-acme-${index}` } },
        })),
      };

      expect(validate(oversize)).toBe(false);
      expect(() => parseMarketplaceManifest(oversize, "fixture")).toThrow(
        /at most 256 plugins/u,
      );
    }
  });
});
