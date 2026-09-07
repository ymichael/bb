import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isBbManagedWorkspacePath } from "../threads/worktree-paths.js";
import {
  getInstalledPlugin,
  getInstalledPluginRegistration,
  listUnnormalizedPluginRegistrations,
  normalizeInstalledPluginRegistration,
  setInstalledPluginSourceClassification,
  upsertInstalledPlugin,
  type InstalledPluginRow,
  type LegacyPluginExactResolution,
  type NormalizeLegacyInstalledPluginInput,
  type PluginExactResolution,
  type PluginProvenance,
  type PluginSourceIntent,
} from "@bb/db";
import {
  BUNDLED_PLUGINS,
  builtinPluginSource,
  type BundledPluginRegistration,
} from "./builtin-registry.js";
import {
  BUNDLED_MARKETPLACE_NAME,
  CURATED_MARKETPLACE_NAME,
} from "../plugin-catalog/marketplace-manifest.js";
import type { PluginSourceSelection } from "@bb/server-contract";
import type { TelemetryEvent } from "../system/telemetry.js";
import { resolveSelectedSubdirectory } from "./collection-manifest.js";
import {
  isCommitSha,
  parsePluginSource,
  pluginRootDir,
  realPathInside,
  runInstallCommand,
} from "./install-sources.js";
import { gitRefNameForRow, gitSelectorForRow } from "./git-source-intent.js";
import { readPluginManifest, type PluginManifest } from "./manifest.js";
import { forgetMutableRoot } from "./plugin-runtime.js";
import type {
  InstallRegistrationIdentity,
  RegisterInstalledArgs,
} from "./managed-plugin-artifacts.js";
import type {
  PluginListEntry,
  PluginRuntimeStatus,
  PluginServiceDeps,
} from "./plugin-service-internal.js";
import {
  gitResolvedVersion,
  resolveGitRef,
  type GitRefKind,
  type NpmSourceIntentForResolution,
  type PluginResolvedUpdateVersion,
} from "./update-resolver.js";

export function pluginInstalledTelemetryEvent(
  pluginId: string,
  provenance: PluginProvenance,
  sourceIntent: PluginSourceIntent,
): Extract<TelemetryEvent, { name: "plugin_installed" }> {
  const isPublic =
    provenance.kind === "builtin" ||
    (provenance.kind === "catalog" &&
      (provenance.marketplace === CURATED_MARKETPLACE_NAME ||
        provenance.marketplace === BUNDLED_MARKETPLACE_NAME));
  return {
    name: "plugin_installed",
    properties: {
      plugin_id: isPublic ? pluginId : null,
      provenance: provenance.kind,
      marketplace:
        isPublic && provenance.kind === "catalog"
          ? provenance.marketplace
          : null,
      source_kind: sourceIntent.kind,
    },
  };
}

interface PluginRegistrationContext {
  deps: PluginServiceDeps;
  bundledPlugins: readonly BundledPluginRegistration[];
  withLifecycleLock: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  disposeOne: (id: string) => Promise<void>;
  loadOne: (row: InstalledPluginRow) => Promise<string | null>;
  statuses: ReadonlyMap<
    string,
    { status: PluginRuntimeStatus; detail: string | null }
  >;
  validateInstallDir: (args: RegisterInstalledArgs) => Promise<PluginManifest>;
  checkEngineRange: (manifest: PluginManifest) => string | undefined;
  checkPluginSdkRange: (manifest: PluginManifest) => string | undefined;
  syncCliSkill: () => Promise<void>;
  notifyPluginsChanged: () => void;
  list: () => PluginListEntry[];
}

