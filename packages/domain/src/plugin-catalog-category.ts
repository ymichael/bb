import { z } from "zod";

export const PLUGIN_CATALOG_CATEGORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export const pluginCatalogCategoryIdSchema = z
  .string()
  .regex(PLUGIN_CATALOG_CATEGORY_ID_PATTERN);

export const pluginMarketplaceCollectionIdSchema = z
  .string()
  .regex(PLUGIN_CATALOG_CATEGORY_ID_PATTERN);

export const pluginMarketplaceCollectionPluginIdSchema = z
  .string()
  .regex(PLUGIN_CATALOG_CATEGORY_ID_PATTERN);

export const pluginMarketplaceCategorySchema = z.object({
  id: pluginCatalogCategoryIdSchema,
  displayName: z.string().min(1),
  description: z.string().min(1),
});

export const pluginMarketplaceCollectionSchema = z.object({
  id: pluginMarketplaceCollectionIdSchema,
  displayName: z.string().min(1),
  pluginIds: z
    .array(pluginMarketplaceCollectionPluginIdSchema)
    .superRefine((pluginIds, ctx) => {
      const seen = new Set<string>();
      pluginIds.forEach((pluginId, index) => {
        if (seen.has(pluginId)) {
          ctx.addIssue({
            code: "custom",
            path: [index],
            message: `duplicate plugin id "${pluginId}"`,
          });
        }
        seen.add(pluginId);
      });
    }),
});

export const PLUGIN_CATALOG_CATEGORIES = [
  {
    id: "themes-and-appearance",
    displayName: "Themes & Appearance",
    description: "Personalize how bb looks and feels.",
  },
  {
    id: "thread-management",
    displayName: "Thread Management",
    description: "Find, identify, organize, or archive threads.",
  },
  {
    id: "thread-content",
    displayName: "Thread Content",
    description: "Change what people see or do inside an open thread.",
  },
  {
    id: "memory-and-context",
    displayName: "Memory & Context",
    description:
      "Control durable knowledge or standing context available to agents.",
  },
  {
    id: "security",
    displayName: "Security",
    description: "Protect credentials or prevent unsafe code.",
  },
  {
    id: "agents-and-providers",
    displayName: "Agents & Providers",
    description:
      "Add, choose, configure, route, or coordinate who runs a thread.",
  },
  {
    id: "token-usage-and-limits",
    displayName: "Token Usage & Limits",
    description:
      "Understand or control token, context-window, and provider-quota use.",
  },
  {
    id: "notifications",
    displayName: "Notifications",
    description: "Know when work finished, failed, or needs attention.",
  },
  {
    id: "code-and-reviews",
    displayName: "Code & Reviews",
    description:
      "Work with repositories, builds, changes, pull requests, issues, and reviews.",
  },
  {
    id: "file-viewers-and-editors",
    displayName: "File Viewers & Editors",
    description: "Browse, open, preview, or edit files and document vaults.",
  },
  {
    id: "cloud-and-remote",
    displayName: "Cloud & Remote",
    description:
      "Run bb work in cloud environments or access bb from elsewhere.",
  },
  {
    id: "command-line",
    displayName: "Command Line",
    description: "Work with shells and command-line programs inside bb.",
  },
  {
    id: "utilities",
    displayName: "Utilities",
    description: "Inspect or control the computers bb runs on.",
  },
  {
    id: "plugin-development",
    displayName: "Plugin Development",
    description:
      "Understand, inspect, build, or debug bb and its plugin surfaces.",
  },
  {
    id: "tasks-and-workflows",
    displayName: "Tasks & Workflows",
    description: "Plan, track, route, schedule, or automate work.",
  },
] as const;

export type PluginCatalogCategoryId = z.infer<
  typeof pluginCatalogCategoryIdSchema
>;
export type PluginMarketplaceCategory = z.infer<
  typeof pluginMarketplaceCategorySchema
>;
export type PluginMarketplaceCollectionId = z.infer<
  typeof pluginMarketplaceCollectionIdSchema
>;
export type PluginMarketplaceCollectionPluginId = z.infer<
  typeof pluginMarketplaceCollectionPluginIdSchema
>;
export type PluginMarketplaceCollection = z.infer<
  typeof pluginMarketplaceCollectionSchema
>;

const pluginCatalogCategoryById = new Map<
  string,
  (typeof PLUGIN_CATALOG_CATEGORIES)[number]
>(PLUGIN_CATALOG_CATEGORIES.map((category) => [category.id, category]));

export function pluginCatalogCategory(
  categoryId: string,
): (typeof PLUGIN_CATALOG_CATEGORIES)[number] | undefined {
  return pluginCatalogCategoryById.get(categoryId);
}
