import { join } from "node:path";
import {
  MARKETPLACE_OVERVIEW_MAX_CHARS,
  marketplaceEntryV2Schema as domainMarketplaceEntryV2Schema,
  pluginCatalogCategory,
  pluginMarketplaceCategorySchema,
  pluginMarketplaceCollectionSchema,
  type PluginMarketplaceCategory,
  type PluginMarketplaceCollection,
} from "@bb/domain";
import {
  CURATED_PLUGIN_MARKETPLACE_NAME,
  pluginMarketplaceNameSchema,
  ROOT_PLUGIN_SOURCE_SELECTION,
  type PluginSourceSelection,
} from "@bb/server-contract";
import semver from "semver";
import { z } from "zod";
import { formatIssues } from "../plugins/collection-manifest.js";
import {
  gitRangeSourceSpec,
  gitSemverTagName,
  normalizeGitTagPrefix,
  normalizePluginSubdirectory,
  parsePluginSource,
} from "../plugins/install-sources.js";
import { BUNDLED_MARKETPLACE_NAME } from "./bundled-marketplace-paths.js";
export { BUNDLED_MARKETPLACE_NAME } from "./bundled-marketplace-paths.js";

export const MARKETPLACE_V1_SCHEMA_URL =
  "https://getbb.app/schemas/marketplace.schema.json";
export const MARKETPLACE_V2_SCHEMA_URL =
  "https://getbb.app/schemas/marketplace-v2.schema.json";

export const CURATED_MARKETPLACE_V1_URL =
  "https://getbb.app/marketplace/v1/marketplace.json";
export const CURATED_MARKETPLACE_V2_URL =
  "https://getbb.app/marketplace/v2/marketplace.json";

export const CURATED_MARKETPLACE_NAME = CURATED_PLUGIN_MARKETPLACE_NAME;

export const BUILTIN_PUBLISHER_LABEL = "BB Official";

const MARKETPLACE_MAX_ENTRIES = 256;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const manifestNameSchema = pluginMarketplaceNameSchema;
const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/u;
const ICON_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/u;
const ICON_EXTENSIONS = [".svg", ".png", ".webp"] as const;

const semverRange = z
  .string()
  .min(1)
  .refine((value) => semver.validRange(value) !== null, {
    message: "must be a valid semver range",
  });

const httpsUrl = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "must be an https URL" },
  );

function iconExtensionProblem(pathname: string): string | null {
  const lower = pathname.toLowerCase();
  return ICON_EXTENSIONS.some((extension) => lower.endsWith(extension))
    ? null
    : `must point at a ${ICON_EXTENSIONS.join(", ")} file`;
}

const iconUrlSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value);
    if (absolute && !value.toLowerCase().startsWith("https:")) {
      ctx.addIssue({ code: "custom", message: "must be an https URL" });
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(value, "https://marketplace.invalid/base/").pathname;
    } catch {
      ctx.addIssue({ code: "custom", message: "is not a valid URL" });
      return;
    }
    const problem = iconExtensionProblem(pathname);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });

const iconSchema = z.union([
  z.string().regex(ICON_NAME_PATTERN, "must be a host icon name"),
  z.object({ url: iconUrlSchema }).strict(),
]);

const authorSchema = z
  .object({
    name: z.string().min(1),
    github: z.string().regex(GITHUB_LOGIN_PATTERN).optional(),
    url: httpsUrl.optional(),
  })
  .strict();

