import { z } from "zod";

import { MARKETPLACE_ID_PATTERN } from "./marketplace-model.js";

export const MARKETPLACE_V2_SCHEMA_URL =
  "https://getbb.app/schemas/marketplace-v2.schema.json";

const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HOST_ICON_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/u;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/u;
const NPM_PACKAGE_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const GIT_SUBDIR_PATTERN =
  /^(?![A-Za-z]:)(?!\/)(?!(?:[^/]+\/)*(?:\.|\.\.|\.git)(?:\/|$))[^/\\]+(?:\/[^/\\]+)*$/u;
const HTTPS_URL_PATTERN = /^https:\/\//iu;
const ASSET_BASE_URL = "https://getbb.app/marketplace/v2/marketplace.json";

const httpsUrlSchema = z.string().url().regex(HTTPS_URL_PATTERN);

function assetUrlSchema(extensions: readonly string[]) {
  return z
    .string()
    .min(1)
    .refine((value) => {
      try {
        const url = new URL(value, ASSET_BASE_URL);
        const extension = url.pathname.split(".").at(-1)?.toLocaleLowerCase();
        return (
          url.protocol === "https:" && extensions.includes(extension ?? "")
        );
      } catch {
        return false;
      }
    });
}

const iconUrlSchema = assetUrlSchema(["svg", "png", "webp"]);
const screenshotUrlSchema = assetUrlSchema(["png", "jpg", "jpeg", "webp"]);

const marketplaceIconSchema = z.union([
  z.string().regex(HOST_ICON_PATTERN),
  z.object({ url: iconUrlSchema }),
]);

const marketplaceAuthorSchema = z.object({
  name: z.string().min(1),
  github: z.string().regex(GITHUB_LOGIN_PATTERN).optional(),
  url: httpsUrlSchema.optional(),
});

const marketplaceGitSourceSchema = z.union([
  z.object({
    git: z.object({
      url: httpsUrlSchema,
      subdir: z.string().regex(GIT_SUBDIR_PATTERN).optional(),
      range: z.string().min(1),
      tagPrefix: z.string().min(1).max(128).optional(),
    }),
  }),
  z.object({
    git: z.object({
      url: httpsUrlSchema,
      subdir: z.string().regex(GIT_SUBDIR_PATTERN).optional(),
      ref: z.string().min(1),
    }),
  }),
]);

const marketplaceNpmSourceSchema = z.object({
  npm: z
    .object({
      package: z.string().regex(NPM_PACKAGE_PATTERN),
      range: z.string().min(1).optional(),
      tag: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9._-]*$/u)
        .optional(),
      registry: httpsUrlSchema.optional(),
    })
    .refine((value) => value.range === undefined || value.tag === undefined),
});

export const marketplaceV2EntrySchema = z.object({
  id: z.string().regex(MARKETPLACE_ID_PATTERN),
  displayName: z.string().min(1),
  description: z.string().min(1),
  icon: marketplaceIconSchema,
  tags: z
    .array(z.string().max(32).regex(TAG_PATTERN))
    .transform((tags) => tags.slice(0, 10))
    .default([]),
  author: marketplaceAuthorSchema,
  source: z.union([marketplaceGitSourceSchema, marketplaceNpmSourceSchema]),
  category: z.string().regex(MARKETPLACE_ID_PATTERN).optional(),
  screenshots: z
    .array(screenshotUrlSchema)
    .transform((screenshots) => screenshots.slice(0, 6))
    .default([]),
  overview: z.string().min(1).optional(),
  publishedAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
});

const marketplaceCategorySchema = z.object({
  id: z.string().regex(MARKETPLACE_ID_PATTERN),
  displayName: z.string().min(1),
  description: z.string().min(1).optional(),
});

const marketplaceCollectionSchema = z.object({
  id: z.string().regex(MARKETPLACE_ID_PATTERN),
  displayName: z.string().min(1),
  pluginIds: z
    .array(z.string().regex(MARKETPLACE_ID_PATTERN))
    .superRefine((pluginIds, context) => {
      const seen = new Set<string>();
      pluginIds.forEach((pluginId, index) => {
        if (seen.has(pluginId)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: `duplicate plugin id ${JSON.stringify(pluginId)}`,
          });
        }
        seen.add(pluginId);
      });
    }),
});

function reportDuplicateIds(
  values: readonly { id: string }[],
  context: z.RefinementCtx,
  path: string,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value.id)) {
      context.addIssue({
        code: "custom",
        path: [path, index, "id"],
        message: `duplicate id ${JSON.stringify(value.id)}`,
      });
    }
    seen.add(value.id);
  });
}

export const marketplaceV2ManifestSchema = z
  .object({
    $schema: z.literal(MARKETPLACE_V2_SCHEMA_URL).optional(),
    schemaVersion: z.literal(2),
    name: z.string().regex(MARKETPLACE_ID_PATTERN),
    displayName: z.string().min(1),
    description: z.string().min(1).optional(),
    categories: z.array(marketplaceCategorySchema).default([]),
    collections: z.array(marketplaceCollectionSchema).default([]),
    plugins: z.array(marketplaceV2EntrySchema).max(256),
  })
  .superRefine((manifest, context) => {
    reportDuplicateIds(manifest.categories, context, "categories");
    reportDuplicateIds(manifest.collections, context, "collections");
    reportDuplicateIds(manifest.plugins, context, "plugins");
  });

export type MarketplaceCategory = z.infer<typeof marketplaceCategorySchema>;
export type MarketplaceV2Entry = z.infer<typeof marketplaceV2EntrySchema>;
export type MarketplaceV2Manifest = z.infer<typeof marketplaceV2ManifestSchema>;

export function parseMarketplaceV2Manifest(
  input: unknown,
): MarketplaceV2Manifest {
  const parsed = marketplaceV2ManifestSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const path =
          issue.path.length === 0 ? "manifest" : issue.path.join(".");
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    throw new Error(`Invalid marketplace v2 manifest: ${issues}`);
  }
  return parsed.data;
}
