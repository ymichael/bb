import type {
  MarketplaceCategory,
  MarketplaceV2Entry,
  MarketplaceV2Manifest,
} from "./marketplace-v2.js";
import {
  MARKETPLACE_ID_PATTERN,
  marketplaceEntryInstalls,
  type MarketplaceStats,
} from "./marketplace-model.js";

export const UNCATEGORIZED_CATEGORY_ID = "uncategorized";

export type MarketplaceSort = "recently-added" | "most-installed";

export interface MarketplaceIndexState {
  category?: string;
  sort?: MarketplaceSort;
}

export interface MarketplaceShelf {
  id: string;
  label: string;
  description?: string;
  kind: "collection" | "category" | "uncategorized";
  entries: MarketplaceV2Entry[];
}

export interface MarketplaceCategoryOption {
  id: string;
  label: string;
  count: number;
}

export function resolveMarketplaceCategory(
  manifest: MarketplaceV2Manifest,
  entry: MarketplaceV2Entry,
): MarketplaceCategory | undefined {
  if (entry.category === undefined) return undefined;
  return manifest.categories.find((category) => category.id === entry.category);
}

export function marketplaceShelves(
  manifest: MarketplaceV2Manifest,
  entries: readonly MarketplaceV2Entry[] = manifest.plugins,
): MarketplaceShelf[] {
  const visibleById = new Map(entries.map((entry) => [entry.id, entry]));
  const collectionShelves = manifest.collections.flatMap((collection) => {
    const collectionEntries = collection.pluginIds.flatMap((entryId) => {
      const entry = visibleById.get(entryId);
      return entry === undefined ? [] : [entry];
    });
    return collectionEntries.length === 0
      ? []
      : [
          {
            id: collection.id,
            label: collection.displayName,
            kind: "collection" as const,
            entries: collectionEntries,
          },
        ];
  });
  const categoryIds = new Set(
    manifest.categories.map((category) => category.id),
  );
  const categoryShelves = manifest.categories.flatMap((category) => {
    const categoryEntries = entries.filter(
      (entry) => entry.category === category.id,
    );
    return categoryEntries.length === 0
      ? []
      : [
          {
            id: category.id,
            label: category.displayName,
            description: category.description,
            kind: "category" as const,
            entries: categoryEntries,
          },
        ];
  });
  const uncategorizedEntries = entries.filter(
    (entry) => entry.category === undefined || !categoryIds.has(entry.category),
  );
  const uncategorizedShelves: MarketplaceShelf[] =
    uncategorizedEntries.length === 0
      ? []
      : [
          {
            id: UNCATEGORIZED_CATEGORY_ID,
            label: "More plugins",
            kind: "uncategorized",
            entries: uncategorizedEntries,
          },
        ];
  return [...collectionShelves, ...categoryShelves, ...uncategorizedShelves];
}

export function marketplaceCategoryOptions(
  manifest: MarketplaceV2Manifest,
  entries: readonly MarketplaceV2Entry[],
): MarketplaceCategoryOption[] {
  return marketplaceShelves(manifest, entries)
    .filter((shelf) => shelf.kind !== "collection")
    .map((shelf) => ({
      id: shelf.id,
      label: shelf.label,
      count: shelf.entries.length,
    }));
}

export function filterMarketplaceEntries(
  manifest: MarketplaceV2Manifest,
  entries: readonly MarketplaceV2Entry[],
  query: string,
): MarketplaceV2Entry[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return [...entries];
  return entries.filter((entry) => {
    const category = resolveMarketplaceCategory(manifest, entry);
    return [
      entry.displayName,
      entry.description,
      entry.id,
      entry.author.name,
      entry.author.github,
      category?.displayName,
      ...entry.tags,
    ]
      .filter((value) => value !== undefined)
      .some((value) => value.toLocaleLowerCase().includes(normalized));
  });
}

export function filterMarketplaceCategory(
  manifest: MarketplaceV2Manifest,
  entries: readonly MarketplaceV2Entry[],
  category: string | undefined,
): MarketplaceV2Entry[] {
  if (category === undefined) return [...entries];
  return entries.filter((entry) => {
    const resolved = resolveMarketplaceCategory(manifest, entry);
    return (resolved?.id ?? UNCATEGORIZED_CATEGORY_ID) === category;
  });
}

