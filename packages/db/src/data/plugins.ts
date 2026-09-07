import { and, eq, isNull } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { installedPlugins, pluginArtifacts } from "../schema.js";

export type PluginProvenance =
  | { kind: "builtin" }
  | { kind: "direct" }
  | { kind: "catalog"; marketplace: string; entryId: string };

export type PluginSourceIntent =
  | { kind: "path"; canonicalPath: string }
  | { kind: "builtin"; name: string }
  | {
      kind: "npm";
      packageName: string;
      registry: string;
      requestedSpec: string;
      specKind: "default" | "exact" | "tag" | "range";
    }
  | {
      kind: "git";
      url: string;
      subdirectory: string | null;
      selector: PluginGitSelector;
    };

export type PluginGitSelector =
  | { kind: "ref"; ref: string; refKind: "branch" | "tag" | "commit" }
  | {
      kind: "range";
      range: string;
      tagPrefix: string;
      resolvedTag: string;
    };

export type PluginExactResolution =
  | { kind: "path" | "builtin" }
  | { kind: "npm"; version: string; integrity: string }
  | { kind: "git"; commit: string };

export type LegacyPluginExactResolution =
  | { kind: "path" | "builtin" }
  | { kind: "npm"; version: string; integrity: string | null }
  | { kind: "git"; commit: string | null };

export interface PluginUpdateState {
  lastCheckAt: number | null;
  availableCompatibleVersion: string | null;
  newestIncompatibleVersion: string | null;
  statusDetail: string | null;
}

export interface InstalledPluginRow {
  id: string;
  source: string;
  provenance: "builtin" | "direct" | "catalog";
  catalogEntryId: string | null;
  catalogMarketplaceName: string | null;
  sourceKind: "path" | "builtin" | "npm" | "git";
  sourcePath: string | null;
  sourceBuiltinName: string | null;
  sourceNpmPackage: string | null;
  sourceNpmRegistry: string | null;
  sourceNpmRequestedSpec: string | null;
  sourceNpmSpecKind: "default" | "exact" | "tag" | "range" | null;
  sourceGitUrl: string | null;
  sourceGitSubdirectory: string | null;
  sourceGitRequestedRef: string | null;
  sourceGitRefKind: "branch" | "tag" | "commit" | null;
  sourceGitRange: string | null;
  sourceGitTagPrefix: string | null;
  sourceGitResolvedTag: string | null;
  npmResolvedVersion: string | null;
  npmIntegrity: string | null;
  gitResolvedCommit: string | null;
  lastUpdateCheckAt: number | null;
  availableCompatibleVersion: string | null;
  newestIncompatibleVersion: string | null;
  updateStatusDetail: string | null;
  lastFailureVersion: string | null;
  lastFailureAt: number | null;
  lastFailureDetail: string | null;
  activeArtifactId: string | null;
  normalizationVersion: number;
  rootDir: string;
  version: string;
  enabled: boolean;
  removedAt: number | null;
  installedAt: number;
  updatedAt: number;
}

export interface UpsertInstalledPluginInput {
  id: string;
  source: string;
  provenance: PluginProvenance;
  sourceIntent: PluginSourceIntent;
  exactResolution: PluginExactResolution;
  updateState: PluginUpdateState;
  activeArtifactId: string | null;
  rootDir: string;
  version: string;
  enabled: boolean;
}

export interface LegacyInstalledPluginRegistration {
  id: string;
  source: string;
  rootDir: string;
  version: string;
  enabled: boolean;
}

type NormalizeLegacyPluginSourceIntent =
  | Exclude<PluginSourceIntent, { kind: "git" }>
  | {
      kind: "git";
      url: string;
      subdirectory: string | null;
      selector: {
        kind: "ref";
        ref: string;
        refKind: "branch" | "tag" | "commit" | null;
      };
    };

export type NormalizeLegacyInstalledPluginInput = Omit<
  UpsertInstalledPluginInput,
  "exactResolution" | "sourceIntent"
> & {
  sourceIntent: NormalizeLegacyPluginSourceIntent;
  exactResolution: LegacyPluginExactResolution;
};

function gitSelectorColumns(
  selector:
    | PluginGitSelector
    | Extract<NormalizeLegacyPluginSourceIntent, { kind: "git" }>["selector"]
    | null,
) {
  return {
    sourceGitRequestedRef:
      selector?.kind === "ref" ? selector.ref : (null as string | null),
    sourceGitRefKind:
      selector?.kind === "ref"
        ? selector.refKind
        : (null as "branch" | "tag" | "commit" | null),
    sourceGitRange:
      selector?.kind === "range" ? selector.range : (null as string | null),
    sourceGitTagPrefix:
      selector?.kind === "range" ? selector.tagPrefix : (null as string | null),
    sourceGitResolvedTag:
      selector?.kind === "range"
        ? selector.resolvedTag
        : (null as string | null),
  } as const;
}

