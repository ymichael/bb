import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PLUGIN_CATALOG_CATEGORIES as BUILTIN_DISCOVERY_CATEGORIES } from "@bb/domain";
import {
  deletePluginMarketplace,
  getInstalledPlugin,
  getPluginMarketplace,
  getPluginMarketplaceIcon,
  listInstalledPlugins,
  listInstalledPluginsFromMarketplace,
  listPluginMarketplaces,
  recordPluginMarketplaceRefreshFailure,
  replacePluginMarketplaceIcons,
  setInstalledPluginDirectProvenance,
  upsertPluginMarketplace,
  type DbConnection,
  type PluginMarketplaceRow,
} from "@bb/db";
import type {
  InstalledPlugin,
  PluginCatalogAuthor,
  PluginCatalogCollection,
  PluginCatalogCollectionMembership,
  PluginCatalogInstallPlan,
  PluginCatalogResolvedSource,
  PluginCatalogSearchResult,
  PluginCatalogStatus,
  PluginMarketplace,
  PluginMarketplaceRefreshResult,
} from "@bb/server-contract";
import {
  builtinPluginSource,
  listBundledPluginRegistrations,
  type BundledPluginRegistration,
} from "../plugins/builtin-registry.js";
import {
  readPluginManifest,
  type PluginManifest,
} from "../plugins/manifest.js";
import type { PluginService } from "../plugins/plugin-service.js";
import {
  evaluateCompatibility,
  listGitSemverTags,
  resolveGitRef,
  selectGitSemverTag,
} from "../plugins/update-resolver.js";
import { fetchMarketplaceIcons } from "./marketplace-icons.js";
import {
  fetchMarketplaceStats,
  installCountsFromStatsJson,
} from "./marketplace-stats.js";
import {
  marketplaceErrorMessage,
  publicMarketplaceFetch,
  type MarketplaceFetch,
} from "./marketplace-http.js";
import {
  BUNDLED_MARKETPLACE_NAME,
  entryIconName,
  entryIconTinted,
  entryRepositoryUrl,
  entryOverview,
  entryScreenshotUrls,
  entrySourceDisplay,
  curatedMarketplaceManifestUrls,
  CURATED_MARKETPLACE_NAME,
  isBundledMarketplaceEntry,
  marketplaceEntryCategory,
  marketplaceCollections,
  parseMarketplaceManifestJson,
  parseBundledMarketplaceManifestJson,
  resolvedEntrySource,
  type MarketplaceEntry,
  type MarketplaceManifest,
} from "./marketplace-manifest.js";
import { legacyMarketplaceCategory } from "./legacy-marketplace-category.js";
import {
  marketplaceSourceColumns,
  marketplaceSourceDisplay,
  marketplaceSourceFromRow,
  materializeMarketplace,
  parseMarketplaceSource,
} from "./marketplace-source.js";
import { BUNDLED_CURATED_MARKETPLACE } from "./curated-marketplace.js";
import { loadBundledMarketplace } from "./bundled-marketplace.js";
import { marketplacePublisherLabel } from "./marketplace-publishers.js";

const MARKETPLACE_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1_000;

const BUNDLED_ICON_CONTENT_TYPE = "image/svg+xml";

interface PluginCatalogIcon {
  bytes: Buffer;
  contentType: string;
  hash: string;
}

export interface PluginCatalogEntrySelector {
  entryId: string;
  marketplace?: string;
}

interface PluginCatalogInstallInput extends PluginCatalogEntrySelector {
  confirmedSource?: PluginCatalogResolvedSource;
}

export interface PluginCatalogService {
  status(): PluginCatalogStatus;
  refresh(attemptedAt?: number): Promise<void>;
  refreshMarketplaces(args?: {
    name?: string;
    attemptedAt?: number;
  }): Promise<PluginMarketplaceRefreshResult[]>;
  search(query: string): Promise<PluginCatalogSearchResult[]>;
  collections(): PluginCatalogCollection[];
  installPlan(
    selector: PluginCatalogEntrySelector,
  ): Promise<PluginCatalogInstallPlan>;
  install(input: PluginCatalogInstallInput): Promise<InstalledPlugin>;
  icon(
    marketplace: string,
    entryId: string,
  ): Promise<PluginCatalogIcon | undefined>;
  listMarketplaces(): PluginMarketplace[];
  addMarketplace(source: string): Promise<PluginMarketplace>;
  removeMarketplace(name: string): Promise<{ convertedPluginIds: string[] }>;
  startPeriodicRefresh(): void;
  stopPeriodicRefresh(): void;
}

type ResolvedCatalogEntry = {
  row: PluginMarketplaceRow;
  entry: MarketplaceEntry;
};

interface ReservedCollectionIndex {
  catalogsByMarketplace: ReadonlyMap<string, MarketplaceManifest>;
  collections: readonly PluginCatalogCollection[];
  membershipsByEntry: ReadonlyMap<
    string,
    readonly PluginCatalogCollectionMembership[]
  >;
}