function compareNames(a: MarketplaceV2Entry, b: MarketplaceV2Entry): number {
  return a.displayName.localeCompare(b.displayName, "en", {
    sensitivity: "base",
  });
}

export function sortMarketplaceEntries(
  entries: readonly MarketplaceV2Entry[],
  sort: MarketplaceSort,
  stats: MarketplaceStats | null,
): MarketplaceV2Entry[] {
  return [...entries].sort((a, b) => {
    if (sort === "recently-added") {
      if (a.publishedAt === undefined && b.publishedAt !== undefined) return 1;
      if (a.publishedAt !== undefined && b.publishedAt === undefined) return -1;
      if (a.publishedAt === undefined || b.publishedAt === undefined) {
        return compareNames(a, b);
      }
      const dateOrder = Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
      return dateOrder === 0 ? compareNames(a, b) : dateOrder;
    }
    const aInstalls = marketplaceEntryInstalls(a, stats);
    const bInstalls = marketplaceEntryInstalls(b, stats);
    if (aInstalls === undefined && bInstalls !== undefined) return 1;
    if (aInstalls !== undefined && bInstalls === undefined) return -1;
    const installOrder = (bInstalls ?? 0) - (aInstalls ?? 0);
    return installOrder === 0 ? compareNames(a, b) : installOrder;
  });
}

export function parseMarketplaceCategory(input: unknown): string | undefined {
  const values = Array.isArray(input) ? input : [input];
  return values.find(
    (value): value is string =>
      typeof value === "string" && MARKETPLACE_ID_PATTERN.test(value),
  );
}

export function isMarketplaceSort(value: unknown): value is MarketplaceSort {
  return value === "recently-added" || value === "most-installed";
}

export function marketplaceDetailPath(entryId: string): string {
  return `/marketplace/${encodeURIComponent(entryId)}`;
}

export function marketplaceAuthorPath(github: string): string {
  return `/marketplace/author/${encodeURIComponent(github)}`;
}

export function marketplaceAssetUrl(declared: string): string {
  return new URL(declared, "https://getbb.app/marketplace/v2/marketplace.json")
    .href;
}

export function marketplaceInstallCommand(entryId: string): string {
  return `bb plugin install ${entryId}`;
}

export function marketplaceRepositoryUrl(entry: MarketplaceV2Entry): string {
  if ("npm" in entry.source) {
    if (entry.source.npm.registry === undefined) {
      return `https://www.npmjs.com/package/${entry.source.npm.package}`;
    }
    const registry = entry.source.npm.registry.replace(/\/$/u, "");
    return `${registry}/${entry.source.npm.package}`;
  }
  return entry.source.git.url.replace(/\.git$/u, "");
}

export function marketplaceAuthorEntries(
  manifest: MarketplaceV2Manifest,
  github: string,
): MarketplaceV2Entry[] {
  const normalized = github.toLocaleLowerCase();
  return manifest.plugins.filter(
    (entry) => entry.author.github?.toLocaleLowerCase() === normalized,
  );
}

export function moreFromMarketplaceAuthor(
  manifest: MarketplaceV2Manifest,
  entry: MarketplaceV2Entry,
): MarketplaceV2Entry[] {
  const github = entry.author.github?.toLocaleLowerCase();
  const name = entry.author.name.toLocaleLowerCase();
  return manifest.plugins
    .filter((candidate) => {
      if (candidate.id === entry.id) return false;
      if (github !== undefined) {
        return candidate.author.github?.toLocaleLowerCase() === github;
      }
      return candidate.author.name.toLocaleLowerCase() === name;
    })
    .slice(0, 4);
}

export function moreInMarketplaceCategory(
  manifest: MarketplaceV2Manifest,
  entry: MarketplaceV2Entry,
  stats: MarketplaceStats | null,
): MarketplaceV2Entry[] {
  const categoryId = resolveMarketplaceCategory(manifest, entry)?.id;
  const categoryEntries = manifest.plugins.filter((candidate) => {
    if (candidate.id === entry.id) return false;
    return resolveMarketplaceCategory(manifest, candidate)?.id === categoryId;
  });
  return sortMarketplaceEntries(categoryEntries, "most-installed", stats);
}

export function formatInstalls(value: number | undefined): string | null {
  if (value === undefined) return null;
  return new Intl.NumberFormat("en-US", { notation: "compact" }).format(value);
}

export function formatMarketplaceDate(
  value: string | undefined,
): string | null {
  if (value === undefined) return null;
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}
