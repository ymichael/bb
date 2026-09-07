import { PLUGIN_CATALOG_CATEGORIES, pluginCatalogCategory } from "@bb/domain";
import type { PluginCatalogCollection } from "@bb/server-contract";
import type {
  PluginCatalogSearchEntry,
  PluginCatalogSearchData,
} from "@/hooks/queries/plugin-catalog-queries";

export const UNCATEGORIZED_PLUGIN_CATEGORY_ID = "uncategorized";

export type PluginBrowseSort = "recently-added" | "most-installed";
export type PluginBrowseSortDirection = "asc" | "desc";

export interface PluginBrowseShelf {
  key: string;
  categoryId?: string;
  label: string;
  description?: string;
  entries: PluginCatalogSearchEntry[];
  kind: "collection" | "category" | "uncategorized";
}

function isCategorized(entry: PluginCatalogSearchEntry): boolean {
  return entry.categoryId !== undefined && entry.category !== undefined;
}

function collectionEntries(
  entries: readonly PluginCatalogSearchEntry[],
  collection: PluginCatalogCollection,
): PluginCatalogSearchEntry[] {
  const rankByEntryId = new Map(
    collection.pluginIds.map((entryId, rank) => [entryId, rank]),
  );
  return entries
    .filter(
      (entry) =>
        rankByEntryId.has(entry.entryId) &&
        entry.collections.some((membership) => membership.id === collection.id),
    )
    .sort(
      (left, right) =>
        (rankByEntryId.get(left.entryId) ?? Number.MAX_SAFE_INTEGER) -
        (rankByEntryId.get(right.entryId) ?? Number.MAX_SAFE_INTEGER),
    );
}

export function pluginBrowseShelves({
  entries,
  collections,
}: PluginCatalogSearchData): PluginBrowseShelf[] {
  const shelves: PluginBrowseShelf[] = collections.flatMap((collection) => {
    const shelfEntries = collectionEntries(entries, collection);
    return shelfEntries.length === 0
      ? []
      : [
          {
            key: `collection:${collection.id}`,
            label: collection.displayName,
            entries: shelfEntries,
            kind: "collection" as const,
          },
        ];
  });
  const entriesByCategory = new Map<string, PluginCatalogSearchEntry[]>();
  const categoryLabels = new Map<string, string>();
  const unknownCategoryOrder: string[] = [];
  for (const entry of entries) {
    if (!isCategorized(entry)) continue;
    const categoryId = entry.categoryId;
    const categoryLabel = entry.category;
    if (categoryId === undefined || categoryLabel === undefined) continue;
    const categoryEntries = entriesByCategory.get(categoryId);
    if (categoryEntries === undefined) {
      entriesByCategory.set(categoryId, [entry]);
      categoryLabels.set(categoryId, categoryLabel);
      if (pluginCatalogCategory(categoryId) === undefined) {
        unknownCategoryOrder.push(categoryId);
      }
    } else {
      categoryEntries.push(entry);
    }
  }
  const categoryOrder = [
    ...PLUGIN_CATALOG_CATEGORIES.map((category) => category.id),
    ...unknownCategoryOrder,
  ];
  for (const categoryId of categoryOrder) {
    const shelfEntries = entriesByCategory.get(categoryId);
    if (shelfEntries === undefined || shelfEntries.length === 0) continue;
    const builtInCategory = pluginCatalogCategory(categoryId);
    shelves.push({
      key: `category:${categoryId}`,
      categoryId,
      label:
        builtInCategory?.displayName ??
        categoryLabels.get(categoryId) ??
        categoryId,
      ...(builtInCategory === undefined
        ? {}
        : { description: builtInCategory.description }),
      entries: shelfEntries,
      kind: "category",
    });
  }
  const uncategorizedEntries = entries.filter((entry) => !isCategorized(entry));
  if (uncategorizedEntries.length > 0) {
    shelves.push({
      key: "category:uncategorized",
      categoryId: UNCATEGORIZED_PLUGIN_CATEGORY_ID,
      label: "More plugins",
      entries: uncategorizedEntries,
      kind: "uncategorized",
    });
  }
  return shelves;
}

export function pluginCategoryFilterId(
  entry: PluginCatalogSearchEntry,
): string {
  return isCategorized(entry)
    ? (entry.categoryId ?? UNCATEGORIZED_PLUGIN_CATEGORY_ID)
    : UNCATEGORIZED_PLUGIN_CATEGORY_ID;
}

function compareOptionalNumbers(
  left: number | undefined,
  right: number | undefined,
  direction: PluginBrowseSortDirection,
): number {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  const result = left - right;
  return direction === "asc" ? result : -result;
}

export function sortPluginEntries(
  entries: readonly PluginCatalogSearchEntry[],
  sort: PluginBrowseSort,
  direction: PluginBrowseSortDirection = "desc",
): PluginCatalogSearchEntry[] {
  return [...entries].sort((left, right) => {
    const sortResult =
      sort === "recently-added"
        ? compareOptionalNumbers(
            left.publishedAt === undefined
              ? undefined
              : Date.parse(left.publishedAt),
            right.publishedAt === undefined
              ? undefined
              : Date.parse(right.publishedAt),
            direction,
          )
        : compareOptionalNumbers(
            left.installs ?? undefined,
            right.installs ?? undefined,
            direction,
          );
    if (sortResult !== 0) return sortResult;
    const nameResult = left.displayName.localeCompare(right.displayName);
    return nameResult || left.entryId.localeCompare(right.entryId);
  });
}
