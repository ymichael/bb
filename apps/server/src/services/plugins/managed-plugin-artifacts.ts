import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { derivePluginId } from "@bb/domain";
import {
  createPluginArtifact,
  getInstalledPlugin,
  getPluginArtifactByResolution,
  listPluginArtifactsAtOrUnderPath,
  listPluginArtifactsUnderPath,
  setPluginArtifactGitCheckoutRoot,
  setPluginArtifactValidation,
  type InstalledPluginRow,
  type PluginExactResolution,
  type PluginGitSelector,
  type PluginProvenance,
  type PluginSourceIntent,
} from "@bb/db";
import {
  buildPluginApp,
  buildPluginHost,
  buildPluginServer,
} from "@bb/plugin-build";
import {
  assertPublicMarketplaceUrl,
  boundedResponseJson,
  publicMarketplaceFetch,
  MARKETPLACE_FETCH_TIMEOUT_MS,
  MARKETPLACE_PACKUMENT_MAX_BYTES,
} from "../plugin-catalog/marketplace-http.js";
import { getPluginBuildToolchain } from "./build-toolchain.js";
import { validatePluginArtifactMeta } from "./app-bundle.js";
import type { PluginSourceSelection } from "@bb/server-contract";
import { resolveSelectedSubdirectory } from "./collection-manifest.js";
import {
  gitArtifactCacheDir,
  hashInstallDir,
  nestedPluginRoots,
  npmArtifactCacheDir,
  parsePluginSource,
  pluginRootDir,
  promoteGitPluginArtifact,
  promoteImmutableDir,
  realPathInside,
  runInstallCommand,
} from "./install-sources.js";
import { gitSelectorRefName } from "./git-source-intent.js";
import { readPluginManifest, type PluginManifest } from "./manifest.js";
import type {
  PluginListEntry,
  PluginServiceDeps,
} from "./plugin-service-internal.js";
import {
  createNpmResolverRun,
  evaluateCompatibility,
  resolveGitRange,
  resolveGitRef,
  selectNpmCandidate,
  type CompatibilityProblem,
  type GitCandidateProbeResult,
  type GitSemverTag,
  type NpmResolvedCandidate,
  type NpmSourceIntentForResolution,
  type NpmSpecKind,
} from "./update-resolver.js";

export interface InstallRegistrationIdentity {
  provenance: PluginProvenance;
  sourceIntent: PluginSourceIntent;
}

export interface RegisterInstalledArgs extends InstallRegistrationIdentity {
  rootDir: string;
  source: string;
  exactResolution: PluginExactResolution;
  refuseEngineMismatch: boolean;
  validated: boolean;
  activeArtifactId?: string;
  preparedManifest?: PluginManifest;
  beforePersist?: () => Promise<void>;
}

export interface InstallContext {
  provenance: PluginProvenance;
  expectedPluginId?: string;
  expectedGitCommit?: string;
  npmRegistry?: string;
  expectedNpmVersion?: string;
  expectedNpmIntegrity?: string;
}

interface ActivateManagedUpdateArgs {
  row: InstalledPluginRow;
  rootDir: string;
  manifest: PluginManifest;
  source: string;
  sourceIntent: PluginSourceIntent;
  exactResolution: PluginExactResolution;
  artifactId: string;
  beforePersist?: () => Promise<void>;
}

interface ManagedPluginArtifactsContext {
  deps: PluginServiceDeps;
  withArtifactLock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  sourceKind: (source: string) => "path" | "git" | "npm" | "builtin";
  checkEngineRange: (manifest: PluginManifest) => string | undefined;
  checkPluginSdkRange: (manifest: PluginManifest) => string | undefined;
  isPackagedBuiltinEntry: (args: {
    kind: "path" | "git" | "npm" | "builtin";
    manifest: PluginManifest;
    rootDir: string;
    artifact: "app" | "server" | "host";
  }) => boolean;
  registerInstalled: (args: RegisterInstalledArgs) => Promise<PluginListEntry>;
  assertInstallRegistrationAvailable: (
    existing: InstalledPluginRow | undefined,
    identity: InstallRegistrationIdentity,
    pluginId: string,
  ) => void;
  refuseBuiltinShadow: (pluginId: string) => void;
  activateManagedUpdate: (args: ActivateManagedUpdateArgs) => Promise<void>;
}

async function installGitDependencies(args: {
  rootDir: string;
  manifest: PluginManifest;
}): Promise<void> {
  for (const name of [".npmrc", ".yarnrc", ".yarnrc.yml"]) {
    await rm(join(args.rootDir, name), { force: true });
  }
  await runInstallCommand(
    "npm",
    [
      "install",
      "--prefix",
      args.rootDir,
      "--ignore-scripts",
      "--omit=dev",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
    ],
    {
      notFoundHint: `"npm" was not found on PATH — installing git plugin "${args.manifest.id}" requires npm`,
    },
  );
}

async function installNpmCandidate(args: {
  stagingPrefix: string;
  registry: string;
  packageName: string;
  candidate: NpmResolvedCandidate;
  notFoundHint: string;
}): Promise<void> {
  await runInstallCommand(
    "npm",
    [
      "install",
      "--prefix",
      args.stagingPrefix,
      "--ignore-scripts",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      "--registry",
      args.registry,
      "--",
      `${args.packageName}@${args.candidate.version}`,
    ],
    { notFoundHint: args.notFoundHint },
  );
}

export function createListedRegistryNpmResolverRun(listedRegistry: string) {
  return createNpmResolverRun({
    fetch: (input, init) => {
      assertPublicMarketplaceUrl(listedRegistry);
      return publicMarketplaceFetch(input, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS),
      });
    },
    readJson: (response) =>
      boundedResponseJson(
        response,
        MARKETPLACE_PACKUMENT_MAX_BYTES,
        "npm registry metadata",
      ),
  });
}