function normalizedColumns(
  plugin: UpsertInstalledPluginInput | NormalizeLegacyInstalledPluginInput,
) {
  if (plugin.sourceIntent.kind !== plugin.exactResolution.kind) {
    throw new Error(
      `plugin source intent and exact resolution kinds differ for ${plugin.id}`,
    );
  }
  return {
    provenance: plugin.provenance.kind,
    catalogEntryId:
      plugin.provenance.kind === "catalog" ? plugin.provenance.entryId : null,
    catalogMarketplaceName:
      plugin.provenance.kind === "catalog"
        ? plugin.provenance.marketplace
        : null,
    sourceKind: plugin.sourceIntent.kind,
    sourcePath:
      plugin.sourceIntent.kind === "path"
        ? plugin.sourceIntent.canonicalPath
        : null,
    sourceBuiltinName:
      plugin.sourceIntent.kind === "builtin" ? plugin.sourceIntent.name : null,
    sourceNpmPackage:
      plugin.sourceIntent.kind === "npm"
        ? plugin.sourceIntent.packageName
        : null,
    sourceNpmRegistry:
      plugin.sourceIntent.kind === "npm" ? plugin.sourceIntent.registry : null,
    sourceNpmRequestedSpec:
      plugin.sourceIntent.kind === "npm"
        ? plugin.sourceIntent.requestedSpec
        : null,
    sourceNpmSpecKind:
      plugin.sourceIntent.kind === "npm"
        ? plugin.sourceIntent.specKind
        : null,
    sourceGitUrl:
      plugin.sourceIntent.kind === "git" ? plugin.sourceIntent.url : null,
    sourceGitSubdirectory:
      plugin.sourceIntent.kind === "git"
        ? plugin.sourceIntent.subdirectory
        : null,
    ...gitSelectorColumns(
      plugin.sourceIntent.kind === "git" ? plugin.sourceIntent.selector : null,
    ),
    npmResolvedVersion:
      plugin.exactResolution.kind === "npm"
        ? plugin.exactResolution.version
        : null,
    npmIntegrity:
      plugin.exactResolution.kind === "npm"
        ? plugin.exactResolution.integrity
        : null,
    gitResolvedCommit:
      plugin.exactResolution.kind === "git"
        ? plugin.exactResolution.commit
        : null,
    lastUpdateCheckAt: plugin.updateState.lastCheckAt,
    availableCompatibleVersion: plugin.updateState.availableCompatibleVersion,
    newestIncompatibleVersion: plugin.updateState.newestIncompatibleVersion,
    updateStatusDetail: plugin.updateState.statusDetail,
    lastFailureVersion: null,
    lastFailureAt: null,
    lastFailureDetail: null,
    activeArtifactId: plugin.activeArtifactId,
    normalizationVersion: 1,
  } as const;
}

export function listInstalledPlugins(db: DbConnection): InstalledPluginRow[] {
  return db
    .select({ plugin: installedPlugins, artifactPath: pluginArtifacts.path })
    .from(installedPlugins)
    .leftJoin(
      pluginArtifacts,
      eq(installedPlugins.activeArtifactId, pluginArtifacts.id),
    )
    .where(isNull(installedPlugins.removedAt))
    .all()
    .map(({ plugin, artifactPath }) => ({
      ...plugin,
      rootDir:
        plugin.activeArtifactId !== null && artifactPath !== null
          ? artifactPath
          : plugin.rootDir,
    }));
}

export function getInstalledPlugin(
  db: DbConnection,
  id: string,
): InstalledPluginRow | undefined {
  const result = db
    .select({ plugin: installedPlugins, artifactPath: pluginArtifacts.path })
    .from(installedPlugins)
    .leftJoin(
      pluginArtifacts,
      eq(installedPlugins.activeArtifactId, pluginArtifacts.id),
    )
    .where(and(eq(installedPlugins.id, id), isNull(installedPlugins.removedAt)))
    .get();
  if (result === undefined) return undefined;
  return {
    ...result.plugin,
    rootDir:
      result.plugin.activeArtifactId !== null && result.artifactPath !== null
        ? result.artifactPath
        : result.plugin.rootDir,
  };
}

export function getInstalledPluginRegistration(
  db: DbConnection,
  id: string,
): InstalledPluginRow | undefined {
  return db.select().from(installedPlugins).where(eq(installedPlugins.id, id)).get();
}

export function listUnnormalizedPluginRegistrations(
  db: DbConnection,
): LegacyInstalledPluginRegistration[] {
  return db
    .select({
      id: installedPlugins.id,
      source: installedPlugins.source,
      rootDir: installedPlugins.rootDir,
      version: installedPlugins.version,
      enabled: installedPlugins.enabled,
    })
    .from(installedPlugins)
    .where(eq(installedPlugins.normalizationVersion, 0))
    .all();
}

