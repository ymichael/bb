import {
  jsonValueSchema,
  pluginCatalogCategoryIdSchema,
  pluginMarketplaceCollectionIdSchema,
  pluginMarketplaceCollectionPluginIdSchema,
  type PluginCatalogCategoryId,
  type PluginMarketplaceCollectionId,
  type PluginMarketplaceCollectionPluginId,
} from "@bb/domain";
import { z } from "zod";

export { pluginCatalogCategoryIdSchema, type PluginCatalogCategoryId };
export {
  pluginMarketplaceCollectionIdSchema,
  pluginMarketplaceCollectionPluginIdSchema,
  type PluginMarketplaceCollectionId,
  type PluginMarketplaceCollectionPluginId,
};

export const pluginRuntimeStatusSchema = z.enum([
  "running",
  "error",
  "incompatible",
  "missing",
  "disabled",
  "degraded",
  "needs-configuration",
]);
export type PluginRuntimeStatus = z.infer<typeof pluginRuntimeStatusSchema>;

export const pluginUpdateOutcomeSchema = z.enum([
  "current",
  "update-available",
  "pinned",
  "incompatible",
  "unavailable",
]);

export const pluginResolvedVersionSchema = z.object({
  version: z.string(),
  display: z.string(),
});
export type PluginResolvedVersion = z.infer<typeof pluginResolvedVersionSchema>;

export const pluginUpdateCheckEntrySchema = z.object({
  id: z.string(),
  outcome: pluginUpdateOutcomeSchema,
  devMode: z.literal(true).optional(),
  installed: pluginResolvedVersionSchema,
  candidate: pluginResolvedVersionSchema.optional(),
  blocked: z
    .object({ version: z.string(), reasons: z.array(z.string()) })
    .optional(),
  detail: z.string().optional(),
});
export type PluginUpdateCheckEntry = z.infer<
  typeof pluginUpdateCheckEntrySchema
>;

export const pluginUpdateCheckRequestSchema = z
  .object({ id: z.string().min(1).optional() })
  .strict();

export const pluginUpdateCheckResponseSchema = z.object({
  results: z.array(pluginUpdateCheckEntrySchema),
});

export const pluginApplyUpdateRequestSchema = z.object({}).strict();

export const pluginApplyUpdateResultSchema = z.object({
  applied: z.boolean(),
  from: pluginResolvedVersionSchema,
  to: pluginResolvedVersionSchema.optional(),
  outcome: z.enum(["current", "updated", "rolled-back"]),
  detail: z.string().optional(),
});
export type PluginApplyUpdateResult = z.infer<
  typeof pluginApplyUpdateResultSchema
>;

export const pluginSourceHistoryEntrySchema = z.object({
  version: z.string(),
  activatedAt: z.number(),
});

export const pluginSourceDetailSchema = z.object({
  requested: z.string(),
  resolved: z.string(),
  subdirectory: z.string().optional(),
  range: z.string().optional(),
  tagPrefix: z.string().optional(),
  resolvedTag: z.string().optional(),
  integrity: z.string().optional(),
  registry: z.string().optional(),
  engines: z.object({
    bb: z.string().optional(),
    bbPluginSdk: z.string().optional(),
  }),
  installedAt: z.number().optional(),
  history: z.array(pluginSourceHistoryEntrySchema),
});
export type PluginSourceDetail = z.infer<typeof pluginSourceDetailSchema>;

export const pluginUpdateStateSchema = z.object({
  outcome: pluginUpdateOutcomeSchema.optional(),
  detail: z.string().optional(),
  availableVersion: z.string().optional(),
  blockedVersion: z.string().optional(),
  blockedReasons: z.array(z.string()).optional(),
  lastCheckAt: z.number().optional(),
  lastFailure: z
    .object({ version: z.string(), at: z.number(), detail: z.string() })
    .optional(),
});
export type PluginUpdateState = z.infer<typeof pluginUpdateStateSchema>;

export const pluginHandlerStatsSchema = z.object({
  count: z.number(),
  totalMs: z.number(),
  maxMs: z.number(),
  errorCount: z.number(),
});
export type PluginHandlerStats = z.infer<typeof pluginHandlerStatsSchema>;