const npmSourceSchema = z
  .object({
    npm: z
      .object({
        package: z
          .string()
          .min(1)
          .superRefine((value, ctx) => {
            try {
              const parsed = parsePluginSource(`npm:${value}`);
              if (
                parsed.kind !== "npm" ||
                parsed.name !== value ||
                parsed.spec.length !== 0
              ) {
                throw new Error("package name is ambiguous");
              }
            } catch (error) {
              ctx.addIssue({
                code: "custom",
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }),
        range: semverRange.optional(),
        tag: z
          .string()
          .min(1)
          .regex(/^[A-Za-z][A-Za-z0-9._-]*$/u)
          .optional(),
        registry: httpsUrl.optional(),
      })
      .strict()
      .refine((npm) => npm.range === undefined || npm.tag === undefined, {
        message: "range and tag are mutually exclusive",
      }),
  })
  .strict();

const gitSubdirSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      normalizePluginSubdirectory(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

const gitRefSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      const parsed = parsePluginSource(
        `git:https://marketplace.invalid/plugin.git@${value}`,
      );
      if (
        parsed.kind !== "git" ||
        parsed.selector.kind !== "ref" ||
        parsed.selector.ref !== value
      ) {
        throw new Error("git ref is ambiguous");
      }
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

const gitTagPrefixSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      normalizeGitTagPrefix(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

const gitSourceSchema = z.union([
  z
    .object({
      git: z
        .object({
          url: httpsUrl,
          subdir: gitSubdirSchema.optional(),
          ref: gitRefSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      git: z
        .object({
          url: httpsUrl,
          subdir: gitSubdirSchema.optional(),
          range: semverRange,
          tagPrefix: gitTagPrefixSchema.optional(),
        })
        .strict(),
    })
    .strict(),
]);

const marketplaceEntryV1Schema = z
  .object({
    id: z.string().regex(NAME_PATTERN),
    displayName: z.string().min(1),
    description: z.string().min(1),
    icon: iconSchema,
    tags: z.array(z.string().max(32).regex(TAG_PATTERN)).max(10).optional(),
    author: authorSchema,
    source: z.union([npmSourceSchema, gitSourceSchema]),
  })
  .strict();

const marketplaceEntryV2Schema = domainMarketplaceEntryV2Schema;

const marketplaceManifestV1Schema = z
  .object({
    $schema: z.literal(MARKETPLACE_V1_SCHEMA_URL).optional(),
    schemaVersion: z.literal(1),
    name: manifestNameSchema,
    displayName: z.string().min(1),
    description: z.string().min(1).optional(),
    plugins: z
      .array(marketplaceEntryV1Schema)
      .max(
        MARKETPLACE_MAX_ENTRIES,
        `a marketplace may list at most ${MARKETPLACE_MAX_ENTRIES} plugins`,
      )
      .superRefine((entries, ctx) => {
        const seen = new Set<string>();
        entries.forEach((entry, index) => {
          if (seen.has(entry.id)) {
            ctx.addIssue({
              code: "custom",
              path: [index, "id"],
              message: `duplicate plugin id "${entry.id}"`,
            });
          }
          seen.add(entry.id);
        });
      }),
  })
  .strict();

const marketplaceManifestV2Schema = z.object({
  $schema: z.literal(MARKETPLACE_V2_SCHEMA_URL).optional(),
  schemaVersion: z.literal(2),
  name: z.string().regex(NAME_PATTERN),
  displayName: z.string().min(1),
  description: z.string().min(1).optional(),
  categories: z.array(pluginMarketplaceCategorySchema).optional(),
  collections: z.array(pluginMarketplaceCollectionSchema).optional(),
  plugins: z
    .array(marketplaceEntryV2Schema)
    .max(
      MARKETPLACE_MAX_ENTRIES,
      `a marketplace may list at most ${MARKETPLACE_MAX_ENTRIES} plugins`,
    ),
});

export type MarketplaceManifestV1 = z.infer<typeof marketplaceManifestV1Schema>;
export type MarketplaceManifestV2 = z.infer<typeof marketplaceManifestV2Schema>;
export type MarketplaceManifest = MarketplaceManifestV1 | MarketplaceManifestV2;
export type MarketplaceEntryV1 = MarketplaceManifestV1["plugins"][number];
export type MarketplaceEntryV2 = MarketplaceManifestV2["plugins"][number];
export type MarketplaceEntry = MarketplaceEntryV1 | MarketplaceEntryV2;
export type BundledMarketplaceEntry = MarketplaceEntryV2 & {
  source: Extract<MarketplaceEntryV2["source"], { bundled: object }>;
};

export function isBundledMarketplaceEntry(
  entry: MarketplaceEntry,
): entry is BundledMarketplaceEntry {
  return "bundled" in entry.source;
}

export interface MarketplaceCollectionMembership {
  id: string;
  rank: number;
}

interface MarketplaceManifestIndex {
  categories: ReadonlyMap<string, PluginMarketplaceCategory>;
  collections: ReadonlyMap<string, readonly MarketplaceCollectionMembership[]>;
  resolvedCollections: readonly PluginMarketplaceCollection[];
}

const marketplaceManifestIndexes = new WeakMap<
  MarketplaceManifest,
  MarketplaceManifestIndex
>();

function marketplaceManifestIndex(
  manifest: MarketplaceManifest,
): MarketplaceManifestIndex {
  const existing = marketplaceManifestIndexes.get(manifest);
  if (existing !== undefined) return existing;
  const categories = new Map<string, PluginMarketplaceCategory>();
  const collections = new Map<string, MarketplaceCollectionMembership[]>();
  const resolvedCollections: PluginMarketplaceCollection[] = [];
  if (manifest.schemaVersion === 2) {
    for (const category of manifest.categories ?? []) {
      categories.set(category.id, category);
    }
    const entryIds = new Set(manifest.plugins.map((entry) => entry.id));
    for (const collection of manifest.collections ?? []) {
      let rank = 0;
      const pluginIds: string[] = [];
      for (const entryId of collection.pluginIds) {
        if (!entryIds.has(entryId)) continue;
        pluginIds.push(entryId);
        const memberships = collections.get(entryId) ?? [];
        memberships.push({ id: collection.id, rank });
        collections.set(entryId, memberships);
        rank += 1;
      }
      resolvedCollections.push({
        id: collection.id,
        displayName: collection.displayName,
        pluginIds,
      });
    }
  }
  const index = { categories, collections, resolvedCollections };
  marketplaceManifestIndexes.set(manifest, index);
  return index;
}

export function curatedMarketplaceManifestUrls(configuredUrl: string): {
  primary: string;
  fallback: string | null;
} {
  const url = new URL(configuredUrl);
  if (url.toString() === CURATED_MARKETPLACE_V1_URL) {
    return {
      primary: CURATED_MARKETPLACE_V2_URL,
      fallback: CURATED_MARKETPLACE_V1_URL,
    };
  }
  if (url.toString() === CURATED_MARKETPLACE_V2_URL) {
    return {
      primary: CURATED_MARKETPLACE_V2_URL,
      fallback: CURATED_MARKETPLACE_V1_URL,
    };
  }
  return { primary: url.toString(), fallback: null };
}

export function parseMarketplaceManifest(
  input: unknown,
  location: string,
  warn?: (message: string) => void,
): MarketplaceManifest {
  return parseMarketplaceManifestWithBundledPolicy(
    input,
    location,
    false,
    warn,
  );
}

export function parseBundledMarketplaceManifest(
  input: unknown,
  location: string,
): MarketplaceManifestV2 {
  const manifest = parseMarketplaceManifestWithBundledPolicy(
    input,
    location,
    true,
  );
  if (
    manifest.schemaVersion !== 2 ||
    manifest.name !== BUNDLED_MARKETPLACE_NAME
  ) {
    throw new Error(
      `invalid ${location}: the bundled marketplace must be a v2 document named "${BUNDLED_MARKETPLACE_NAME}"`,
    );
  }
  const nonBundled = manifest.plugins.find(
    (entry) => !isBundledMarketplaceEntry(entry),
  );
  if (nonBundled !== undefined) {
    throw new Error(
      `invalid ${location}: entry "${nonBundled.id}" in "${BUNDLED_MARKETPLACE_NAME}" must use a bundled source`,
    );
  }
  return manifest;
}

function parseMarketplaceManifestWithBundledPolicy(
  input: unknown,
  location: string,
  allowBundled: boolean,
  warn?: (message: string) => void,
): MarketplaceManifest {
  if (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    input.schemaVersion !== 1 &&
    input.schemaVersion !== 2
  ) {
    throw new Error(
      `invalid ${location}: unknown schemaVersion ${JSON.stringify(input.schemaVersion)}; supported values are 1 and 2`,
    );
  }
  const schema =
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    input.schemaVersion === 2
      ? marketplaceManifestV2Schema
      : marketplaceManifestV1Schema;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`invalid ${location}: ${formatIssues(parsed.error)}`);
  }
  const bundled = parsed.data.plugins.find(isBundledMarketplaceEntry);
  if (bundled !== undefined && !allowBundled) {
    throw new Error(
      `invalid ${location}: bundled source on entry "${bundled.id}" is reserved for the built-in "${BUNDLED_MARKETPLACE_NAME}" marketplace and is not allowed in fetched or third-party documents`,
    );
  }
  if (parsed.data.schemaVersion === 1) return parsed.data;
  const plugins = parsed.data.plugins.filter((entry) => {
    if ("bundled" in entry.source) return true;
    const range =
      "npm" in entry.source
        ? entry.source.npm.range
        : "range" in entry.source.git
          ? entry.source.git.range
          : undefined;
    if (range === undefined || semver.validRange(range) !== null) return true;
    warn?.(
      `marketplace entry "${entry.id}" was skipped because source range ${JSON.stringify(range)} is not valid semver`,
    );
    return false;
  });
  return plugins.length === parsed.data.plugins.length
    ? parsed.data
    : { ...parsed.data, plugins };
}

export function marketplaceEntryCategory(
  manifest: MarketplaceManifest,
  entry: MarketplaceEntry,
): PluginMarketplaceCategory | undefined {
  if (manifest.schemaVersion !== 2 || !("category" in entry)) return undefined;
  const categoryId = entry.category;
  if (categoryId === undefined) return undefined;
  const declared =
    marketplaceManifestIndex(manifest).categories.get(categoryId);
  if (declared !== undefined) return declared;
  return pluginCatalogCategory(categoryId);
}

export function marketplaceEntryCollections(
  manifest: MarketplaceManifest,
  entryId: string,
): MarketplaceCollectionMembership[] {
  return [
    ...(marketplaceManifestIndex(manifest).collections.get(entryId) ?? []),
  ];
}

export function marketplaceCollections(
  manifest: MarketplaceManifest,
): PluginMarketplaceCollection[] {
  return [...marketplaceManifestIndex(manifest).resolvedCollections];
}

export function parseMarketplaceManifestJson(
  raw: string,
  location: string,
  warn?: (message: string) => void,
): MarketplaceManifest {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid ${location}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return parseMarketplaceManifest(json, location, warn);
}

export function parseBundledMarketplaceManifestJson(
  raw: string,
  location: string,
): MarketplaceManifestV2 {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid ${location}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return parseBundledMarketplaceManifest(json, location);
}

export function entryIconName(entry: MarketplaceEntry): string | null {
  return typeof entry.icon === "string" ? entry.icon : null;
}

export function entryScreenshotUrls(
  entry: MarketplaceEntry,
  base: MarketplaceIconBase,
  warn?: (message: string) => void,
): string[] {
  if (!("screenshots" in entry) || entry.screenshots === undefined) return [];
  return entry.screenshots.flatMap((declared) => {
    const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(declared);
    if (!absolute && base.kind !== "url") {
      warn?.(
        `marketplace entry "${entry.id}" screenshot ${JSON.stringify(declared)} was skipped because relative screenshots require an https marketplace manifest`,
      );
      return [];
    }
    const resolved = new URL(
      declared,
      base.kind === "url" ? base.manifestUrl : "https://marketplace.invalid/",
    );
    if (resolved.protocol !== "https:") {
      throw new Error(
        `screenshot URL ${JSON.stringify(declared)} resolves to a non-https URL`,
      );
    }
    return [resolved.toString()];
  });
}

export function entryOverview(
  entry: MarketplaceEntry,
  warn?: (message: string) => void,
): string | undefined {
  if (!("overview" in entry) || entry.overview === undefined) return undefined;
  const length = [...entry.overview.replace(/\n$/u, "")].length;
  if (length > MARKETPLACE_OVERVIEW_MAX_CHARS) {
    warn?.(
      `marketplace entry "${entry.id}" overview text was skipped because it has ${length} characters; the maximum is ${MARKETPLACE_OVERVIEW_MAX_CHARS}`,
    );
    return undefined;
  }
  return entry.overview;
}

export function entryIconTinted(contentType: string): boolean {
  return contentType === "image/svg+xml";
}

export type MarketplaceIconBase =
  | { kind: "url"; manifestUrl: string }
  | { kind: "dir"; root: string };

export type MarketplaceIconLocation =
  | { kind: "remote"; url: string }
  | { kind: "local"; path: string; relativePath: string };

export function resolveEntryIcon(
  entry: MarketplaceEntry,
  base: MarketplaceIconBase,
): MarketplaceIconLocation | null {
  if (typeof entry.icon === "string") return null;
  const declared = entry.icon.url;
  const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(declared);
  if (base.kind === "url" || absolute) {
    const resolved = new URL(
      declared,
      base.kind === "url" ? base.manifestUrl : "https://marketplace.invalid/",
    );
    if (resolved.protocol !== "https:") {
      throw new Error(
        `icon URL ${JSON.stringify(declared)} resolves to a non-https URL`,
      );
    }
    return { kind: "remote", url: resolved.toString() };
  }
  const resolved = new URL(declared, "https://marketplace.invalid/");
  const relativePath = normalizePluginSubdirectory(
    decodeURIComponent(resolved.pathname).replace(/^\/+/u, ""),
  );
  return {
    kind: "local",
    path: join(base.root, ...relativePath.split("/")),
    relativePath,
  };
}

export function entryRepositoryUrl(entry: MarketplaceEntry): string | null {
  if (isBundledMarketplaceEntry(entry)) return null;
  if ("npm" in entry.source) {
    return entry.source.npm.registry === undefined
      ? `https://www.npmjs.com/package/${entry.source.npm.package}`
      : null;
  }
  if (!("git" in entry.source)) return null;
  const git = entry.source.git;
  const repository = git.url.replace(/\.git$/u, "");
  if (git.subdir === undefined) return repository;
  const path = git.subdir.split("/").map(encodeURIComponent).join("/");
  return new URL(repository).host === "github.com"
    ? `${repository}/tree/HEAD/${path}`
    : repository;
}

export function entrySourceDisplay(entry: MarketplaceEntry): string {
  if (isBundledMarketplaceEntry(entry)) {
    return `builtin:${entry.source.bundled.plugin}`;
  }
  if ("npm" in entry.source) {
    const spec = entry.source.npm.range ?? entry.source.npm.tag ?? "";
    const registry =
      entry.source.npm.registry === undefined
        ? ""
        : ` (registry ${entry.source.npm.registry})`;
    return `npm:${entry.source.npm.package}${spec.length === 0 ? "" : `@${spec}`}${registry}`;
  }
  if (!("git" in entry.source)) {
    return `builtin:${entry.source.bundled.plugin}`;
  }
  const git = entry.source.git;
  const subdir = git.subdir === undefined ? "" : `#${git.subdir}`;
  if ("ref" in git) return `git:${git.url}@${git.ref}${subdir}`;
  const prefix = git.tagPrefix ?? "";
  return `git:${git.url}@${git.range}${subdir} (tags ${gitSemverTagName(prefix, "X.Y.Z")})`;
}

interface ResolvedEntrySource {
  source: string;
  selection: PluginSourceSelection;
  npmRegistry?: string;
}

export function resolvedEntrySource(
  entry: MarketplaceEntry,
): ResolvedEntrySource {
  if (isBundledMarketplaceEntry(entry)) {
    return {
      source: `builtin:${entry.source.bundled.plugin}`,
      selection: ROOT_PLUGIN_SOURCE_SELECTION,
    };
  }
  if ("npm" in entry.source) {
    const spec = entry.source.npm.range ?? entry.source.npm.tag ?? "";
    return {
      source: `npm:${entry.source.npm.package}${spec.length === 0 ? "" : `@${spec}`}`,
      selection: ROOT_PLUGIN_SOURCE_SELECTION,
      ...(entry.source.npm.registry === undefined
        ? {}
        : { npmRegistry: entry.source.npm.registry }),
    };
  }
  if (!("git" in entry.source)) {
    return {
      source: `builtin:${entry.source.bundled.plugin}`,
      selection: ROOT_PLUGIN_SOURCE_SELECTION,
    };
  }
  const git = entry.source.git;
  return {
    source:
      "ref" in git
        ? `git:${git.url}@${git.ref}`
        : gitRangeSourceSpec({
            url: git.url,
            range: git.range,
            tagPrefix: git.tagPrefix ?? "",
          }),
    selection:
      git.subdir === undefined
        ? ROOT_PLUGIN_SOURCE_SELECTION
        : { kind: "subdirectory", path: git.subdir },
  };
}