export function createManagedPluginArtifacts(
  context: ManagedPluginArtifactsContext,
) {
  const {
    deps,
    withArtifactLock,
    sourceKind,
    checkEngineRange,
    checkPluginSdkRange,
    isPackagedBuiltinEntry,
    registerInstalled,
    assertInstallRegistrationAvailable,
    refuseBuiltinShadow,
    activateManagedUpdate,
  } = context;
  const directInstallContext: InstallContext = {
    provenance: { kind: "direct" },
  };

  function npmResolverRun(listedRegistry: string | undefined) {
    if (listedRegistry === undefined) return createNpmResolverRun();
    assertPublicMarketplaceUrl(listedRegistry);
    return createListedRegistryNpmResolverRun(listedRegistry);
  }

  function assertExpectedPluginId(
    context: InstallContext,
    manifestId: string,
    source: string,
  ): void {
    if (
      context.expectedPluginId !== undefined &&
      context.expectedPluginId !== manifestId
    ) {
      throw new Error(
        `install refused: ${source} declares plugin id "${manifestId}" but the catalog entry expects "${context.expectedPluginId}"`,
      );
    }
  }

  async function validateManifestOnly(args: {
    rootDir: string;
    source: string;
    refuseEngineMismatch: boolean;
  }): Promise<PluginManifest> {
    const manifest = await readPluginManifest(args.rootDir);
    if (args.refuseEngineMismatch) {
      const engineProblem =
        checkEngineRange(manifest) ?? checkPluginSdkRange(manifest);
      if (engineProblem) {
        throw new Error(
          `install refused: plugin "${manifest.id}" ${engineProblem}`,
        );
      }
    }
    return manifest;
  }

  async function validateInstallDir(args: {
    rootDir: string;
    source: string;
    refuseEngineMismatch: boolean;
  }): Promise<PluginManifest> {
    const manifest = await validateManifestOnly(args);
    const kind = sourceKind(args.source);
    const managed = kind === "git" || kind === "npm";
    if (kind === "git") {
      await installGitDependencies({ rootDir: args.rootDir, manifest });
    }
    if (manifest.appEntry !== undefined) {
      if (kind === "npm") {
        const jsPresent = await stat(join(args.rootDir, "dist", "app.js"))
          .then(() => true)
          .catch(() => false);
        if (!jsPresent) {
          throw new Error(
            `install refused: npm plugins with a frontend (bb.app) must publish a prebuilt bundle — "${manifest.id}" is missing dist/app.js + dist/app.meta.json`,
          );
        }
      } else if (
        !isPackagedBuiltinEntry({
          kind,
          manifest,
          rootDir: args.rootDir,
          artifact: "app",
        })
      ) {
        try {
          await buildPluginApp(
            args.rootDir,
            deps.appVersion,
            await getPluginBuildToolchain(deps),
          );
        } catch (error) {
          throw new Error(
            `install failed: frontend bundle build for "${manifest.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    if (kind === "git") {
      try {
        await buildPluginServer(
          args.rootDir,
          deps.appVersion,
          await getPluginBuildToolchain(deps),
        );
      } catch (error) {
        throw new Error(
          `install failed: server bundle build for "${manifest.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (manifest.hostEntry !== undefined) {
        try {
          await buildPluginHost(
            args.rootDir,
            deps.appVersion,
            await getPluginBuildToolchain(deps),
          );
        } catch (error) {
          throw new Error(
            `install failed: host bundle build for "${manifest.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    async function validateArtifact(
      artifact: "server" | "app" | "host",
      required: boolean,
    ): Promise<void> {
      const metaPath = join(args.rootDir, "dist", `${artifact}.meta.json`);
      let raw: string;
      try {
        raw = await readFile(metaPath, "utf8");
      } catch {
        if (required) {
          throw new Error(
            `install refused: ${artifact} artifact for plugin "${manifest.id}" is missing dist/${artifact}.meta.json`,
          );
        }
        return;
      }
      const problem = validatePluginArtifactMeta({
        artifact,
        raw,
        pluginId: manifest.id,
        pluginVersion: manifest.version,
      });
      if (problem !== null) {
        throw new Error(`install refused: ${problem}`);
      }
    }

    if (managed) {
      await validateArtifact("server", kind === "git");
      if (manifest.appEntry !== undefined) {
        await validateArtifact("app", kind === "npm");
      }
      if (manifest.hostEntry !== undefined) {
        await validateArtifact("host", true);
      }
    }
    return manifest;
  }

  async function readNpmIntegrity(
    prefix: string,
    packageName: string,
  ): Promise<string | null> {
    let value: unknown;
    try {
      value = JSON.parse(
        await readFile(join(prefix, "package-lock.json"), "utf8"),
      );
    } catch {
      return null;
    }
    if (typeof value !== "object" || value === null) return null;
    const lock = value as Record<string, unknown>;
    const packages = lock.packages;
    if (typeof packages === "object" && packages !== null) {
      const entry = (packages as Record<string, unknown>)[
        `node_modules/${packageName}`
      ];
      if (typeof entry === "object" && entry !== null && "integrity" in entry) {
        if (typeof entry.integrity === "string") return entry.integrity;
      }
    }
    const dependencies = lock.dependencies;
    if (typeof dependencies !== "object" || dependencies === null) return null;
    const dependency = (dependencies as Record<string, unknown>)[packageName];
    if (
      typeof dependency !== "object" ||
      dependency === null ||
      !("integrity" in dependency)
    ) {
      return null;
    }
    return typeof dependency.integrity === "string"
      ? dependency.integrity
      : null;
  }

  async function resolveNpmRegistry(
    prefix: string,
    packageName: string,
  ): Promise<string> {
    const scope = packageName.startsWith("@")
      ? packageName.slice(0, packageName.indexOf("/"))
      : null;
    const keys =
      scope === null ? ["registry"] : [`${scope}:registry`, "registry"];
    for (const key of keys) {
      const value = await runInstallCommand("npm", [
        "config",
        "get",
        key,
        "--prefix",
        prefix,
      ]);
      if (value.length > 0 && value !== "undefined" && value !== "null") {
        return value;
      }
    }
    throw new Error(`npm did not resolve a registry for ${packageName}`);
  }

  function preservedNestedRoots(root: string): string[] {
    return nestedPluginRoots(
      root,
      listPluginArtifactsUnderPath(deps.db, root, sep).map(
        (artifact) => artifact.path,
      ),
    );
  }

  async function refreshAncestorArtifactHashes(args: {
    checkoutRoot: string;
    changedRoot: string;
    changedArtifactId: string;
  }): Promise<void> {
    const artifacts = listPluginArtifactsAtOrUnderPath(
      deps.db,
      args.checkoutRoot,
      sep,
    );
    for (const artifact of artifacts) {
      if (artifact.id === args.changedArtifactId) continue;
      const pathFromArtifact = relative(artifact.path, args.changedRoot);
      if (
        pathFromArtifact.length === 0 ||
        pathFromArtifact === ".." ||
        pathFromArtifact.startsWith(`..${sep}`)
      ) {
        continue;
      }
      const contentHash = await hashInstallDir(artifact.path);
      if (artifact.validationResult === "pending") {
        if (
          !setPluginArtifactValidation(deps.db, artifact.id, {
            contentHash,
            validationResult: "pending",
            validatedAt: null,
          })
        ) {
          throw new Error(`plugin artifact disappeared: ${artifact.id}`);
        }
      } else {
        if (
          !setPluginArtifactValidation(deps.db, artifact.id, {
            contentHash,
            validationResult: "valid",
            validatedAt: artifact.validatedAt ?? Date.now(),
          })
        ) {
          throw new Error(`plugin artifact disappeared: ${artifact.id}`);
        }
      }
    }
  }

  async function resolveGitSelector(
    parsed: Extract<ReturnType<typeof parsePluginSource>, { kind: "git" }>,
    source: string,
    selection: PluginSourceSelection,
    context: InstallContext,
  ): Promise<{ selector: PluginGitSelector; commit: string }> {
    const { selector } = parsed;
    if (selector.kind !== "range") {
      const literal = await resolveGitRef({
        url: parsed.url,
        ref: selector.ref,
      });
      if (selector.kind === "ref") {
        if (literal.outcome === "unavailable") {
          throw new Error(`install failed: ${literal.detail}`);
        }
        return {
          selector: {
            kind: "ref",
            ref: selector.ref,
            refKind: literal.refKind,
          },
          commit: literal.commit,
        };
      }
      if (literal.outcome === "resolved") {
        throw new Error(
          `install refused: "${selector.ref}" is both a semver range and a ${literal.refKind} of ${parsed.url}. ` +
            `Install \`git:${parsed.url}@ref:${selector.ref}\` for the ${literal.refKind}, or ` +
            `\`git:${parsed.url}@semver:${selector.range}\` to resolve the range over release tags`,
        );
      }
      return resolveGitRangeSelector({
        url: parsed.url,
        range: selector.range,
        tagPrefix: "",
        probeCandidate: (candidate) =>
          probeGitInstallCandidate({
            parsed,
            source,
            selection,
            context,
            candidate,
          }),
      });
    }
    return resolveGitRangeSelector({
      url: parsed.url,
      range: selector.range,
      tagPrefix: selector.tagPrefix,
      probeCandidate: (candidate) =>
        probeGitInstallCandidate({
          parsed,
          source,
          selection,
          context,
          candidate,
        }),
    });
  }

  async function probeGitInstallCandidate(args: {
    parsed: Extract<ReturnType<typeof parsePluginSource>, { kind: "git" }>;
    source: string;
    selection: PluginSourceSelection;
    context: InstallContext;
    candidate: GitSemverTag;
  }): Promise<GitCandidateProbeResult> {
    const targetDir = gitArtifactCacheDir(
      deps.dataDir,
      args.parsed.cachePath,
      args.candidate.commit,
    );
    const stagingDir = `${targetDir}.install-probe-${randomUUID()}`;
    await mkdir(dirname(stagingDir), { recursive: true });
    try {
      deps.onArtifactMaterialize?.({ path: targetDir });
      await runInstallCommand("git", [
        "clone",
        "--quiet",
        args.parsed.url,
        stagingDir,
      ]);
      await runInstallCommand("git", [
        "-C",
        stagingDir,
        "checkout",
        "--quiet",
        "--detach",
        args.candidate.commit,
      ]);
      const subdirectory = await resolveSelectedSubdirectory({
        checkoutDir: stagingDir,
        selection: args.selection,
        sourceLabel: args.source,
      });
      const root = pluginRootDir(stagingDir, subdirectory);
      const realRoot = await realPathInside(
        stagingDir,
        root,
        "git plugin subdirectory",
        subdirectory === null,
      );
      const manifest = await readPluginManifest(realRoot);
      assertExpectedPluginId(args.context, manifest.id, args.source);
      const compatibility = evaluateCompatibility({
        bbRange: manifest.bbEngineRange,
        sdkRange: manifest.bbPluginSdkRange,
        appVersion: deps.appVersion,
      });
      return compatibility.effective.length > 0
        ? {
            outcome: "incompatible",
            reasons: compatibility.effective,
            devMode: compatibility.devMode,
          }
        : {
            outcome: "compatible",
            devMode: compatibility.devMode,
            packagedBuildProblems: compatibility.packaged,
          };
    } catch (error) {
      return {
        outcome: "invalid",
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }

  async function resolveGitRangeSelector(args: {
    url: string;
    range: string;
    tagPrefix: string;
    probeCandidate: (
      candidate: GitSemverTag,
    ) => Promise<GitCandidateProbeResult>;
  }): Promise<{ selector: PluginGitSelector; commit: string }> {
    const resolved = await resolveGitRange(args);
    if (resolved.outcome === "unavailable") {
      throw new Error(`install failed: ${resolved.detail}`);
    }
    return {
      selector: {
        kind: "range",
        range: args.range,
        tagPrefix: args.tagPrefix,
        resolvedTag: resolved.tag,
      },
      commit: resolved.commit,
    };
  }

  async function installGitSource(
    parsed: Extract<ReturnType<typeof parsePluginSource>, { kind: "git" }>,
    source: string,
    selection: PluginSourceSelection,
    context: InstallContext = directInstallContext,
  ): Promise<PluginListEntry> {
    const resolution = await resolveGitSelector(
      parsed,
      source,
      selection,
      context,
    );
    const resolvedCommit = resolution.commit;
    if (
      context.expectedGitCommit !== undefined &&
      resolvedCommit !== context.expectedGitCommit
    ) {
      throw new Error(
        `install refused: the git source changed after confirmation; expected ${context.expectedGitCommit}, resolved ${resolvedCommit}`,
      );
    }
    const resolvedSelector = resolution.selector;
    const checkoutRef = gitSelectorRefName(resolvedSelector);
    function identityFor(
      subdirectory: string | null,
    ): InstallRegistrationIdentity {
      return {
        provenance: context.provenance,
        sourceIntent: {
          kind: "git",
          url: parsed.url,
          subdirectory,
          selector: resolvedSelector,
        },
      };
    }
    const targetDir = gitArtifactCacheDir(
      deps.dataDir,
      parsed.cachePath,
      resolvedCommit,
    );
    return withArtifactLock(targetDir, async () => {
      const stagingDir = `${targetDir}.staging`;
      await rm(stagingDir, { recursive: true, force: true });
      const cachedSubdirectory = await resolveSelectedSubdirectory({
        checkoutDir: targetDir,
        selection,
        sourceLabel: source,
      }).catch(() => undefined);
      const cachedRegistrationIdentity =
        cachedSubdirectory === undefined
          ? null
          : identityFor(cachedSubdirectory);
      const targetRoot =
        cachedSubdirectory === undefined
          ? targetDir
          : pluginRootDir(targetDir, cachedSubdirectory);
      const cachedRealRoot =
        cachedSubdirectory === undefined
          ? null
          : await realPathInside(
              targetDir,
              targetRoot,
              "git plugin subdirectory",
              cachedSubdirectory === null,
            ).catch(() => null);
      const cachedManifest =
        cachedRealRoot === null
          ? null
          : await readPluginManifest(cachedRealRoot).catch(() => null);
      if (cachedManifest !== null && cachedRegistrationIdentity !== null) {
        assertExpectedPluginId(context, cachedManifest.id, source);
        assertInstallRegistrationAvailable(
          getInstalledPlugin(deps.db, cachedManifest.id),
          cachedRegistrationIdentity,
          cachedManifest.id,
        );
      }
      const existingArtifact =
        cachedManifest === null
          ? undefined
          : getPluginArtifactByResolution(deps.db, {
              sourceKind: "git",
              pluginId: cachedManifest.id,
              path: targetRoot,
              commit: resolvedCommit,
            });
      if (
        cachedRegistrationIdentity !== null &&
        (existingArtifact?.validationResult === "valid" ||
          existingArtifact?.validationResult === "pending") &&
        existingArtifact.contentHash !== null
      ) {
        const currentHash = await hashInstallDir(targetRoot).catch(() => null);
        if (currentHash === existingArtifact.contentHash) {
          if (existingArtifact.validationResult === "pending") {
            setPluginArtifactValidation(deps.db, existingArtifact.id, {
              contentHash: existingArtifact.contentHash,
              validationResult: "valid",
              validatedAt: Date.now(),
            });
          }
          return registerInstalled({
            rootDir: targetRoot,
            source,
            ...cachedRegistrationIdentity,
            exactResolution: { kind: "git", commit: resolvedCommit },
            refuseEngineMismatch: true,
            validated: true,
            activeArtifactId: existingArtifact.id,
          });
        }
      }
      await mkdir(dirname(targetDir), { recursive: true });
      const notFoundHint =
        '"git" was not found on PATH — git: plugin installs require git';
      try {
        deps.onArtifactMaterialize?.({ path: targetDir });
        await runInstallCommand(
          "git",
          ["clone", "--quiet", parsed.url, stagingDir],
          { notFoundHint },
        );
        await runInstallCommand("git", [
          "-C",
          stagingDir,
          "checkout",
          "--quiet",
          "--detach",
          resolvedCommit,
        ]);
        const stagedSubdirectory = await resolveSelectedSubdirectory({
          checkoutDir: stagingDir,
          selection,
          sourceLabel: source,
        });
        const stagedRegistrationIdentity = identityFor(stagedSubdirectory);
        const stagedTargetRoot = pluginRootDir(targetDir, stagedSubdirectory);
        const stagedRealRoot = await realPathInside(
          stagingDir,
          pluginRootDir(stagingDir, stagedSubdirectory),
          "git plugin subdirectory",
          stagedSubdirectory === null,
        );
        const stagedManifest = await readPluginManifest(stagedRealRoot);
        assertExpectedPluginId(context, stagedManifest.id, source);
        assertInstallRegistrationAvailable(
          getInstalledPlugin(deps.db, stagedManifest.id),
          stagedRegistrationIdentity,
          stagedManifest.id,
        );
        refuseBuiltinShadow(stagedManifest.id);
        const checkedOutCommit = await runInstallCommand("git", [
          "-C",
          stagingDir,
          "rev-parse",
          "HEAD",
        ]);
        if (!checkedOutCommit.startsWith(resolvedCommit)) {
          throw new Error(
            `git resolved ${checkoutRef} to ${resolvedCommit}, but checked out ${checkedOutCommit}`,
          );
        }
        await validateInstallDir({
          rootDir: stagedRealRoot,
          source,
          refuseEngineMismatch: true,
        });
        const contentHash = await hashInstallDir(stagedRealRoot);
        const ownedArtifact = getPluginArtifactByResolution(deps.db, {
          sourceKind: "git",
          pluginId: stagedManifest.id,
          path: stagedTargetRoot,
          commit: resolvedCommit,
        });
        const artifact =
          ownedArtifact ??
          createPluginArtifact(deps.db, {
            id: randomUUID(),
            pluginId: stagedManifest.id,
            sourceKind: "git",
            npmResolvedVersion: null,
            gitResolvedCommit: resolvedCommit,
            gitCheckoutRoot: targetDir,
            path: stagedTargetRoot,
            integrity: null,
            contentHash,
            validationResult: "pending",
            validatedAt: null,
          });
        if (ownedArtifact !== undefined) {
          setPluginArtifactGitCheckoutRoot(deps.db, artifact.id, targetDir);
          setPluginArtifactValidation(deps.db, artifact.id, {
            contentHash,
            validationResult: "pending",
            validatedAt: null,
          });
        }
        return registerInstalled({
          rootDir: stagedTargetRoot,
          source,
          ...stagedRegistrationIdentity,
          exactResolution: { kind: "git", commit: resolvedCommit },
          refuseEngineMismatch: true,
          validated: true,
          activeArtifactId: artifact.id,
          preparedManifest: stagedManifest,
          beforePersist: async () => {
            const promotedHash = await promoteGitPluginArtifact({
              stagingDir,
              targetDir,
              subdirectory: stagedSubdirectory,
              contentHash,
              preserveNestedRoots: preservedNestedRoots(stagedTargetRoot),
            });
            await refreshAncestorArtifactHashes({
              checkoutRoot: targetDir,
              changedRoot: stagedTargetRoot,
              changedArtifactId: artifact.id,
            });
            await deps.afterArtifactPromoted?.({
              pluginId: stagedManifest.id,
              artifactId: artifact.id,
              path: stagedTargetRoot,
            });
            if (
              !setPluginArtifactValidation(deps.db, artifact.id, {
                contentHash: promotedHash,
                validationResult: "valid",
                validatedAt: Date.now(),
              })
            ) {
              throw new Error(`plugin artifact disappeared: ${artifact.id}`);
            }
          },
        });
      } catch (error) {
        await rm(stagingDir, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async function resolveNpmCandidateForPlan(args: {
    packageName: string;
    registry?: string;
    requestedSpec: string;
    specKind: NpmSpecKind;
  }): Promise<
    | { outcome: "resolved"; version: string; integrity: string }
    | { outcome: "unavailable"; detail: string }
  > {
    const registryProbe = join(deps.dataDir, "plugins", "npm", ".registry");
    await mkdir(registryProbe, { recursive: true });
    const registry =
      args.registry ??
      (await resolveNpmRegistry(registryProbe, args.packageName));
    const selected = await selectNpmCandidate({
      intent: {
        packageName: args.packageName,
        registry,
        requestedSpec: args.requestedSpec,
        specKind: args.specKind,
      },
      appVersion: deps.appVersion,
      run: npmResolverRun(args.registry),
    });
    if (selected.outcome === "selected") {
      return {
        outcome: "resolved",
        version: selected.candidate.version,
        integrity: selected.candidate.integrity,
      };
    }
    return {
      outcome: "unavailable",
      detail:
        selected.outcome === "unavailable"
          ? selected.detail
          : `${selected.newest.display} ${selected.reasons.map((problem) => problem.message).join("; ")}`,
    };
  }

  async function installNpmSource(
    parsed: Extract<ReturnType<typeof parsePluginSource>, { kind: "npm" }>,
    source: string,
    context: InstallContext = directInstallContext,
  ): Promise<PluginListEntry> {
    const registryProbe = join(deps.dataDir, "plugins", "npm", ".registry");
    await mkdir(registryProbe, { recursive: true });
    const listedRegistry = context.npmRegistry;
    const registry =
      listedRegistry ?? (await resolveNpmRegistry(registryProbe, parsed.name));
    const intent: NpmSourceIntentForResolution = {
      packageName: parsed.name,
      registry,
      requestedSpec: parsed.spec,
      specKind: parsed.specKind,
    };
    const registrationIdentity: InstallRegistrationIdentity = {
      provenance: context.provenance,
      sourceIntent: { kind: "npm", ...intent },
    };
    const pluginId = derivePluginId(parsed.name);
    assertExpectedPluginId(context, pluginId, source);
    assertInstallRegistrationAvailable(
      getInstalledPlugin(deps.db, pluginId),
      registrationIdentity,
      pluginId,
    );
    const selected = await selectNpmCandidate({
      intent,
      appVersion: deps.appVersion,
      run: npmResolverRun(listedRegistry),
    });
    if (selected.outcome === "unavailable") {
      throw new Error(`install failed: ${selected.detail}`);
    }
    if (selected.outcome === "incompatible") {
      throw new Error(
        `install refused: ${selected.newest.display} ${selected.reasons.map((problem) => problem.message).join("; ")}`,
      );
    }
    const candidate = selected.candidate;
    if (
      context.expectedNpmVersion !== undefined &&
      candidate.version !== context.expectedNpmVersion
    ) {
      throw new Error(
        `install refused: the npm source changed after confirmation; expected ${parsed.name}@${context.expectedNpmVersion}, resolved ${candidate.display}`,
      );
    }
    if (
      context.expectedNpmIntegrity !== undefined &&
      candidate.integrity !== context.expectedNpmIntegrity
    ) {
      throw new Error(
        `install refused: the npm integrity changed after confirmation; expected ${context.expectedNpmIntegrity}, resolved ${candidate.integrity}`,
      );
    }
    const prefix = npmArtifactCacheDir(
      deps.dataDir,
      parsed.name,
      candidate.version,
    );
    const rootDir = join(prefix, "node_modules", ...parsed.name.split("/"));
    return withArtifactLock(prefix, async () => {
      const stagingPrefix = `${prefix}.staging`;
      await rm(stagingPrefix, { recursive: true, force: true });
      const cachedManifest = await readPluginManifest(rootDir).catch(
        () => null,
      );
      const existingArtifact =
        cachedManifest === null
          ? undefined
          : getPluginArtifactByResolution(deps.db, {
              sourceKind: "npm",
              pluginId: cachedManifest.id,
              path: rootDir,
              version: candidate.version,
              integrity: candidate.integrity,
            });
      if (
        (existingArtifact?.validationResult === "valid" ||
          existingArtifact?.validationResult === "pending") &&
        existingArtifact.contentHash !== null
      ) {
        const currentHash = await hashInstallDir(prefix).catch(() => null);
        if (currentHash === existingArtifact.contentHash) {
          if (existingArtifact.validationResult === "pending") {
            setPluginArtifactValidation(deps.db, existingArtifact.id, {
              contentHash: existingArtifact.contentHash,
              validationResult: "valid",
              validatedAt: Date.now(),
            });
          }
          return registerInstalled({
            rootDir,
            source,
            ...registrationIdentity,
            exactResolution: {
              kind: "npm",
              version: candidate.version,
              integrity: candidate.integrity,
            },
            refuseEngineMismatch: true,
            validated: true,
            activeArtifactId: existingArtifact.id,
          });
        }
      }
      await mkdir(stagingPrefix, { recursive: true });
      try {
        deps.onArtifactMaterialize?.({ path: rootDir });
        await installNpmCandidate({
          stagingPrefix,
          registry,
          packageName: parsed.name,
          candidate,
          notFoundHint:
            '"npm" was not found on PATH — npm: plugin installs require npm',
        });
        await validateInstallDir({
          rootDir: join(
            stagingPrefix,
            "node_modules",
            ...parsed.name.split("/"),
          ),
          source,
          refuseEngineMismatch: true,
        });
        const installedIntegrity = await readNpmIntegrity(
          stagingPrefix,
          parsed.name,
        );
        if (
          candidate.integrity.length > 0 &&
          installedIntegrity !== null &&
          installedIntegrity !== candidate.integrity
        ) {
          throw new Error(
            `install failed: integrity for ${candidate.display} did not match registry metadata`,
          );
        }
        const stagedRoot = join(
          stagingPrefix,
          "node_modules",
          ...parsed.name.split("/"),
        );
        const manifest = await readPluginManifest(stagedRoot);
        const contentHash = await hashInstallDir(stagingPrefix);
        const ownedArtifact =
          existingArtifact ??
          getPluginArtifactByResolution(deps.db, {
            sourceKind: "npm",
            pluginId: manifest.id,
            path: rootDir,
            version: candidate.version,
            integrity: candidate.integrity,
          });
        const artifact =
          ownedArtifact ??
          createPluginArtifact(deps.db, {
            id: randomUUID(),
            pluginId: manifest.id,
            sourceKind: "npm",
            npmResolvedVersion: candidate.version,
            gitResolvedCommit: null,
            gitCheckoutRoot: null,
            path: rootDir,
            integrity: candidate.integrity,
            contentHash,
            validationResult: "pending",
            validatedAt: null,
          });
        if (ownedArtifact !== undefined) {
          setPluginArtifactValidation(deps.db, artifact.id, {
            contentHash,
            validationResult: "pending",
            validatedAt: null,
          });
        }
        return registerInstalled({
          rootDir,
          source,
          ...registrationIdentity,
          exactResolution: {
            kind: "npm",
            version: candidate.version,
            integrity: candidate.integrity,
          },
          refuseEngineMismatch: true,
          validated: true,
          activeArtifactId: artifact.id,
          preparedManifest: manifest,
          beforePersist: async () => {
            await promoteImmutableDir({
              stagingDir: stagingPrefix,
              targetDir: prefix,
              contentHash,
            });
            await deps.afterArtifactPromoted?.({
              pluginId: manifest.id,
              artifactId: artifact.id,
              path: rootDir,
            });
            if (
              !setPluginArtifactValidation(deps.db, artifact.id, {
                contentHash,
                validationResult: "valid",
                validatedAt: Date.now(),
              })
            ) {
              throw new Error(`plugin artifact disappeared: ${artifact.id}`);
            }
          },
        });
      } catch (error) {
        await rm(stagingPrefix, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async function stageGitCandidate(args: {
    row: InstalledPluginRow;
    commit: string;
    promote: boolean;
    activationSelector?: PluginGitSelector;
    artifactLocked?: boolean;
  }): Promise<
    | {
        outcome: "valid";
        manifest: PluginManifest;
        devMode: boolean;
        packagedBuildProblems: CompatibilityProblem[];
        rootDir: string | null;
        artifactId: string | null;
      }
    | {
        outcome: "incompatible";
        manifest: PluginManifest;
        devMode: boolean;
        reasons: CompatibilityProblem[];
      }
    | { outcome: "invalid"; detail: string }
  > {
    if (args.row.sourceGitUrl === null) {
      throw new Error(
        `plugin "${args.row.id}" has corrupt normalized git state`,
      );
    }
    const url = args.row.sourceGitUrl;
    const cacheSource = parsePluginSource(`git:${url}@${args.commit}`);
    if (cacheSource.kind !== "git") {
      throw new Error(`plugin "${args.row.id}" has corrupt git source`);
    }
    const targetDir = gitArtifactCacheDir(
      deps.dataDir,
      cacheSource.cachePath,
      args.commit,
    );
    const targetRoot = pluginRootDir(targetDir, args.row.sourceGitSubdirectory);
    if (args.promote && !args.artifactLocked) {
      return withArtifactLock(targetDir, () =>
        stageGitCandidate({ ...args, artifactLocked: true }),
      );
    }
    const existingArtifact = getPluginArtifactByResolution(deps.db, {
      sourceKind: "git",
      pluginId: args.row.id,
      path: targetRoot,
      commit: args.commit,
    });
    if (
      args.promote &&
      (existingArtifact?.validationResult === "valid" ||
        existingArtifact?.validationResult === "pending") &&
      existingArtifact.contentHash !== null &&
      (await hashInstallDir(targetRoot).catch(() => null)) ===
        existingArtifact.contentHash
    ) {
      const targetRealRoot = await realPathInside(
        targetDir,
        targetRoot,
        "git plugin subdirectory",
        args.row.sourceGitSubdirectory === null,
      );
      const manifest = await readPluginManifest(targetRealRoot);
      const compatibility = evaluateCompatibility({
        bbRange: manifest.bbEngineRange,
        sdkRange: manifest.bbPluginSdkRange,
        appVersion: deps.appVersion,
      });
      if (args.activationSelector === undefined) {
        throw new Error(`plugin "${args.row.id}" update lacks git intent`);
      }
      if (existingArtifact.validationResult === "pending") {
        setPluginArtifactValidation(deps.db, existingArtifact.id, {
          contentHash: existingArtifact.contentHash,
          validationResult: "valid",
          validatedAt: Date.now(),
        });
      }
      await activateManagedUpdate({
        row: args.row,
        rootDir: targetRoot,
        manifest,
        source: args.row.source,
        sourceIntent: {
          kind: "git",
          url,
          subdirectory: args.row.sourceGitSubdirectory,
          selector: args.activationSelector,
        },
        exactResolution: { kind: "git", commit: args.commit },
        artifactId: existingArtifact.id,
      });
      return {
        outcome: "valid",
        manifest,
        devMode: compatibility.devMode,
        packagedBuildProblems: compatibility.packaged,
        rootDir: targetRoot,
        artifactId: existingArtifact.id,
      };
    }
    const stagingDir = args.promote
      ? `${targetDir}.staging`
      : `${targetDir}.update-staging-${randomUUID()}`;
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(dirname(stagingDir), { recursive: true });
    try {
      deps.onArtifactMaterialize?.({ path: targetRoot });
      await runInstallCommand("git", ["clone", "--quiet", url, stagingDir], {
        notFoundHint:
          '"git" was not found on PATH — git plugin updates require git',
      });
      await runInstallCommand("git", [
        "-C",
        stagingDir,
        "checkout",
        "--quiet",
        "--detach",
        args.commit,
      ]);
      const pluginRoot = pluginRootDir(
        stagingDir,
        args.row.sourceGitSubdirectory,
      );
      let realPluginRoot: string;
      try {
        realPluginRoot = await realPathInside(
          stagingDir,
          pluginRoot,
          "git plugin subdirectory",
          args.row.sourceGitSubdirectory === null,
        );
      } catch (error) {
        return {
          outcome: "invalid",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      let manifest: PluginManifest;
      try {
        manifest = await readPluginManifest(realPluginRoot);
      } catch (error) {
        return {
          outcome: "invalid",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (manifest.id !== args.row.id) {
        return {
          outcome: "invalid",
          detail: `candidate manifest id changed from "${args.row.id}" to "${manifest.id}"`,
        };
      }
      const compatibility = evaluateCompatibility({
        bbRange: manifest.bbEngineRange,
        sdkRange: manifest.bbPluginSdkRange,
        appVersion: deps.appVersion,
      });
      if (compatibility.effective.length > 0) {
        return {
          outcome: "incompatible",
          manifest,
          devMode: compatibility.devMode,
          reasons: compatibility.effective,
        };
      }
      try {
        await (args.promote ? validateInstallDir : validateManifestOnly)({
          rootDir: realPluginRoot,
          source: args.row.source,
          refuseEngineMismatch: true,
        });
      } catch (error) {
        return {
          outcome: "invalid",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      let artifactId: string | null = null;
      if (args.promote) {
        if (args.activationSelector === undefined) {
          throw new Error(`plugin "${args.row.id}" update lacks git intent`);
        }
        const activationSelector = args.activationSelector;
        const contentHash = await hashInstallDir(realPluginRoot);
        const artifact =
          existingArtifact ??
          createPluginArtifact(deps.db, {
            id: randomUUID(),
            pluginId: args.row.id,
            sourceKind: "git",
            npmResolvedVersion: null,
            gitResolvedCommit: args.commit,
            gitCheckoutRoot: targetDir,
            path: targetRoot,
            integrity: null,
            contentHash,
            validationResult: "pending",
            validatedAt: null,
          });
        if (existingArtifact !== undefined) {
          setPluginArtifactGitCheckoutRoot(
            deps.db,
            existingArtifact.id,
            targetDir,
          );
          setPluginArtifactValidation(deps.db, existingArtifact.id, {
            contentHash,
            validationResult: "pending",
            validatedAt: null,
          });
        }
        await activateManagedUpdate({
          row: args.row,
          rootDir: targetRoot,
          manifest,
          source: args.row.source,
          sourceIntent: {
            kind: "git",
            url,
            subdirectory: args.row.sourceGitSubdirectory,
            selector: activationSelector,
          },
          exactResolution: { kind: "git", commit: args.commit },
          artifactId: artifact.id,
          beforePersist: async () => {
            const promotedHash = await promoteGitPluginArtifact({
              stagingDir,
              targetDir,
              subdirectory: args.row.sourceGitSubdirectory,
              contentHash,
              preserveNestedRoots: preservedNestedRoots(targetRoot),
            });
            await refreshAncestorArtifactHashes({
              checkoutRoot: targetDir,
              changedRoot: targetRoot,
              changedArtifactId: artifact.id,
            });
            await deps.afterArtifactPromoted?.({
              pluginId: args.row.id,
              artifactId: artifact.id,
              path: targetRoot,
            });
            if (
              !setPluginArtifactValidation(deps.db, artifact.id, {
                contentHash: promotedHash,
                validationResult: "valid",
                validatedAt: Date.now(),
              })
            ) {
              throw new Error(`plugin artifact disappeared: ${artifact.id}`);
            }
          },
        });
        artifactId = artifact.id;
      }
      return {
        outcome: "valid",
        manifest,
        devMode: compatibility.devMode,
        packagedBuildProblems: compatibility.packaged,
        rootDir: args.promote ? targetRoot : null,
        artifactId,
      };
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }

  async function applyNpmCandidate(args: {
    row: InstalledPluginRow;
    selectionIntent: NpmSourceIntentForResolution;
    candidate: NpmResolvedCandidate;
  }): Promise<void> {
    const targetPrefix = npmArtifactCacheDir(
      deps.dataDir,
      args.selectionIntent.packageName,
      args.candidate.version,
    );
    const targetRoot = join(
      targetPrefix,
      "node_modules",
      ...args.selectionIntent.packageName.split("/"),
    );
    return withArtifactLock(targetPrefix, async () => {
      const existingArtifact = getPluginArtifactByResolution(deps.db, {
        sourceKind: "npm",
        pluginId: args.row.id,
        path: targetRoot,
        version: args.candidate.version,
        integrity: args.candidate.integrity,
      });
      if (
        (existingArtifact?.validationResult === "valid" ||
          existingArtifact?.validationResult === "pending") &&
        existingArtifact.contentHash !== null &&
        (await hashInstallDir(targetPrefix).catch(() => null)) ===
          existingArtifact.contentHash
      ) {
        if (existingArtifact.validationResult === "pending") {
          setPluginArtifactValidation(deps.db, existingArtifact.id, {
            contentHash: existingArtifact.contentHash,
            validationResult: "valid",
            validatedAt: Date.now(),
          });
        }
        const manifest = await readPluginManifest(targetRoot);
        await activateManagedUpdate({
          row: args.row,
          rootDir: targetRoot,
          manifest,
          source:
            args.selectionIntent.specKind === "default"
              ? `npm:${args.selectionIntent.packageName}`
              : `npm:${args.selectionIntent.packageName}@${args.selectionIntent.requestedSpec}`,
          sourceIntent: { kind: "npm", ...args.selectionIntent },
          exactResolution: {
            kind: "npm",
            version: args.candidate.version,
            integrity: args.candidate.integrity,
          },
          artifactId: existingArtifact.id,
        });
        return;
      }
      const stagingPrefix = `${targetPrefix}.staging`;
      await rm(stagingPrefix, { recursive: true, force: true });
      await mkdir(stagingPrefix, { recursive: true });
      try {
        deps.onArtifactMaterialize?.({ path: targetRoot });
        await installNpmCandidate({
          stagingPrefix,
          registry: args.selectionIntent.registry,
          packageName: args.selectionIntent.packageName,
          candidate: args.candidate,
          notFoundHint:
            '"npm" was not found on PATH — npm plugin updates require npm',
        });
        const stagedRoot = join(
          stagingPrefix,
          "node_modules",
          ...args.selectionIntent.packageName.split("/"),
        );
        const manifest = await validateInstallDir({
          rootDir: stagedRoot,
          source: args.row.source,
          refuseEngineMismatch: true,
        });
        if (manifest.id !== args.row.id) {
          throw new Error(
            `update refused: candidate manifest id changed from "${args.row.id}" to "${manifest.id}"`,
          );
        }
        const installedIntegrity = await readNpmIntegrity(
          stagingPrefix,
          args.selectionIntent.packageName,
        );
        if (
          args.candidate.integrity.length > 0 &&
          installedIntegrity !== null &&
          installedIntegrity !== args.candidate.integrity
        ) {
          throw new Error(
            `update refused: integrity for ${args.candidate.display} did not match registry metadata`,
          );
        }
        const contentHash = await hashInstallDir(stagingPrefix);
        const artifact =
          existingArtifact ??
          createPluginArtifact(deps.db, {
            id: randomUUID(),
            pluginId: args.row.id,
            sourceKind: "npm",
            npmResolvedVersion: args.candidate.version,
            gitResolvedCommit: null,
            gitCheckoutRoot: null,
            path: targetRoot,
            integrity: args.candidate.integrity,
            contentHash,
            validationResult: "pending",
            validatedAt: null,
          });
        await activateManagedUpdate({
          row: args.row,
          rootDir: targetRoot,
          manifest,
          source:
            args.selectionIntent.specKind === "default"
              ? `npm:${args.selectionIntent.packageName}`
              : `npm:${args.selectionIntent.packageName}@${args.selectionIntent.requestedSpec}`,
          sourceIntent: { kind: "npm", ...args.selectionIntent },
          exactResolution: {
            kind: "npm",
            version: args.candidate.version,
            integrity: args.candidate.integrity,
          },
          artifactId: artifact.id,
          beforePersist: async () => {
            await promoteImmutableDir({
              stagingDir: stagingPrefix,
              targetDir: targetPrefix,
              contentHash,
            });
            await deps.afterArtifactPromoted?.({
              pluginId: args.row.id,
              artifactId: artifact.id,
              path: targetRoot,
            });
            if (
              !setPluginArtifactValidation(deps.db, artifact.id, {
                contentHash,
                validationResult: "valid",
                validatedAt: Date.now(),
              })
            ) {
              throw new Error(`plugin artifact disappeared: ${artifact.id}`);
            }
          },
        });
      } catch (error) {
        await rm(stagingPrefix, { recursive: true, force: true });
        throw error;
      }
    });
  }

  return {
    applyNpmCandidate,
    installGitSource,
    installNpmSource,
    resolveNpmCandidateForPlan,
    stageGitCandidate,
    validateInstallDir,
  };
}