export const pluginServiceEntrySchema = z.object({
  name: z.string(),
  state: z.enum(["running", "backoff", "stopped"]),
});
export const pluginScheduleEntrySchema = z.object({
  name: z.string(),
  cron: z.string(),
  nextRunAt: z.number(),
  lastRunAt: z.number().nullable(),
  lastStatus: z.enum(["running", "ok", "error"]).nullable(),
  lastError: z.string().nullable(),
});

export const pluginAppStateSchema = z.object({
  hasApp: z.boolean(),
  bundle: z
    .object({
      jsUrl: z.string(),
      cssUrl: z.string().nullable(),
      jsBytes: z.number().int().nonnegative(),
      hash: z.string(),
      sdkMajor: z.number(),
      sdkVersion: z.string(),
      compatible: z.boolean(),
    })
    .nullable(),
});

export const pluginCapabilitySchema = z.object({
  kind: z.enum(["skill", "theme", "agent-tool", "thread-integration"]),
  id: z.string(),
  label: z.string(),
  detail: z.string().nullable(),
});
export type PluginCapability = z.infer<typeof pluginCapabilitySchema>;

export const pluginCapabilitySummarySchema = z.array(pluginCapabilitySchema);
export type PluginCapabilitySummary = z.infer<
  typeof pluginCapabilitySummarySchema
>;

export const installedPluginSchema = z.object({
  id: z.string(),
  source: z.string(),
  rootDir: z.string(),
  version: z.string(),
  provenance: z.enum(["builtin", "direct", "catalog"]),
  isOrphanedBuiltin: z.boolean(),
  catalogEntryId: z.string().optional(),
  catalogMarketplaceName: z.string().optional(),
  publisherLabel: z.string().nullable().default(null),
  sourceDisplay: z.string(),
  updateState: pluginUpdateStateSchema,
  enabled: z.boolean(),
  description: z.string().nullable(),
  name: z.string().nullable(),
  categoryId: pluginCatalogCategoryIdSchema.optional(),
  category: z.string().optional(),
  screenshots: z.array(z.string()),
  collections: z.array(
    z.object({
      id: pluginMarketplaceCollectionIdSchema,
      rank: z.number().int().nonnegative(),
    }),
  ),
  publishedAt: z.iso.datetime({ offset: true }).optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
  icon: z.string().nullable(),
  iconUrl: z.string().nullable(),
  status: pluginRuntimeStatusSchema,
  statusDetail: z.string().nullable(),
  handlerStats: pluginHandlerStatsSchema,
  services: z.array(pluginServiceEntrySchema),
  schedules: z.array(pluginScheduleEntrySchema),
  cliCommand: z.object({ name: z.string(), summary: z.string() }).nullable(),
  capabilities: pluginCapabilitySummarySchema.default([]),
  hasSettings: z.boolean(),
  app: pluginAppStateSchema,
  logoUrl: z.string().nullable(),
  logoDarkUrl: z.string().nullable(),
  providerIds: z.array(z.string()),
  /**
   * The plugin's declared icons (`bb.branding.experimental_icons`): declared
   * name → hashed asset URL (`/api/v1/plugins/<id>/assets/icons/<name>.svg?h=…`).
   * A timeline row or provider whose glyph is `"<pluginId>/<name>"` resolves
   * here; a name that is absent (the plugin changed its map, or is gone)
   * renders the per-kind fallback glyph. Identity-backed like `iconUrl`, so a
   * disabled plugin's icons still resolve. Empty for a plugin that declares
   * none; the server fills it for every plugin, with the same response-side
   * tolerance as `providerIds` in @bb/sdk for servers older than the field.
   */
  icons: z.record(z.string(), z.string()),
});
export type InstalledPlugin = z.infer<typeof installedPluginSchema>;

export const pluginListResponseSchema = z.object({
  plugins: z.array(installedPluginSchema),
});
export type PluginListResponse = z.infer<typeof pluginListResponseSchema>;

export const pluginSourceSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }).strict(),
  z
    .object({ kind: z.literal("subdirectory"), path: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("entry"), name: z.string().min(1) }).strict(),
]);
export type PluginSourceSelection = z.infer<typeof pluginSourceSelectionSchema>;

export const ROOT_PLUGIN_SOURCE_SELECTION: PluginSourceSelection = {
  kind: "root",
};

export const pluginInstallSourceRequestSchema = z
  .object({
    source: z.string().min(1),
    selection: pluginSourceSelectionSchema.default(
      ROOT_PLUGIN_SOURCE_SELECTION,
    ),
  })
  .strict();