export function createPluginRegistration(context: PluginRegistrationContext) {
  const {
    deps,
    bundledPlugins,
    withLifecycleLock,
    disposeOne,
    loadOne,
    statuses,
    validateInstallDir,
    checkEngineRange,
    checkPluginSdkRange,
    syncCliSkill,
    notifyPluginsChanged,
    list,
  } = context;
  const logger = deps.logger;

  const bundledPluginNamesById = new Map<string, string>(
    BUNDLED_PLUGINS.map((plugin) => [plugin.pluginId, plugin.name]),
  );

  function refuseBuiltinShadow(pluginId: string): void {
    const bundledName = bundledPluginNamesById.get(pluginId);
    if (bundledName === undefined) return;
    throw new Error(
      `install refused: plugin id "${pluginId}" is reserved by the bundled plugin "${bundledName}"; install "builtin:${bundledName}" instead`,
    );
  }

  function emptyPluginUpdateState() {
    return {
      lastCheckAt: null,
      availableCompatibleVersion: null,
      newestIncompatibleVersion: null,
      statusDetail: null,
    } as const;
  }

  function rowMatchesInstallSource(
    row: InstalledPluginRow,
    provenance: PluginProvenance,
    intent: PluginSourceIntent,
  ): boolean {
    if (row.provenance !== provenance.kind || row.sourceKind !== intent.kind) {
      return false;
    }
    if (
      provenance.kind === "catalog" &&
      (row.catalogEntryId !== provenance.entryId ||
        catalogMarketplaceOf(row) !== provenance.marketplace)
    ) {
      return false;
    }
    if (intent.kind === "path") return row.sourcePath === intent.canonicalPath;
    if (intent.kind === "builtin") {
      return row.sourceBuiltinName === intent.name;
    }
    if (intent.kind === "npm") {
      return (
        row.sourceNpmPackage === intent.packageName &&
        row.sourceNpmRegistry === intent.registry &&
        row.sourceNpmRequestedSpec === intent.requestedSpec &&
        row.sourceNpmSpecKind === intent.specKind
      );
    }
    const selector = gitSelectorForRow(row);
    if (
      row.sourceGitUrl !== intent.url ||
      row.sourceGitSubdirectory !== intent.subdirectory ||
      selector === null
    ) {
      return false;
    }
    if (selector.kind === "ref") {
      return (
        intent.selector.kind === "ref" &&
        selector.ref === intent.selector.ref &&
        selector.refKind === intent.selector.refKind
      );
    }
    return (
      intent.selector.kind === "range" &&
      selector.range === intent.selector.range &&
      selector.tagPrefix === intent.selector.tagPrefix
    );
  }

  function registrationMatchesForActivation(
    current: InstalledPluginRow,
    expected: InstalledPluginRow,
  ): boolean {
    return (
      current.source === expected.source &&
      current.provenance === expected.provenance &&
      current.catalogEntryId === expected.catalogEntryId &&
      current.catalogMarketplaceName === expected.catalogMarketplaceName &&
      current.sourceKind === expected.sourceKind &&
      current.sourcePath === expected.sourcePath &&
      current.sourceBuiltinName === expected.sourceBuiltinName &&
      current.sourceNpmPackage === expected.sourceNpmPackage &&
      current.sourceNpmRegistry === expected.sourceNpmRegistry &&
      current.sourceNpmRequestedSpec === expected.sourceNpmRequestedSpec &&
      current.sourceNpmSpecKind === expected.sourceNpmSpecKind &&
      current.sourceGitUrl === expected.sourceGitUrl &&
      current.sourceGitSubdirectory === expected.sourceGitSubdirectory &&
      current.sourceGitRequestedRef === expected.sourceGitRequestedRef &&
      current.sourceGitRefKind === expected.sourceGitRefKind &&
      current.sourceGitRange === expected.sourceGitRange &&
      current.sourceGitTagPrefix === expected.sourceGitTagPrefix &&
      current.sourceGitResolvedTag === expected.sourceGitResolvedTag &&
      current.npmResolvedVersion === expected.npmResolvedVersion &&
      current.npmIntegrity === expected.npmIntegrity &&
      current.gitResolvedCommit === expected.gitResolvedCommit &&
      current.activeArtifactId === expected.activeArtifactId &&
      current.rootDir === expected.rootDir &&
      current.version === expected.version &&
      current.enabled === expected.enabled
    );
  }

  function sourceFingerprint(row: InstalledPluginRow): string {
    return JSON.stringify({
      source: row.source,
      provenance: row.provenance,
      catalogEntryId: row.catalogEntryId,
      catalogMarketplaceName: row.catalogMarketplaceName,
      sourceKind: row.sourceKind,
      sourcePath: row.sourcePath,
      sourceBuiltinName: row.sourceBuiltinName,
      sourceNpmPackage: row.sourceNpmPackage,
      sourceNpmRegistry: row.sourceNpmRegistry,
      sourceNpmRequestedSpec: row.sourceNpmRequestedSpec,
      sourceNpmSpecKind: row.sourceNpmSpecKind,
      sourceGitUrl: row.sourceGitUrl,
      sourceGitSubdirectory: row.sourceGitSubdirectory,
      sourceGitRequestedRef: row.sourceGitRequestedRef,
      sourceGitRefKind: row.sourceGitRefKind,
      sourceGitRange: row.sourceGitRange,
      sourceGitTagPrefix: row.sourceGitTagPrefix,
      sourceGitResolvedTag: row.sourceGitResolvedTag,
    });
  }

  function pathSourceMoveFrom(
    existing: InstalledPluginRow | undefined,
    identity: InstallRegistrationIdentity,
  ): InstalledPluginRow | undefined {
    if (
      existing === undefined ||
      existing.provenance !== "direct" ||
      existing.sourceKind !== "path" ||
      identity.provenance.kind !== "direct" ||
      identity.sourceIntent.kind !== "path" ||
      existing.sourcePath === identity.sourceIntent.canonicalPath
    ) {
      return undefined;
    }
    return existing;
  }

  function moveStartFailure(pluginId: string): string | null {
    const runtime = statuses.get(pluginId);
    if (runtime === undefined) return "plugin reported no status";
    if (
      runtime.status === "running" ||
      runtime.status === "disabled" ||
      runtime.status === "needs-configuration"
    ) {
      return null;
    }
    return runtime.detail ?? `plugin status is ${runtime.status}`;
  }

  function sameDirectory(a: string, b: string): boolean {
    try {
      return realpathSync(a) === realpathSync(b);
    } catch {
      return a === b;
    }
  }

  function assertInstallRegistrationAvailable(
    existing: InstalledPluginRow | undefined,
    identity: InstallRegistrationIdentity,
    pluginId: string,
  ): void {
    if (existing === undefined) return;
    if (
      !rowMatchesInstallSource(
        existing,
        identity.provenance,
        identity.sourceIntent,
      ) &&
      pathSourceMoveFrom(existing, identity) === undefined
    ) {
      throw new Error(
        `plugin id "${pluginId}" is already installed from ${existing.source}; remove it first`,
      );
    }
    if (
      identity.provenance.kind === "catalog" ||
      identity.sourceIntent.kind === "npm" ||
      identity.sourceIntent.kind === "git"
    ) {
      throw new Error(
        `plugin "${pluginId}" is already installed; use \`bb plugin update ${pluginId}\` or remove it before reinstalling`,
      );
    }
  }

  async function registerInstalled(
    args: RegisterInstalledArgs,
  ): Promise<PluginListEntry> {
    const initialManifest =
      args.preparedManifest ?? (await readPluginManifest(args.rootDir));
    assertInstallRegistrationAvailable(
      getInstalledPlugin(deps.db, initialManifest.id),
      args,
      initialManifest.id,
    );
    if (
      args.provenance.kind !== "builtin" &&
      args.sourceIntent.kind !== "builtin"
    ) {
      refuseBuiltinShadow(initialManifest.id);
    }
    if (args.refuseEngineMismatch) {
      const engineProblem =
        checkEngineRange(initialManifest) ??
        checkPluginSdkRange(initialManifest);
      if (engineProblem !== undefined) {
        throw new Error(
          `install refused: plugin "${initialManifest.id}" ${engineProblem}`,
        );
      }
    }
    const manifest = args.validated
      ? initialManifest
      : await validateInstallDir(args);
    await withLifecycleLock(manifest.id, async () => {
      const existing = getInstalledPlugin(deps.db, manifest.id);
      assertInstallRegistrationAvailable(existing, args, manifest.id);
      const movedFrom = pathSourceMoveFrom(existing, args);
      await disposeOne(manifest.id);
      try {
        await args.beforePersist?.();
        upsertInstalledPlugin(deps.db, {
          id: manifest.id,
          source: args.source,
          provenance: args.provenance,
          sourceIntent: args.sourceIntent,
          exactResolution: args.exactResolution,
          updateState: emptyPluginUpdateState(),
          activeArtifactId: args.activeArtifactId ?? null,
          rootDir: args.rootDir,
          version: manifest.version,
          enabled: movedFrom?.enabled ?? true,
        });
        const row = getInstalledPlugin(deps.db, manifest.id);
        if (row) {
          await loadOne(row);
        }
        if (movedFrom !== undefined) {
          const failure = moveStartFailure(manifest.id);
          if (failure !== null) {
            throw new Error(
              `plugin "${manifest.id}" failed to start from ${args.source}: ${failure}; the install at ${movedFrom.source} was kept`,
            );
          }
        }
      } catch (error) {
        if (movedFrom !== undefined) {
          await disposeOne(manifest.id);
          restoreRegistration(movedFrom);
        }
        const previous = getInstalledPlugin(deps.db, manifest.id);
        if (previous) {
          await loadOne(previous);
        }
        throw error;
      }
      if (movedFrom !== undefined) {
        if (!sameDirectory(movedFrom.rootDir, args.rootDir)) {
          forgetMutableRoot(movedFrom.rootDir);
        }
        logger.info(
          `plugin ${manifest.id} source moved from ${movedFrom.source} to ${args.source}; settings, secrets, and schedules were kept`,
        );
      }
    });
    await syncCliSkill();
    notifyPluginsChanged();
    const entry = list().find((p) => p.id === manifest.id);
    if (!entry) throw new Error(`plugin ${manifest.id} missing after install`);
    deps.telemetry.capture(
      pluginInstalledTelemetryEvent(
        manifest.id,
        args.provenance,
        args.sourceIntent,
      ),
    );
    return entry;
  }

  async function installPathSource(
    path: string,
    selection: PluginSourceSelection,
  ): Promise<PluginListEntry> {
    const checkoutDir = resolve(path);
    const subdirectory = await resolveSelectedSubdirectory({
      checkoutDir,
      selection,
      sourceLabel: checkoutDir,
    });
    const rootDir =
      subdirectory === null
        ? checkoutDir
        : await realPathInside(
            checkoutDir,
            pluginRootDir(checkoutDir, subdirectory),
            "plugin subdirectory",
          );
    if (isBbManagedWorkspacePath({ dataDir: deps.dataDir, path: rootDir })) {
      logger.warn(
        `plugin "${rootDir}" is installed from inside a bb-managed workspace; ` +
          "its source will be deleted when that environment is destroyed (e.g. when the owning thread is archived). " +
          "Reinstall from a stable path outside the managed workspace to avoid losing it.",
      );
    }
    return registerInstalled({
      rootDir,
      source: `path:${rootDir}`,
      provenance: { kind: "direct" },
      sourceIntent: { kind: "path", canonicalPath: rootDir },
      exactResolution: { kind: "path" },
      refuseEngineMismatch: false,
      validated: false,
    });
  }

  function npmIntentForRow(
    row: InstalledPluginRow,
  ): NpmSourceIntentForResolution {
    if (
      row.sourceKind !== "npm" ||
      row.sourceNpmPackage === null ||
      row.sourceNpmRegistry === null ||
      row.sourceNpmRequestedSpec === null
    ) {
      throw new Error(`plugin "${row.id}" has corrupt normalized npm state`);
    }
    let specKind = row.sourceNpmSpecKind;
    if (specKind === null) {
      const parsed = parsePluginSource(
        row.sourceNpmRequestedSpec.length === 0
          ? `npm:${row.sourceNpmPackage}`
          : `npm:${row.sourceNpmPackage}@${row.sourceNpmRequestedSpec}`,
      );
      if (parsed.kind !== "npm") {
        throw new Error(`plugin "${row.id}" has corrupt normalized npm state`);
      }
      specKind = parsed.specKind;
      if (
        !setInstalledPluginSourceClassification(deps.db, row.id, {
          kind: "npm",
          specKind,
        })
      ) {
        throw new Error(`plugin "${row.id}" disappeared during normalization`);
      }
    }
    return {
      packageName: row.sourceNpmPackage,
      registry: row.sourceNpmRegistry,
      requestedSpec: row.sourceNpmRequestedSpec,
      specKind,
    };
  }

  function installedUpdateVersion(
    row: InstalledPluginRow,
  ): PluginResolvedUpdateVersion {
    if (row.sourceKind === "npm") {
      if (row.sourceNpmPackage === null || row.npmResolvedVersion === null) {
        throw new Error(`plugin "${row.id}" has corrupt normalized npm state`);
      }
      return {
        version: row.npmResolvedVersion,
        display: `${row.sourceNpmPackage}@${row.npmResolvedVersion}`,
      };
    }
    if (row.sourceKind === "git") {
      const ref = gitRefNameForRow(row);
      if (
        row.sourceGitUrl === null ||
        ref === null ||
        row.gitResolvedCommit === null
      ) {
        throw new Error(`plugin "${row.id}" has corrupt normalized git state`);
      }
      return gitResolvedVersion({
        url: row.sourceGitUrl,
        ref,
        commit: row.gitResolvedCommit,
      });
    }
    return { version: row.version, display: row.source };
  }

  function catalogMarketplaceOf(row: InstalledPluginRow): string {
    return row.catalogMarketplaceName ?? CURATED_MARKETPLACE_NAME;
  }

  function provenanceForRow(row: InstalledPluginRow): PluginProvenance {
    if (row.provenance !== "catalog") return { kind: row.provenance };
    if (row.catalogEntryId === null) {
      throw new Error(`plugin "${row.id}" has corrupt catalog provenance`);
    }
    return {
      kind: "catalog",
      marketplace: catalogMarketplaceOf(row),
      entryId: row.catalogEntryId,
    };
  }

  function sourceIntentForRow(row: InstalledPluginRow): PluginSourceIntent {
    if (row.sourceKind === "path" && row.sourcePath !== null) {
      return { kind: "path", canonicalPath: row.sourcePath };
    }
    if (row.sourceKind === "builtin" && row.sourceBuiltinName !== null) {
      return { kind: "builtin", name: row.sourceBuiltinName };
    }
    if (row.sourceKind === "npm")
      return { kind: "npm", ...npmIntentForRow(row) };
    if (row.sourceKind === "git") {
      const selector = gitSelectorForRow(row);
      if (row.sourceGitUrl !== null && selector !== null) {
        return {
          kind: "git",
          url: row.sourceGitUrl,
          subdirectory: row.sourceGitSubdirectory,
          selector,
        };
      }
    }
    throw new Error(`plugin "${row.id}" has corrupt normalized source intent`);
  }

  function exactResolutionForRow(
    row: InstalledPluginRow,
  ): PluginExactResolution {
    if (row.sourceKind === "path" || row.sourceKind === "builtin") {
      return { kind: row.sourceKind };
    }
    if (
      row.sourceKind === "npm" &&
      row.npmResolvedVersion !== null &&
      row.npmIntegrity !== null
    ) {
      return {
        kind: "npm",
        version: row.npmResolvedVersion,
        integrity: row.npmIntegrity,
      };
    }
    if (row.sourceKind === "git" && row.gitResolvedCommit !== null) {
      return { kind: "git", commit: row.gitResolvedCommit };
    }
    throw new Error(`plugin "${row.id}" has corrupt exact resolution`);
  }

  function restoreRegistration(row: InstalledPluginRow): void {
    upsertInstalledPlugin(deps.db, {
      id: row.id,
      source: row.source,
      provenance: provenanceForRow(row),
      sourceIntent: sourceIntentForRow(row),
      exactResolution: exactResolutionForRow(row),
      updateState: {
        lastCheckAt: row.lastUpdateCheckAt,
        availableCompatibleVersion: row.availableCompatibleVersion,
        newestIncompatibleVersion: row.newestIncompatibleVersion,
        statusDetail: row.updateStatusDetail,
      },
      activeArtifactId: row.activeArtifactId,
      rootDir: row.rootDir,
      version: row.version,
      enabled: row.enabled,
    });
  }

  function findBundledPlugin(
    name: string,
  ): BundledPluginRegistration | undefined {
    return bundledPlugins.find((plugin) => plugin.name === name);
  }

  function bundledPluginProvenance(
    plugin: BundledPluginRegistration,
    existing?: InstalledPluginRow,
  ): PluginProvenance {
    if (
      existing?.provenance === "catalog" &&
      (catalogMarketplaceOf(existing) === CURATED_MARKETPLACE_NAME ||
        catalogMarketplaceOf(existing) === BUNDLED_MARKETPLACE_NAME)
    ) {
      return {
        kind: "catalog",
        marketplace: BUNDLED_MARKETPLACE_NAME,
        entryId: plugin.name,
      };
    }
    return plugin.autoInstall
      ? { kind: "builtin" }
      : {
          kind: "catalog",
          marketplace: BUNDLED_MARKETPLACE_NAME,
          entryId: plugin.name,
        };
  }

  async function installBuiltinSource(
    parsed: Extract<ReturnType<typeof parsePluginSource>, { kind: "builtin" }>,
  ): Promise<PluginListEntry> {
    const bundled = findBundledPlugin(parsed.name);
    if (!bundled) {
      throw new Error(`unknown builtin plugin "${parsed.name}"`);
    }
    return registerInstalled({
      rootDir: bundled.rootDir,
      source: builtinPluginSource(parsed.name),
      provenance: bundledPluginProvenance(bundled),
      sourceIntent: { kind: "builtin", name: parsed.name },
      exactResolution: { kind: "builtin" },
      refuseEngineMismatch: false,
      validated: false,
    });
  }

  async function reconcileBundled(): Promise<void> {
    for (const bundled of bundledPlugins) {
      const source = builtinPluginSource(bundled.name);
      let manifest: PluginManifest;
      try {
        manifest = await readPluginManifest(bundled.rootDir);
      } catch (error) {
        logger.warn(
          `bundled plugin ${bundled.name} is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      const existing = getInstalledPluginRegistration(deps.db, manifest.id);
      const provenance = bundledPluginProvenance(bundled, existing);
      if (existing?.removedAt !== null && existing?.removedAt !== undefined) {
        continue;
      }
      if (!bundled.autoInstall && existing === undefined) {
        continue;
      }
      const sameBundledSource =
        existing?.sourceKind === "builtin" &&
        existing.sourceBuiltinName === bundled.name;
      if (
        existing !== undefined &&
        !sameBundledSource &&
        !rowMatchesInstallSource(existing, provenance, {
          kind: "builtin",
          name: bundled.name,
        })
      ) {
        logger.warn(
          `bundled plugin ${bundled.name} resolved to id "${manifest.id}", but that id is already installed from ${existing.source}; skipping bundled reconciliation`,
        );
        continue;
      }
      if (
        existing === undefined ||
        !rowMatchesInstallSource(existing, provenance, {
          kind: "builtin",
          name: bundled.name,
        }) ||
        existing.version !== manifest.version ||
        existing.rootDir !== bundled.rootDir
      ) {
        upsertInstalledPlugin(deps.db, {
          id: manifest.id,
          source,
          provenance,
          sourceIntent: { kind: "builtin", name: bundled.name },
          exactResolution: { kind: "builtin" },
          updateState: emptyPluginUpdateState(),
          activeArtifactId: null,
          rootDir: bundled.rootDir,
          version: manifest.version,
          enabled: existing?.enabled ?? bundled.defaultEnabled,
        });
      }
    }
  }

  async function backfillNormalizedPluginRegistrations(): Promise<void> {
    for (const row of listUnnormalizedPluginRegistrations(deps.db)) {
      const parsed = parsePluginSource(row.source);
      let sourceIntent: NormalizeLegacyInstalledPluginInput["sourceIntent"];
      let exactResolution: LegacyPluginExactResolution;
      let provenance: PluginProvenance = { kind: "direct" };
      if (parsed.kind === "path") {
        sourceIntent = { kind: "path", canonicalPath: resolve(parsed.path) };
        exactResolution = { kind: "path" };
      } else if (parsed.kind === "builtin") {
        provenance = { kind: "builtin" };
        sourceIntent = { kind: "builtin", name: parsed.name };
        exactResolution = { kind: "builtin" };
      } else if (parsed.kind === "npm") {
        sourceIntent = {
          kind: "npm",
          packageName: parsed.name,
          registry:
            process.env.npm_config_registry ?? "https://registry.npmjs.org",
          requestedSpec: parsed.spec,
          specKind: parsed.specKind,
        };
        exactResolution = {
          kind: "npm",
          version: parsed.specKind === "exact" ? parsed.spec : row.version,
          integrity: null,
        };
      } else {
        const ref =
          parsed.selector.kind === "range" ? parsed.spec : parsed.selector.ref;
        let refKind: GitRefKind | null = isCommitSha(ref) ? "commit" : null;
        try {
          const remote = await resolveGitRef({ url: parsed.url, ref });
          if (remote.outcome === "resolved") refKind = remote.refKind;
        } catch {}
        sourceIntent = {
          kind: "git",
          url: parsed.url,
          subdirectory: null,
          selector: { kind: "ref", ref, refKind },
        };
        let commit: string | null = isCommitSha(ref) ? ref : null;
        try {
          commit = await runInstallCommand("git", [
            "-C",
            row.rootDir,
            "rev-parse",
            "HEAD",
          ]);
        } catch {}
        exactResolution = { kind: "git", commit };
      }
      normalizeInstalledPluginRegistration(deps.db, {
        ...row,
        provenance,
        sourceIntent,
        exactResolution,
        updateState: emptyPluginUpdateState(),
        activeArtifactId: null,
      });
    }
  }

  return {
    assertInstallRegistrationAvailable,
    backfillNormalizedPluginRegistrations,
    emptyPluginUpdateState,
    installBuiltinSource,
    installPathSource,
    installedUpdateVersion,
    npmIntentForRow,
    provenanceForRow,
    reconcileBundled,
    registerInstalled,
    registrationMatchesForActivation,
    refuseBuiltinShadow,
    restoreRegistration,
    sourceFingerprint,
  };
}