export function normalizeInstalledPluginRegistration(
  db: DbConnection,
  plugin: NormalizeLegacyInstalledPluginInput,
): boolean {
  const result = db
    .update(installedPlugins)
    .set(normalizedColumns(plugin))
    .where(
      and(
        eq(installedPlugins.id, plugin.id),
        eq(installedPlugins.normalizationVersion, 0),
      ),
    )
    .run();
  return result.changes > 0;
}

export function upsertInstalledPlugin(
  db: DbConnection,
  plugin: UpsertInstalledPluginInput,
): InstalledPluginRow {
  const now = Date.now();
  const normalized = normalizedColumns(plugin);
  db.insert(installedPlugins)
    .values({
      id: plugin.id,
      source: plugin.source,
      rootDir: plugin.rootDir,
      version: plugin.version,
      enabled: plugin.enabled,
      ...normalized,
      removedAt: null,
      installedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: installedPlugins.id,
      set: {
        source: plugin.source,
        rootDir: plugin.rootDir,
        version: plugin.version,
        enabled: plugin.enabled,
        ...normalized,
        removedAt: null,
        updatedAt: now,
      },
    })
    .run();
  const row = getInstalledPlugin(db, plugin.id);
  if (!row) throw new Error(`plugin row missing after upsert: ${plugin.id}`);
  return row;
}

export function listInstalledPluginsFromMarketplace(
  db: DbQueryConnection,
  marketplaceName: string,
): { id: string }[] {
  return db
    .select({ id: installedPlugins.id })
    .from(installedPlugins)
    .where(
      and(
        eq(installedPlugins.provenance, "catalog"),
        eq(installedPlugins.catalogMarketplaceName, marketplaceName),
        isNull(installedPlugins.removedAt),
      ),
    )
    .all();
}

export function setInstalledPluginDirectProvenance(
  db: DbQueryConnection,
  id: string,
): boolean {
  const result = db
    .update(installedPlugins)
    .set({
      provenance: "direct",
      catalogEntryId: null,
      catalogMarketplaceName: null,
      updatedAt: Date.now(),
    })
    .where(and(eq(installedPlugins.id, id), isNull(installedPlugins.removedAt)))
    .run();
  return result.changes > 0;
}

export function setInstalledPluginEnabled(
  db: DbConnection,
  id: string,
  enabled: boolean,
): boolean {
  const result = db
    .update(installedPlugins)
    .set({ enabled, updatedAt: Date.now() })
    .where(eq(installedPlugins.id, id))
    .run();
  return result.changes > 0;
}

export function setInstalledPluginUpdateState(
  db: DbConnection,
  id: string,
  state: PluginUpdateState,
): boolean {
  const result = db
    .update(installedPlugins)
    .set({
      lastUpdateCheckAt: state.lastCheckAt,
      availableCompatibleVersion: state.availableCompatibleVersion,
      newestIncompatibleVersion: state.newestIncompatibleVersion,
      updateStatusDetail: state.statusDetail,
      updatedAt: Date.now(),
    })
    .where(and(eq(installedPlugins.id, id), isNull(installedPlugins.removedAt)))
    .run();
  return result.changes > 0;
}

export function setInstalledPluginLastFailure(
  db: DbConnection,
  id: string,
  failure: {
    version: string;
    detail: string;
    at: number;
  },
): boolean {
  const result = db
    .update(installedPlugins)
    .set({
      lastFailureVersion: failure.version,
      lastFailureAt: failure.at,
      lastFailureDetail: failure.detail,
      updatedAt: failure.at,
    })
    .where(and(eq(installedPlugins.id, id), isNull(installedPlugins.removedAt)))
    .run();
  return result.changes > 0;
}

export function setInstalledPluginSourceClassification(
  db: DbConnection,
  id: string,
  classification:
    | { kind: "npm"; specKind: "default" | "exact" | "tag" | "range" }
    | { kind: "git"; refKind: "branch" | "tag" | "commit" },
): boolean {
  const values =
    classification.kind === "npm"
      ? { sourceNpmSpecKind: classification.specKind }
      : { sourceGitRefKind: classification.refKind };
  const result = db
    .update(installedPlugins)
    .set({ ...values, updatedAt: Date.now() })
    .where(
      and(
        eq(installedPlugins.id, id),
        eq(installedPlugins.sourceKind, classification.kind),
        isNull(installedPlugins.removedAt),
      ),
    )
    .run();
  return result.changes > 0;
}

export function deleteInstalledPlugin(db: DbConnection, id: string): boolean {
  const result = db
    .delete(installedPlugins)
    .where(eq(installedPlugins.id, id))
    .run();
  return result.changes > 0;
}

export function markInstalledPluginRemoved(
  db: DbConnection,
  id: string,
): boolean {
  const now = Date.now();
  const result = db
    .update(installedPlugins)
    .set({ enabled: false, removedAt: now, updatedAt: now })
    .where(eq(installedPlugins.id, id))
    .run();
  return result.changes > 0;
}