export const PLUGIN_MARKETPLACE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export const CURATED_PLUGIN_MARKETPLACE_NAME = "bb-community";

export const pluginMarketplaceNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(PLUGIN_MARKETPLACE_NAME_PATTERN);

export const pluginCatalogInstallRequestSchema = z
  .object({
    entryId: z.string().min(1),
    marketplace: pluginMarketplaceNameSchema.optional(),
    confirmedSource: z.lazy(() => pluginCatalogResolvedSourceSchema).optional(),
  })
  .strict();

export const pluginInstallRequestSchema = pluginInstallSourceRequestSchema;

export const pluginMutationResponseSchema = z.object({
  ok: z.literal(true),
  plugin: installedPluginSchema,
});

export const pluginInstallResponseSchema = pluginMutationResponseSchema;

export const pluginReloadResponseSchema = z.object({
  ok: z.literal(true),
  plugins: z.array(installedPluginSchema),
});
export type PluginReloadResponse = z.infer<typeof pluginReloadResponseSchema>;

export const pluginRemoveResponseSchema = z.object({ ok: z.literal(true) });
export type PluginRemoveResponse = z.infer<typeof pluginRemoveResponseSchema>;

const pluginSettingBaseSchema = {
  label: z.string().min(1),
  description: z.string().min(1).optional(),
};

export const pluginSettingDescriptorSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("string"),
      secret: z.literal(true).optional(),
      experimental_multiline: z.boolean().optional(),
      default: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("boolean"),
      default: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("number"),
      default: z.number().finite().optional(),
    })
    .strict(),
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("select"),
      options: z.array(z.string().min(1)).min(1),
      default: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...pluginSettingBaseSchema,
      type: z.literal("project"),
      default: z.string().optional(),
    })
    .strict(),
]);
export type PluginSettingDescriptor = z.infer<
  typeof pluginSettingDescriptorSchema
>;

export const pluginSettingsResponseSchema = z.object({
  ok: z.literal(true),
  schema: z.record(z.string(), pluginSettingDescriptorSchema),
  values: z.record(z.string(), jsonValueSchema),
});
export type PluginSettingsResponse = z.infer<
  typeof pluginSettingsResponseSchema
>;

export const pluginSettingsUpdateRequestSchema = z
  .object({ values: z.record(z.string(), jsonValueSchema) })
  .strict();

export const pluginTokenRequestSchema = z
  .object({ rotate: z.boolean().optional().default(false) })
  .strict();

export const pluginTokenResponseSchema = z.object({
  ok: z.literal(true),
  token: z.string(),
});
export type PluginTokenResponse = z.infer<typeof pluginTokenResponseSchema>;

export const pluginCatalogStatusSchema = z.object({
  pluginCount: z.number(),
  includedPluginCount: z.number(),
  optionalPluginCount: z.number(),
});
export type PluginCatalogStatus = z.infer<typeof pluginCatalogStatusSchema>;

export const pluginCatalogStatusResponseSchema = z.object({
  catalog: pluginCatalogStatusSchema,
});

export const pluginCatalogAuthorSchema = z.object({
  name: z.string(),
  github: z.string().nullable().default(null),
  url: z.string().nullable(),
});
export type PluginCatalogAuthor = z.infer<typeof pluginCatalogAuthorSchema>;

export const pluginCatalogCollectionMembershipSchema = z.object({
  id: pluginMarketplaceCollectionIdSchema,
  rank: z.number().int().nonnegative(),
});
export type PluginCatalogCollectionMembership = z.infer<
  typeof pluginCatalogCollectionMembershipSchema
>;

export const pluginCatalogCollectionSchema = z.object({
  id: pluginMarketplaceCollectionIdSchema,
  displayName: z.string(),
  pluginIds: z.array(pluginMarketplaceCollectionPluginIdSchema),
});
export type PluginCatalogCollection = z.infer<
  typeof pluginCatalogCollectionSchema
>;

