import type {
  InstalledPlugin,
  PluginApplyUpdateResult as SdkPluginApplyUpdateResult,
  PluginCatalogAuthor,
  PluginCatalogCollection,
  PluginCatalogCollectionMembership,
  PluginCatalogResolvedSource,
  PluginCatalogSearchResult as SdkPluginCatalogSearchResult,
  PluginMarketplace,
  PluginMarketplaceRefreshResult,
  PluginSourceDetail as SdkPluginSourceDetail,
  PluginUpdateCheckEntry,
} from "@bb/server-contract";
import { useQuery } from "@tanstack/react-query";
import { createPluginsClient } from "./plugin-client";
import { toEpochMs } from "./plugin-settings-queries";
import {
  pluginCatalogInstallPlanQueryKey,
  pluginCatalogSearchQueryKey,
  pluginMarketplacesQueryKey,
  pluginSourceQueryKey,
} from "./query-keys";

type FetchLike = typeof fetch;

interface PluginSourceDetail {
  requested: string;
  resolved: string;
  integrity: string | null;
  registry: string | null;
  engines: { bb: string | null; bbPluginSdk: string | null };
  installedAt: number | null;
  history: { version: string; activatedAt: number | null }[];
}

function toPluginSourceDetail(
  source: SdkPluginSourceDetail,
): PluginSourceDetail {
  return {
    requested: source.requested,
    resolved: source.resolved,
    integrity: source.integrity ?? null,
    registry: source.registry ?? null,
    engines: {
      bb: source.engines.bb ?? null,
      bbPluginSdk: source.engines.bbPluginSdk ?? null,
    },
    installedAt: toEpochMs(source.installedAt),
    history: source.history.map((entry) => ({
      version: entry.version,
      activatedAt: toEpochMs(entry.activatedAt),
    })),
  };
}

async function fetchPluginSource(
  fetchImpl: FetchLike,
  pluginId: string,
): Promise<PluginSourceDetail | null> {
  try {
    return toPluginSourceDetail(
      await createPluginsClient(fetchImpl).getSource({ pluginId }),
    );
  } catch {
    return null;
  }
}

export function usePluginSource(
  pluginId: string,
  options: { enabled: boolean },
) {
  return useQuery({
    queryKey: pluginSourceQueryKey(pluginId),
    queryFn: () => fetchPluginSource(fetch, pluginId),
    enabled: options.enabled,
    staleTime: 30_000,
  });
}

export async function installPlugin(
  fetchImpl: FetchLike,
  source: string,
): Promise<InstalledPlugin> {
  return createPluginsClient(fetchImpl).install({ source });
}

export async function installCatalogPlugin(
  fetchImpl: FetchLike,
  args: {
    entryId: string;
    marketplace?: string;
    confirmedSource?: PluginCatalogResolvedSource;
  },
): Promise<InstalledPlugin> {
  return createPluginsClient(fetchImpl).catalog.install(args);
}