export function createPluginCatalogService(deps: {
  db: DbConnection;
  appVersion: string;
  marketplaceUrl: string;
  dataDir: string;
  plugins: Pick<
    PluginService,
    "installOfficialPlugin" | "installCatalogPlugin" | "resolveCatalogNpmSource"
  >;
  bundledPlugins?: readonly BundledPluginRegistration[];
  fetch?: MarketplaceFetch;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
  notifyCatalogChanged?: () => void;
  warn?: (message: string) => void;
}): PluginCatalogService {
  const bundledPlugins =
    deps.bundledPlugins ?? listBundledPluginRegistrations();
  const curatedManifestUrls = curatedMarketplaceManifestUrls(
    deps.marketplaceUrl,
  );
  const categoryOrder = new Map<string, number>(
    BUILTIN_DISCOVERY_CATEGORIES.map((category, index) => [
      category.displayName,
      index,
    ]),
  );
  const now = deps.now ?? Date.now;
  const fetchMarketplace = deps.fetch ?? publicMarketplaceFetch;
  const schedule =
    deps.schedule ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    });
  const stagingDir = join(deps.dataDir, "marketplaces", "staging");
  let stagingReady: Promise<void> | null = null;

  function prepareMarketplaceStaging(): Promise<void> {
    if (stagingReady === null) {
      stagingReady = rm(stagingDir, { recursive: true, force: true }).then(
        async () => {
          await mkdir(stagingDir, { recursive: true });
        },
      );
    }
    return stagingReady;
  }

  seedBundledMarketplace(now());
  seedCuratedMarketplace();
  let reservedCollections = buildReservedCollectionIndex();

  const locks = new Map<string, Promise<unknown>>();
  const ADD_LOCK_KEY = "\0add";
  let cancelPeriodic: (() => void) | null = null;
  let periodicStopped = true;

  function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, tail);
    return result.finally(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
  }

  function seedBundledMarketplace(refreshedAt: number): void {
    const bundled = loadBundledMarketplace(bundledPlugins);
    upsertPluginMarketplace(deps.db, {
      name: BUNDLED_MARKETPLACE_NAME,
      sourceKind: "path",
      manifestUrl: bundled.directory,
      sourceGitRef: null,
      sourceGitCommit: null,
      manifestJson: bundled.manifestJson,
      statsJson: null,
      etag: null,
      lastModified: null,
      lastSuccessfulRefreshAt: refreshedAt,
      lastAttemptedRefreshAt: refreshedAt,
      lastError: null,
    });
  }

  function seedCuratedMarketplace(): void {
    const existing = getPluginMarketplace(deps.db, CURATED_MARKETPLACE_NAME);
    const isCurrentSource =
      existing?.sourceKind === "https" &&
      existing.manifestUrl === curatedManifestUrls.primary;
    const isFallbackSource =
      existing?.sourceKind === "https" &&
      curatedManifestUrls.fallback !== null &&
      existing.manifestUrl === curatedManifestUrls.fallback;
    if (existing !== undefined && (isCurrentSource || isFallbackSource)) {
      try {
        parseMarketplaceManifestJson(
          existing.manifestJson,
          "stored marketplace catalog",
          deps.warn,
        );
        if (isFallbackSource) {
          upsertPluginMarketplace(deps.db, {
            name: CURATED_MARKETPLACE_NAME,
            sourceKind: "https",
            manifestUrl: curatedManifestUrls.primary,
            sourceGitRef: null,
            sourceGitCommit: null,
            manifestJson: existing.manifestJson,
            statsJson: existing.statsJson,
            etag: null,
            lastModified: null,
            lastSuccessfulRefreshAt: existing.lastSuccessfulRefreshAt,
            lastAttemptedRefreshAt: existing.lastAttemptedRefreshAt,
            lastError: existing.lastError,
          });
        }
        return;
      } catch (error) {
        deps.warn?.(
          `stored ${CURATED_MARKETPLACE_NAME} catalog was rejected; using the bundled snapshot: ${marketplaceErrorMessage(error)}`,
        );
      }
    }
    upsertPluginMarketplace(deps.db, {
      name: CURATED_MARKETPLACE_NAME,
      sourceKind: "https",
      manifestUrl: curatedManifestUrls.primary,
      sourceGitRef: null,
      sourceGitCommit: null,
      manifestJson: JSON.stringify(BUNDLED_CURATED_MARKETPLACE),
      statsJson: existing?.statsJson ?? null,
      etag: null,
      lastModified: null,
      lastSuccessfulRefreshAt: null,
      lastAttemptedRefreshAt: existing?.lastAttemptedRefreshAt ?? null,
      lastError: null,
    });
  }

  function requireRow(name: string): PluginMarketplaceRow {
    const row = getPluginMarketplace(deps.db, name);
    if (row === undefined) throw new Error(`unknown marketplace "${name}"`);
    return row;
  }

  function catalogOf(row: PluginMarketplaceRow): MarketplaceManifest | null {
    try {
      const location = `stored "${row.name}" marketplace catalog`;
      return row.name === BUNDLED_MARKETPLACE_NAME
        ? parseBundledMarketplaceManifestJson(row.manifestJson, location)
        : parseMarketplaceManifestJson(row.manifestJson, location, deps.warn);
    } catch (error) {
      deps.warn?.(marketplaceErrorMessage(error));
      return null;
    }
  }

  function orderedMarketplaces(): PluginMarketplaceRow[] {
    return listPluginMarketplaces(deps.db).sort((left, right) => {
      const rankDifference =
        marketplaceRank(left.name) - marketplaceRank(right.name);
      return rankDifference || left.name.localeCompare(right.name);
    });
  }

  function marketplaceView(row: PluginMarketplaceRow): PluginMarketplace {
    const catalog = catalogOf(row);
    return {
      name: row.name,
      displayName: catalog?.displayName ?? row.name,
      description: catalog?.description ?? null,
      official: isReservedMarketplace(row.name),
      sourceKind: row.sourceKind,
      source: marketplaceSourceDisplay(marketplaceSourceFromRow(row)),
      resolvedCommit: row.sourceGitCommit,
      entryCount: catalog?.plugins.length ?? 0,
      lastRefreshAt: row.lastSuccessfulRefreshAt,
      lastAttemptAt: row.lastAttemptedRefreshAt,
      lastError: row.lastError,
    };
  }

  function buildReservedCollectionIndex(
    overrides: ReadonlyMap<string, MarketplaceManifest> = new Map(),
  ): ReservedCollectionIndex {
    const catalogsByMarketplace = new Map<string, MarketplaceManifest>();
    const collectionsByKey = new Map<string, PluginCatalogCollection>();
    const membershipsByEntry = new Map<
      string,
      PluginCatalogCollectionMembership[]
    >();
    const marketplacesByExposedId = new Map<string, string>();
    for (const row of orderedMarketplaces()) {
      if (!isReservedMarketplace(row.name)) continue;
      const catalog = overrides.get(row.name) ?? catalogOf(row);
      if (catalog === null) continue;
      catalogsByMarketplace.set(row.name, catalog);
      for (const collection of marketplaceCollections(catalog)) {
        const existingMarketplace = marketplacesByExposedId.get(collection.id);
        if (existingMarketplace !== undefined) {
          throw new Error(
            `duplicate reserved marketplace collection id "${collection.id}" in "${existingMarketplace}" and "${row.name}"`,
          );
        }
        marketplacesByExposedId.set(collection.id, row.name);
        const collectionKey = catalogEntryKey(row.name, collection.id);
        collectionsByKey.set(collectionKey, collection);
        collection.pluginIds.forEach((pluginId, rank) => {
          const entryKey = catalogEntryKey(row.name, pluginId);
          const memberships = membershipsByEntry.get(entryKey) ?? [];
          memberships.push({ id: collection.id, rank });
          membershipsByEntry.set(entryKey, memberships);
        });
      }
    }
    return {
      catalogsByMarketplace,
      collections: [...collectionsByKey.values()],
      membershipsByEntry,
    };
  }

  function compatibilityProblem(ranges: {
    bbRange: string | undefined;
    sdkRange: string | undefined;
  }): string | null {
    const compatibility = evaluateCompatibility({
      bbRange: ranges.bbRange,
      sdkRange: ranges.sdkRange,
      appVersion: deps.appVersion,
    });
    return compatibility.effective.length === 0
      ? null
      : compatibility.effective.map((problem) => problem.message).join("; ");
  }

  function entryManifest(
    entry: BundledPluginRegistration,
  ): Promise<PluginManifest | null> {
    return readPluginManifest(entry.rootDir).catch((error: unknown) => {
      deps.warn?.(
        `official plugin ${entry.name} is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    });
  }

  async function bundledIcon(
    manifest: PluginManifest,
  ): Promise<{ bytes: Buffer; hash: string } | null> {
    const path = manifest.branding.compactIconPath;
    if (path === undefined) return null;
    try {
      const bytes = await readFile(path);
      return {
        bytes,
        hash: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
      };
    } catch (error: unknown) {
      deps.warn?.(
        `bundled plugin ${manifest.id} icon is unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  function entryIconAssetUrl(
    marketplace: string,
    entryId: string,
    contentHash: string,
  ): string {
    return `/api/v1/plugin-catalog/icons/${encodeURIComponent(marketplace)}/${encodeURIComponent(entryId)}?h=${contentHash}`;
  }

  function entryIconAsset(
    marketplace: string,
    entryId: string,
  ): { iconUrl: string | null; iconTinted: boolean } {
    const icon = getPluginMarketplaceIcon(deps.db, marketplace, entryId);
    return icon === undefined
      ? { iconUrl: null, iconTinted: false }
      : {
          iconUrl: entryIconAssetUrl(marketplace, entryId, icon.contentHash),
          iconTinted: entryIconTinted(icon.contentType),
        };
  }

  async function catalogSearchResult(args: {
    entry: MarketplaceEntry;
    row: PluginMarketplaceRow;
    catalog: MarketplaceManifest;
    installedEntryIds: ReadonlySet<string>;
    installs: number | null;
    collections: readonly PluginCatalogCollectionMembership[];
  }): Promise<PluginCatalogSearchResult | null> {
    const { entry, row, catalog } = args;
    const official = isReservedMarketplace(row.name);
    const bundled = bundledRegistration(entry);
    const manifest =
      bundled === undefined ? null : await entryManifest(bundled);
    if (bundled !== undefined && manifest === null) return null;
    const pluginId = bundled?.pluginId ?? entry.id;
    const entryId = bundled?.name ?? entry.id;
    const bundledIconAsset =
      manifest === null ? null : await bundledIcon(manifest);
    const iconAsset =
      bundled === undefined
        ? entryIconAsset(row.name, entry.id)
        : bundledIconAsset === null
          ? { iconUrl: null, iconTinted: false }
          : {
              iconUrl: entryIconAssetUrl(
                row.name,
                entryId,
                bundledIconAsset.hash,
              ),
              iconTinted: true,
            };
    const compatibility =
      manifest === null
        ? null
        : compatibilityProblem({
            bbRange: manifest.bbEngineRange,
            sdkRange: manifest.bbPluginSdkRange,
          });
    const category = marketplaceEntryCategory(catalog, entry);
    const screenshots = entryScreenshotUrls(
      entry,
      row.sourceKind === "https"
        ? { kind: "url", manifestUrl: row.manifestUrl }
        : { kind: "dir", root: row.manifestUrl },
    );
    const overview = entryOverview(entry, deps.warn);
    return {
      entryId,
      pluginId,
      displayName: manifest?.name ?? entry.displayName,
      description: manifest?.description ?? entry.description,
      icon: manifest?.branding.icon ?? entryIconName(entry),
      ...iconAsset,
      ...(catalog.schemaVersion === 1
        ? {
            category: legacyMarketplaceCategory(entry.tags ?? []),
          }
        : category === undefined
          ? {}
          : { categoryId: category.id, category: category.displayName }),
      screenshots,
      ...(overview === undefined ? {} : { overview }),
      collections: [...args.collections],
      ...("publishedAt" in entry && typeof entry.publishedAt === "string"
        ? { publishedAt: entry.publishedAt }
        : {}),
      ...("updatedAt" in entry && typeof entry.updatedAt === "string"
        ? { updatedAt: entry.updatedAt }
        : {}),
      source: entrySourceDisplay(entry),
      repositoryUrl: entryRepositoryUrl(entry),
      marketplace: row.name,
      marketplaceDisplayName: catalog.displayName,
      publisherKey: row.name,
      publisherLabel: marketplacePublisherLabel({
        marketplaceName: row.name,
        displayName: catalog.displayName,
      }),
      official,
      author: entryAuthor(entry),
      installed:
        args.installedEntryIds.has(catalogEntryKey(row.name, entryId)) ||
        getInstalledPlugin(deps.db, pluginId) !== undefined,
      installs: args.installs,
      compatible: compatibility === null,
      incompatibleReason: compatibility,
    };
  }

  function bundledRegistration(
    entry: MarketplaceEntry,
  ): BundledPluginRegistration | undefined {
    if (!isBundledMarketplaceEntry(entry)) return undefined;
    return bundledPlugins.find(
      (plugin) => plugin.name === entry.source.bundled.plugin,
    );
  }

  function rejectBundledIdCollisions(catalog: MarketplaceManifest): {
    catalog: MarketplaceManifest;
    error: string | null;
  } {
    const bundledIds = new Set(bundledPlugins.map((plugin) => plugin.pluginId));
    const colliding = catalog.plugins.filter((entry) =>
      bundledIds.has(entry.id),
    );
    if (colliding.length === 0) return { catalog, error: null };
    const ids = colliding.map((entry) => entry.id).join(", ");
    const filteredCatalog = structuredClone(catalog);
    for (const collidingEntry of colliding) {
      const index = filteredCatalog.plugins.findIndex(
        (entry) => entry.id === collidingEntry.id,
      );
      if (index >= 0) filteredCatalog.plugins.splice(index, 1);
    }
    return {
      catalog: filteredCatalog,
      error: `dropped ${colliding.length} catalog ${colliding.length === 1 ? "entry" : "entries"} whose id matches a bundled plugin: ${ids}`,
    };
  }

  async function refreshedStatsJson(
    row: PluginMarketplaceRow,
  ): Promise<string | null> {
    if (row.name !== CURATED_MARKETPLACE_NAME || row.sourceKind !== "https") {
      return null;
    }
    try {
      const stats = await fetchMarketplaceStats({
        manifestUrl: curatedManifestUrls.fallback ?? row.manifestUrl,
        fetch: fetchMarketplace,
      });
      return stats === null ? null : JSON.stringify(stats);
    } catch (error) {
      deps.warn?.(
        `${row.name} install counts were not refreshed: ${marketplaceErrorMessage(error)}`,
      );
      return row.statsJson;
    }
  }

  async function performRefresh(
    row: PluginMarketplaceRow,
    attemptedAt: number,
  ): Promise<void> {
    if (row.name === BUNDLED_MARKETPLACE_NAME) {
      seedBundledMarketplace(attemptedAt);
      reservedCollections = buildReservedCollectionIndex();
      deps.notifyCatalogChanged?.();
      return;
    }
    let collisionError: string | null = null;
    const source = marketplaceSourceFromRow(row);
    if (source.kind === "git") await prepareMarketplaceStaging();
    const materialized = await materializeMarketplace({
      source,
      cached: {
        manifestJson: row.manifestJson,
        etag: row.etag,
        lastModified: row.lastModified,
      },
      stagingDir,
      fetch: fetchMarketplace,
      ...(deps.warn === undefined ? {} : { warn: deps.warn }),
      ...(row.name === CURATED_MARKETPLACE_NAME &&
      row.sourceKind === "https" &&
      curatedManifestUrls.fallback !== null
        ? { fallbackManifestUrl: curatedManifestUrls.fallback }
        : {}),
    });
    try {
      if (materialized.catalog.name !== row.name) {
        throw new Error(
          `invalid marketplace manifest: expected name "${row.name}", got ${JSON.stringify(materialized.catalog.name)}`,
        );
      }
      const rejection = rejectBundledIdCollisions(materialized.catalog);
      const catalog = rejection.catalog;
      const nextReservedCollections = isReservedMarketplace(row.name)
        ? buildReservedCollectionIndex(new Map([[row.name, catalog]]))
        : null;
      collisionError = rejection.error;
      if (collisionError !== null) {
        deps.warn?.(`marketplace ${row.name} refresh ${collisionError}`);
      }
      const manifestJson =
        collisionError === null
          ? materialized.manifestJson
          : JSON.stringify(catalog);
      const icons = await fetchMarketplaceIcons({
        db: deps.db,
        marketplaceName: row.name,
        base: materialized.iconBase,
        entries: catalog.plugins,
        onlyMissing: materialized.unchanged,
        fetch: fetchMarketplace,
        ...(deps.warn === undefined ? {} : { warn: deps.warn }),
      });
      const statsJson = await refreshedStatsJson(row);
      deps.db.transaction((tx) => {
        upsertPluginMarketplace(tx, {
          name: row.name,
          ...marketplaceSourceColumns(source),
          sourceGitCommit: materialized.commit,
          manifestJson,
          statsJson,
          etag: materialized.etag,
          lastModified: materialized.lastModified,
          lastSuccessfulRefreshAt: attemptedAt,
          lastAttemptedRefreshAt: attemptedAt,
          lastError: collisionError,
        });
        replacePluginMarketplaceIcons(tx, row.name, icons);
      });
      if (nextReservedCollections !== null) {
        reservedCollections = nextReservedCollections;
      }
      deps.notifyCatalogChanged?.();
    } finally {
      await materialized.dispose();
    }
  }

  async function refreshOne(
    name: string,
    attemptedAt: number,
  ): Promise<PluginMarketplaceRefreshResult> {
    return withLock(name, async () => {
      const row = requireRow(name);
      try {
        await performRefresh(row, attemptedAt);
        return {
          name,
          ok: true,
          error: null,
          marketplace: marketplaceView(requireRow(name)),
        };
      } catch (error) {
        const message = marketplaceErrorMessage(error);
        recordPluginMarketplaceRefreshFailure(
          deps.db,
          name,
          attemptedAt,
          message,
        );
        return {
          name,
          ok: false,
          error: message,
          marketplace: marketplaceView(requireRow(name)),
        };
      }
    });
  }

  async function refreshMarketplaces(args?: {
    name?: string;
    attemptedAt?: number;
  }): Promise<PluginMarketplaceRefreshResult[]> {
    const attemptedAt = args?.attemptedAt ?? now();
    if (args?.name !== undefined) {
      requireRow(args.name);
      return [await refreshOne(args.name, attemptedAt)];
    }
    const results: PluginMarketplaceRefreshResult[] = [];
    for (const row of orderedMarketplaces()) {
      results.push(await refreshOne(row.name, attemptedAt));
    }
    return results;
  }

  function scheduleNextPeriodicRefresh(): void {
    if (periodicStopped) return;
    cancelPeriodic?.();
    const lastAttempt = requireRow(
      CURATED_MARKETPLACE_NAME,
    ).lastAttemptedRefreshAt;
    const delay =
      lastAttempt === null
        ? 0
        : Math.max(
            0,
            MARKETPLACE_REFRESH_INTERVAL_MS - Math.max(0, now() - lastAttempt),
          );
    cancelPeriodic = schedule(runPeriodicRefresh, delay);
  }

  function runPeriodicRefresh(): void {
    if (periodicStopped) return;
    cancelPeriodic = null;
    void refreshMarketplaces()
      .then((results) => {
        for (const result of results) {
          if (result.ok) continue;
          deps.warn?.(
            `periodic ${result.name} catalog refresh failed: ${result.error ?? "unknown error"}`,
          );
        }
      })
      .catch((error: unknown) => {
        deps.warn?.(
          `periodic catalog refresh failed: ${marketplaceErrorMessage(error)}`,
        );
      })
      .finally(scheduleNextPeriodicRefresh);
  }

  function resolveEntry(
    selector: PluginCatalogEntrySelector,
  ): ResolvedCatalogEntry {
    const { entryId } = selector;
    if (selector.marketplace !== undefined) {
      const row = requireRow(selector.marketplace);
      const entry = catalogOf(row)?.plugins.find((candidate) =>
        entryMatchesSelector(candidate, entryId),
      );
      if (entry !== undefined) return { row, entry };
      throw new Error(
        `unknown marketplace entry "${entryId}@${selector.marketplace}"`,
      );
    }
    const matches: { row: PluginMarketplaceRow; entry: MarketplaceEntry }[] =
      [];
    for (const row of orderedMarketplaces()) {
      const entry = catalogOf(row)?.plugins.find((candidate) =>
        entryMatchesSelector(candidate, entryId),
      );
      if (entry !== undefined) matches.push({ row, entry });
    }
    if (matches.length > 1) {
      const choices = matches
        .map((match) => `${entryId}@${match.row.name}`)
        .join(", ");
      throw new Error(
        `"${entryId}" is listed by several marketplaces; install one of: ${choices}`,
      );
    }
    const only = matches[0];
    if (only !== undefined) return only;
    throw new Error(`unknown plugin catalog entry "${entryId}"`);
  }

  function entryMatchesSelector(
    entry: MarketplaceEntry,
    entryId: string,
  ): boolean {
    return (
      entry.id === entryId ||
      (isBundledMarketplaceEntry(entry) &&
        entry.source.bundled.plugin === entryId)
    );
  }

  async function resolveGitEntrySource(
    git: Extract<MarketplaceEntry["source"], { git: unknown }>["git"],
  ): Promise<PluginCatalogResolvedSource> {
    const base = {
      kind: "git" as const,
      url: git.url,
      ...(git.subdir === undefined ? {} : { subdir: git.subdir }),
    };
    try {
      if ("ref" in git) {
        const resolved = await resolveGitRef({ url: git.url, ref: git.ref });
        return resolved.outcome === "resolved"
          ? { ...base, ref: git.ref, resolvedCommit: resolved.commit }
          : { ...base, ref: git.ref, unresolvedReason: resolved.detail };
      }
      const tagPrefix = git.tagPrefix ?? "";
      const tags = await listGitSemverTags({ url: git.url, tagPrefix });
      const selected = selectGitSemverTag({ tags, range: git.range });
      const ranged = {
        ...base,
        range: git.range,
        ...(git.tagPrefix === undefined ? {} : { tagPrefix: git.tagPrefix }),
      };
      return selected === null
        ? {
            ...ranged,
            unresolvedReason: `no release tag of ${git.url} matches ${git.range}`,
          }
        : {
            ...ranged,
            resolvedTag: selected.tag,
            resolvedCommit: selected.commit,
          };
    } catch (error) {
      return {
        ...base,
        ...("ref" in git
          ? { ref: git.ref }
          : {
              range: git.range,
              ...(git.tagPrefix === undefined
                ? {}
                : { tagPrefix: git.tagPrefix }),
            }),
        unresolvedReason: marketplaceErrorMessage(error),
      };
    }
  }

  async function resolveNpmEntrySource(
    npm: Extract<MarketplaceEntry["source"], { npm: unknown }>["npm"],
  ): Promise<PluginCatalogResolvedSource> {
    const base = {
      kind: "npm" as const,
      package: npm.package,
      ...(npm.range === undefined ? {} : { range: npm.range }),
      ...(npm.tag === undefined ? {} : { tag: npm.tag }),
      ...(npm.registry === undefined ? {} : { registry: npm.registry }),
    };
    try {
      const resolved = await deps.plugins.resolveCatalogNpmSource({
        packageName: npm.package,
        ...(npm.registry === undefined ? {} : { registry: npm.registry }),
        requestedSpec: npm.range ?? npm.tag ?? "",
        specKind:
          npm.range !== undefined
            ? "range"
            : npm.tag !== undefined
              ? "tag"
              : "default",
      });
      if (resolved.outcome === "unavailable") {
        return { ...base, unresolvedReason: resolved.detail };
      }
      return {
        ...base,
        resolvedVersion: resolved.version,
        ...(resolved.integrity.length === 0
          ? {}
          : { resolvedIntegrity: resolved.integrity }),
      };
    } catch (error) {
      return { ...base, unresolvedReason: marketplaceErrorMessage(error) };
    }
  }

  async function resolvedEntrySourceView(
    entry: MarketplaceEntry,
    official: boolean,
  ): Promise<PluginCatalogResolvedSource> {
    if (isBundledMarketplaceEntry(entry)) {
      throw new Error("a bundled marketplace entry has no remote source");
    }
    if ("npm" in entry.source) {
      const npm = entry.source.npm;
      if (official) {
        return {
          kind: "npm",
          package: npm.package,
          ...(npm.range === undefined ? {} : { range: npm.range }),
          ...(npm.tag === undefined ? {} : { tag: npm.tag }),
          ...(npm.registry === undefined ? {} : { registry: npm.registry }),
        };
      }
      return resolveNpmEntrySource(npm);
    }
    if (!("git" in entry.source)) {
      throw new Error("a bundled marketplace entry has no remote source");
    }
    const git = entry.source.git;
    if (official) {
      return {
        kind: "git",
        url: git.url,
        ...(git.subdir === undefined ? {} : { subdir: git.subdir }),
        ...("ref" in git
          ? { ref: git.ref }
          : {
              range: git.range,
              ...(git.tagPrefix === undefined
                ? {}
                : { tagPrefix: git.tagPrefix }),
            }),
      };
    }
    return resolveGitEntrySource(git);
  }

  type ConfirmedEntryBinding =
    | { kind: "git"; commit: string }
    | { kind: "npm"; version: string; integrity: string | undefined };

  async function installMarketplaceEntry(
    row: PluginMarketplaceRow,
    entry: MarketplaceEntry,
    binding?: ConfirmedEntryBinding,
  ): Promise<InstalledPlugin> {
    if (isBundledMarketplaceEntry(entry)) {
      throw new Error("a bundled marketplace entry must install from disk");
    }
    const resolved = resolvedEntrySource(entry);
    return deps.plugins.installCatalogPlugin({
      marketplace: row.name,
      entryId: entry.id,
      pluginId: entry.id,
      source: resolved.source,
      selection: resolved.selection,
      ...(resolved.npmRegistry === undefined
        ? {}
        : { npmRegistry: resolved.npmRegistry }),
      ...(binding?.kind === "git" ? { expectedGitCommit: binding.commit } : {}),
      ...(binding?.kind === "npm"
        ? {
            expectedNpmVersion: binding.version,
            ...(binding.integrity === undefined
              ? {}
              : { expectedNpmIntegrity: binding.integrity }),
          }
        : {}),
    });
  }

  async function confirmedThirdPartySource(args: {
    entry: MarketplaceEntry;
    confirmed: PluginCatalogResolvedSource | undefined;
  }): Promise<ConfirmedEntryBinding> {
    if (args.confirmed === undefined) {
      throw new Error(
        "install refused: confirm the third-party marketplace source first",
      );
    }
    const current = await resolvedEntrySourceView(args.entry, false);
    if (!isDeepStrictEqual(current, args.confirmed)) {
      throw new Error(
        "install refused: the marketplace source changed after confirmation; review it again",
      );
    }
    if (current.kind === "npm") {
      if (current.resolvedVersion === undefined) {
        throw new Error(
          `install refused: the npm source could not be resolved (${current.unresolvedReason ?? "no version"})`,
        );
      }
      return {
        kind: "npm",
        version: current.resolvedVersion,
        integrity: current.resolvedIntegrity,
      };
    }
    if (current.resolvedCommit === undefined) {
      throw new Error(
        `install refused: the git source could not be resolved (${current.unresolvedReason ?? "no commit"})`,
      );
    }
    return { kind: "git", commit: current.resolvedCommit };
  }

  return {
    status() {
      const marketplaceEntryCount = orderedMarketplaces().reduce(
        (total, row) => total + (catalogOf(row)?.plugins.length ?? 0),
        0,
      );
      return {
        pluginCount: marketplaceEntryCount,
        includedPluginCount: bundledPlugins.filter(
          (plugin) => plugin.autoInstall,
        ).length,
        optionalPluginCount:
          marketplaceEntryCount -
          bundledPlugins.filter((plugin) => plugin.autoInstall).length,
      };
    },

    async refresh(attemptedAt = now()) {
      const [result] = await refreshMarketplaces({
        name: CURATED_MARKETPLACE_NAME,
        attemptedAt,
      });
      scheduleNextPeriodicRefresh();
      if (result !== undefined && !result.ok) {
        throw new Error(result.error ?? "marketplace refresh failed");
      }
    },

    refreshMarketplaces,

    async icon(marketplace, entryId) {
      const row = getPluginMarketplaceIcon(deps.db, marketplace, entryId);
      if (row !== undefined) {
        return {
          bytes: row.bytes,
          contentType: row.contentType,
          hash: row.contentHash,
        };
      }
      if (marketplace !== BUNDLED_MARKETPLACE_NAME) return undefined;
      const catalog = catalogOf(requireRow(BUNDLED_MARKETPLACE_NAME));
      const entry = catalog?.plugins.find((candidate) =>
        entryMatchesSelector(candidate, entryId),
      );
      const bundled =
        entry === undefined ? undefined : bundledRegistration(entry);
      if (bundled === undefined) return undefined;
      const manifest = await entryManifest(bundled);
      const icon = manifest === null ? null : await bundledIcon(manifest);
      return icon === null
        ? undefined
        : {
            bytes: icon.bytes,
            contentType: BUNDLED_ICON_CONTENT_TYPE,
            hash: icon.hash,
          };
    },

    listMarketplaces() {
      return orderedMarketplaces().map(marketplaceView);
    },

    collections() {
      return [...reservedCollections.collections];
    },

    async addMarketplace(rawSource) {
      return withLock(ADD_LOCK_KEY, async () => {
        const source = parseMarketplaceSource(rawSource);
        if (source.kind === "git") await prepareMarketplaceStaging();
        const materialized = await materializeMarketplace({
          source,
          cached: null,
          stagingDir,
          fetch: fetchMarketplace,
          ...(deps.warn === undefined ? {} : { warn: deps.warn }),
        });
        try {
          const name = materialized.catalog.name;
          if (isReservedMarketplace(name)) {
            throw new Error(
              `marketplace name "${name}" is reserved for a marketplace that ships with bb`,
            );
          }
          if (getPluginMarketplace(deps.db, name) !== undefined) {
            throw new Error(`marketplace "${name}" is already added`);
          }
          const icons = await fetchMarketplaceIcons({
            db: deps.db,
            marketplaceName: name,
            base: materialized.iconBase,
            entries: materialized.catalog.plugins,
            onlyMissing: false,
            fetch: fetchMarketplace,
            ...(deps.warn === undefined ? {} : { warn: deps.warn }),
          });
          const addedAt = now();
          deps.db.transaction((tx) => {
            upsertPluginMarketplace(tx, {
              name,
              ...marketplaceSourceColumns(source),
              sourceGitCommit: materialized.commit,
              manifestJson: materialized.manifestJson,
              statsJson: null,
              etag: materialized.etag,
              lastModified: materialized.lastModified,
              lastSuccessfulRefreshAt: addedAt,
              lastAttemptedRefreshAt: addedAt,
              lastError: null,
            });
            replacePluginMarketplaceIcons(tx, name, icons);
          });
          deps.notifyCatalogChanged?.();
          return marketplaceView(requireRow(name));
        } finally {
          await materialized.dispose();
        }
      });
    },

    async removeMarketplace(name) {
      return withLock(name, async () => {
        if (isReservedMarketplace(name)) {
          throw new Error(`marketplace "${name}" cannot be removed`);
        }
        requireRow(name);
        const convertedPluginIds = deps.db.transaction((tx) => {
          const converted: string[] = [];
          for (const plugin of listInstalledPluginsFromMarketplace(tx, name)) {
            if (!setInstalledPluginDirectProvenance(tx, plugin.id)) {
              throw new Error(
                `plugin "${plugin.id}" disappeared during marketplace removal`,
              );
            }
            converted.push(plugin.id);
          }
          deletePluginMarketplace(tx, name);
          return converted;
        });
        deps.notifyCatalogChanged?.();
        return { convertedPluginIds };
      });
    },

    async search(rawQuery) {
      const query = rawQuery.trim().toLowerCase();
      const collectionIndex = reservedCollections;
      const curatedRow = getPluginMarketplace(
        deps.db,
        CURATED_MARKETPLACE_NAME,
      );
      const curatedInstalls = installCountsFromStatsJson(
        curatedRow?.statsJson ?? null,
        (message) => deps.warn?.(message),
      );
      const installedEntryIds = new Set(
        listInstalledPlugins(deps.db)
          .filter(
            (
              row,
            ): row is typeof row & {
              catalogEntryId: string;
              catalogMarketplaceName: string;
            } =>
              row.catalogMarketplaceName !== null &&
              row.catalogEntryId !== null,
          )
          .map((row) =>
            catalogEntryKey(row.catalogMarketplaceName, row.catalogEntryId),
          ),
      );
      const catalogEntryPromises = orderedMarketplaces().flatMap(
        (row, index) => {
          const catalog = isReservedMarketplace(row.name)
            ? (collectionIndex.catalogsByMarketplace.get(row.name) ?? null)
            : catalogOf(row);
          if (catalog === null) return [];
          return catalog.plugins.map(async (entry) => {
            const bundled = bundledRegistration(entry);
            const pluginId = bundled?.pluginId ?? entry.id;
            const result = await catalogSearchResult({
              entry,
              row,
              catalog,
              installedEntryIds,
              installs: isReservedMarketplace(row.name)
                ? (curatedInstalls.get(pluginId) ?? null)
                : null,
              collections:
                collectionIndex.membershipsByEntry.get(
                  catalogEntryKey(row.name, entry.id),
                ) ?? [],
            });
            return result === null
              ? null
              : {
                  pluginId,
                  tags: entry.tags ?? [],
                  marketplaceRank: index,
                  result,
                };
          });
        },
      );
      const catalogEntries = (await Promise.all(catalogEntryPromises)).filter(
        (entry) => entry !== null,
      );
      return catalogEntries
        .filter(
          (entry) =>
            query.length === 0 ||
            [
              entry.result.entryId,
              entry.pluginId,
              entry.result.displayName,
              entry.result.description,
              entry.result.category ?? "",
              entry.result.marketplaceDisplayName,
              ...entry.tags,
            ]
              .join("\n")
              .toLowerCase()
              .includes(query),
        )
        .sort((left, right) => {
          const marketplaceDifference =
            left.marketplaceRank - right.marketplaceRank;
          if (marketplaceDifference !== 0) return marketplaceDifference;
          const leftCategory = left.result.category ?? "";
          const rightCategory = right.result.category ?? "";
          const categoryDifference =
            (categoryOrder.get(leftCategory) ?? categoryOrder.size) -
            (categoryOrder.get(rightCategory) ?? categoryOrder.size);
          return (
            categoryDifference ||
            leftCategory.localeCompare(rightCategory) ||
            left.result.displayName.localeCompare(right.result.displayName)
          );
        })
        .map(({ result }) => result);
    },

    async installPlan(selector) {
      const resolved = resolveEntry(selector);
      const bundled = bundledRegistration(resolved.entry);
      if (bundled !== undefined) {
        const manifest = await entryManifest(bundled);
        if (manifest === null) {
          throw new Error(
            `official plugin "${bundled.name}" is unavailable in this build`,
          );
        }
        const problem = compatibilityProblem({
          bbRange: manifest.bbEngineRange,
          sdkRange: manifest.bbPluginSdkRange,
        });
        return {
          kind: "bundled",
          entryId: bundled.name,
          pluginId: bundled.pluginId,
          displayName: manifest.name,
          source: builtinPluginSource(bundled.name),
          compatible: problem === null,
          incompatibleReason: problem,
        };
      }
      const { row, entry } = resolved;
      const official = isReservedMarketplace(row.name);
      return {
        kind: "marketplace",
        entryId: entry.id,
        pluginId: entry.id,
        displayName: entry.displayName,
        marketplace: row.name,
        marketplaceDisplayName: catalogOf(row)?.displayName ?? row.name,
        official,
        author: entryAuthor(entry),
        source: resolvedEntrySource(entry).source,
        resolvedSource: await resolvedEntrySourceView(entry, official),
        compatible: true,
        incompatibleReason: null,
      };
    },

    async install(input) {
      const resolved = resolveEntry(input);
      return withLock(resolved.row.name, async () => {
        const current = resolveEntry({
          ...input,
          marketplace: resolved.row.name,
        });
        const bundled = bundledRegistration(current.entry);
        if (bundled !== undefined) {
          if (input.confirmedSource !== undefined) {
            throw new Error(
              "install refused: confirmedSource applies only to third-party marketplaces",
            );
          }
          const manifest = await entryManifest(bundled);
          if (manifest === null) {
            throw new Error(
              `official plugin "${bundled.name}" is unavailable in this build`,
            );
          }
          const problem = compatibilityProblem({
            bbRange: manifest.bbEngineRange,
            sdkRange: manifest.bbPluginSdkRange,
          });
          if (problem !== null) throw new Error(`install refused: ${problem}`);
          return deps.plugins.installOfficialPlugin(bundled.name);
        }
        const thirdParty = !isReservedMarketplace(current.row.name);
        if (!thirdParty && input.confirmedSource !== undefined) {
          throw new Error(
            "install refused: confirmedSource applies only to third-party marketplaces",
          );
        }
        const binding = thirdParty
          ? await confirmedThirdPartySource({
              entry: current.entry,
              confirmed: input.confirmedSource,
            })
          : undefined;
        return installMarketplaceEntry(current.row, current.entry, binding);
      });
    },

    startPeriodicRefresh() {
      if (!periodicStopped) return;
      periodicStopped = false;
      runPeriodicRefresh();
    },

    stopPeriodicRefresh() {
      periodicStopped = true;
      cancelPeriodic?.();
      cancelPeriodic = null;
    },
  };
}

function catalogEntryKey(marketplace: string, entryId: string): string {
  return `${marketplace}\u0000${entryId}`;
}

function isReservedMarketplace(name: string): boolean {
  return name === BUNDLED_MARKETPLACE_NAME || name === CURATED_MARKETPLACE_NAME;
}

function marketplaceRank(name: string): number {
  if (name === BUNDLED_MARKETPLACE_NAME) return 0;
  if (name === CURATED_MARKETPLACE_NAME) return 1;
  return 2;
}

function entryAuthor(entry: MarketplaceEntry): PluginCatalogAuthor {
  const url =
    entry.author.url ??
    (entry.author.github === undefined
      ? null
      : `https://github.com/${entry.author.github}`);
  return {
    name: entry.author.name,
    github: entry.author.github ?? null,
    url,
  };
}