export const pluginCatalogSearchResultSchema = z.object({
  entryId: z.string(),
  pluginId: z.string(),
  displayName: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  iconUrl: z.string().nullable(),
  iconTinted: z.boolean().default(false),
  categoryId: pluginCatalogCategoryIdSchema.optional(),
  category: z.string().optional(),
  screenshots: z.array(z.string()).default([]),
  overview: z.string().optional(),
  collections: z.array(pluginCatalogCollectionMembershipSchema).default([]),
  publishedAt: z.iso.datetime({ offset: true }).optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
  source: z.string(),
  repositoryUrl: z.string().nullable().default(null),
  marketplace: z.string(),
  marketplaceDisplayName: z.string(),
  publisherKey: z.string(),
  publisherLabel: z.string(),
  official: z.boolean(),
  author: pluginCatalogAuthorSchema.nullable(),
  installed: z.boolean(),
  installs: z.number().int().nonnegative().nullable().default(null),
  compatible: z.boolean(),
  incompatibleReason: z.string().nullable(),
});
export type PluginCatalogSearchResult = z.infer<
  typeof pluginCatalogSearchResultSchema
>;

export const pluginCatalogSearchResponseSchema = z.object({
  results: z.array(pluginCatalogSearchResultSchema),
  collections: z.array(pluginCatalogCollectionSchema),
});
export type PluginCatalogSearchResponse = z.infer<
  typeof pluginCatalogSearchResponseSchema
>;

export const pluginCatalogResolvedSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("npm"),
      package: z.string(),
      range: z.string().optional(),
      tag: z.string().optional(),
      registry: z.string().optional(),
      resolvedVersion: z.string().optional(),
      resolvedIntegrity: z.string().optional(),
      unresolvedReason: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("git"),
      url: z.string(),
      subdir: z.string().optional(),
      ref: z.string().optional(),
      range: z.string().optional(),
      tagPrefix: z.string().optional(),
      resolvedTag: z.string().optional(),
      resolvedCommit: z.string().optional(),
      unresolvedReason: z.string().optional(),
    })
    .strict(),
]);
export type PluginCatalogResolvedSource = z.infer<
  typeof pluginCatalogResolvedSourceSchema
>;

export const pluginCatalogInstallPlanSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("bundled"),
    entryId: z.string(),
    pluginId: z.string(),
    displayName: z.string(),
    source: z.string(),
    compatible: z.boolean(),
    incompatibleReason: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("marketplace"),
    entryId: z.string(),
    pluginId: z.string(),
    displayName: z.string(),
    marketplace: z.string(),
    marketplaceDisplayName: z.string(),
    official: z.boolean(),
    author: pluginCatalogAuthorSchema,
    source: z.string(),
    resolvedSource: pluginCatalogResolvedSourceSchema,
    compatible: z.boolean(),
    incompatibleReason: z.string().nullable(),
  }),
]);
export type PluginCatalogInstallPlan = z.infer<
  typeof pluginCatalogInstallPlanSchema
>;

export const pluginCatalogInstallPlanResponseSchema = z.object({
  plan: pluginCatalogInstallPlanSchema,
});

export const pluginMarketplaceSourceKindSchema = z.enum([
  "https",
  "git",
  "path",
]);
export type PluginMarketplaceSourceKind = z.infer<
  typeof pluginMarketplaceSourceKindSchema
>;

export const pluginMarketplaceSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  official: z.boolean(),
  sourceKind: pluginMarketplaceSourceKindSchema,
  source: z.string(),
  resolvedCommit: z.string().nullable(),
  entryCount: z.number(),
  lastRefreshAt: z.number().nullable(),
  lastAttemptAt: z.number().nullable(),
  lastError: z.string().nullable(),
});
export type PluginMarketplace = z.infer<typeof pluginMarketplaceSchema>;

export const pluginMarketplaceListResponseSchema = z.object({
  marketplaces: z.array(pluginMarketplaceSchema),
});

export const pluginMarketplaceAddRequestSchema = z
  .object({
    source: z.string().min(1),
  })
  .strict();

export const pluginMarketplaceMutationResponseSchema = z.object({
  ok: z.literal(true),
  marketplace: pluginMarketplaceSchema,
});

export const pluginMarketplaceRemoveResponseSchema = z.object({
  ok: z.literal(true),
  convertedPluginIds: z.array(z.string()),
});

export const pluginMarketplaceRefreshRequestSchema = z
  .object({
    name: pluginMarketplaceNameSchema.optional(),
  })
  .strict();

export const pluginMarketplaceRefreshResultSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
  marketplace: pluginMarketplaceSchema,
});
export type PluginMarketplaceRefreshResult = z.infer<
  typeof pluginMarketplaceRefreshResultSchema
>;

export const pluginMarketplaceRefreshResponseSchema = z.object({
  results: z.array(pluginMarketplaceRefreshResultSchema),
});