export function useCatalogInstallPlan(
  args: { entryId: string; marketplace?: string } | null,
) {
  const request = args ?? { entryId: "" };
  return useQuery({
    queryKey: pluginCatalogInstallPlanQueryKey(request),
    queryFn: () => createPluginsClient(fetch).catalog.installPlan(request),
    enabled: args !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

async function listPluginMarketplaces(
  fetchImpl: FetchLike,
): Promise<PluginMarketplace[]> {
  return createPluginsClient(fetchImpl).marketplaces.list();
}

export async function addPluginMarketplace(
  fetchImpl: FetchLike,
  source: string,
): Promise<PluginMarketplace> {
  return createPluginsClient(fetchImpl).marketplaces.add({ source });
}

export async function removePluginMarketplace(
  fetchImpl: FetchLike,
  name: string,
): Promise<{ convertedPluginIds: string[] }> {
  return createPluginsClient(fetchImpl).marketplaces.remove({ name });
}

export async function refreshPluginMarketplaces(
  fetchImpl: FetchLike,
  name?: string,
): Promise<PluginMarketplaceRefreshResult[]> {
  return createPluginsClient(fetchImpl).marketplaces.refresh(
    name === undefined ? {} : { name },
  );
}

export function usePluginMarketplaces(options: { enabled: boolean }) {
  return useQuery({
    queryKey: pluginMarketplacesQueryKey(),
    queryFn: () => listPluginMarketplaces(fetch),
    enabled: options.enabled,
    staleTime: 30_000,
  });
}

interface PluginResolvedVersion {
  version: string;
  display: string;
}

type PluginUpdatesOutcome = PluginUpdateCheckEntry["outcome"];

export interface PluginUpdatesEntry {
  id: string;
  outcome: PluginUpdatesOutcome;
  devMode: boolean;
  installed: PluginResolvedVersion;
  candidate: PluginResolvedVersion | null;
  blocked: { version: string; reasons: string[] } | null;
  detail: string | null;
}

function toUpdatesEntry(data: PluginUpdateCheckEntry): PluginUpdatesEntry {
  return {
    id: data.id,
    outcome: data.outcome,
    devMode: data.devMode === true,
    installed: data.installed,
    candidate: data.candidate ?? null,
    blocked: data.blocked ?? null,
    detail: data.detail ?? null,
  };
}

export async function checkPluginUpdates(
  fetchImpl: FetchLike,
  args: { id?: string } = {},
): Promise<PluginUpdatesEntry[]> {
  const results = await createPluginsClient(fetchImpl).checkUpdates(
    args.id === undefined ? {} : { pluginId: args.id },
  );
  return results.map(toUpdatesEntry);
}

export interface PluginUpdateResult {
  applied: boolean;
  outcome: SdkPluginApplyUpdateResult["outcome"];
  from: PluginResolvedVersion;
  to: PluginResolvedVersion | null;
  detail: string | null;
}

export async function applyPluginUpdate(
  fetchImpl: FetchLike,
  pluginId: string,
): Promise<PluginUpdateResult> {
  const result = await createPluginsClient(fetchImpl).applyUpdate({ pluginId });
  return {
    applied: result.applied,
    outcome: result.outcome,
    from: result.from,
    to: result.to ?? null,
    detail: result.detail ?? null,
  };
}

export interface PluginCatalogSearchEntry {
  entryId: string;
  pluginId: string;
  displayName: string;
  description: string;
  icon: string | null;
  iconUrl: string | null;
  iconTinted: boolean;
  categoryId?: string;
  category?: string;
  screenshots: string[];
  overview?: string;
  collections: PluginCatalogCollectionMembership[];
  publishedAt?: string;
  source: string;
  repositoryUrl: string | null;
  marketplace: string;
  marketplaceDisplayName: string;
  publisherKey: string;
  publisherLabel: string;
  official: boolean;
  author: PluginCatalogAuthor | null;
  installed: boolean;
  installs: number | null;
  compatible: boolean;
  incompatibleReason: string | null;
}

function toPluginCatalogSearchEntry(
  data: SdkPluginCatalogSearchResult,
): PluginCatalogSearchEntry {
  return {
    entryId: data.entryId,
    pluginId: data.pluginId,
    displayName: data.displayName,
    description: data.description,
    icon: data.icon,
    iconUrl: data.iconUrl,
    iconTinted: data.iconTinted,
    ...(data.categoryId === undefined ? {} : { categoryId: data.categoryId }),
    ...(data.category === undefined ? {} : { category: data.category }),
    screenshots: data.screenshots,
    ...(data.overview === undefined ? {} : { overview: data.overview }),
    collections: data.collections,
    ...(data.publishedAt === undefined
      ? {}
      : { publishedAt: data.publishedAt }),
    source: data.source,
    repositoryUrl: data.repositoryUrl,
    marketplace: data.marketplace,
    marketplaceDisplayName: data.marketplaceDisplayName,
    publisherKey: data.publisherKey,
    publisherLabel: data.publisherLabel,
    official: data.official,
    author: data.author,
    installed: data.installed,
    installs: data.installs,
    compatible: data.compatible,
    incompatibleReason: data.incompatibleReason ?? null,
  };
}

export interface PluginCatalogSearchData {
  entries: PluginCatalogSearchEntry[];
  collections: PluginCatalogCollection[];
}

export async function searchPluginCatalog(
  fetchImpl: FetchLike,
  query: string,
): Promise<PluginCatalogSearchData> {
  const { results, collections } = await createPluginsClient(
    fetchImpl,
  ).catalog.search({
    query,
  });
  return {
    entries: results.map(toPluginCatalogSearchEntry),
    collections,
  };
}

const PLUGIN_CATALOG_STALE_TIME_MS = 30 * 60_000;

export function usePluginCatalogSearch(
  query: string,
  options: { enabled: boolean },
) {
  return useQuery({
    queryKey: pluginCatalogSearchQueryKey(query),
    queryFn: () => searchPluginCatalog(fetch, query),
    enabled: options.enabled,
    refetchOnWindowFocus: false,
    staleTime: PLUGIN_CATALOG_STALE_TIME_MS,
  });
}
