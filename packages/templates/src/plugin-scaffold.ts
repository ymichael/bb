import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { derivePluginId, PLUGIN_SDK_VERSION } from "@bb/domain";
import { loadPluginSdkDeclarations } from "./plugin-sdk-dts.js";
import {
  PLUGIN_SHIMMED_TYPE_DEPENDENCIES,
  PLUGIN_STARTER_DEPENDENCIES,
  PLUGIN_STARTER_FILES,
} from "./generated/plugin-starter-files.generated.js";

interface ScaffoldPluginArgs {
  targetDir: string;
  packageName: string;
  bbVersion: string;
}

interface SyncPluginTypesArgs {
  rootDir: string;
  app: boolean;
  check?: boolean;
}

interface SyncedPluginTypeFile {
  path: string;
  outcome: "written" | "unchanged" | "stale";
}

export async function syncPluginTypes(
  args: SyncPluginTypesArgs,
): Promise<SyncedPluginTypeFile[]> {
  const { rootDir, app, check = false } = args;
  const typesDir = join(rootDir, "types");
  const declarations = await loadPluginSdkDeclarations();
  const candidates: { name: string; content: string; optional: boolean }[] = [
    { name: "bb-plugin-sdk.d.ts", content: declarations.root, optional: false },
    {
      name: "bb-plugin-sdk-app.d.ts",
      content: declarations.app,
      optional: !app,
    },
  ];
  await assertWritableTypesDir(rootDir, typesDir);
  const results: SyncedPluginTypeFile[] = [];
  for (const candidate of candidates) {
    const filePath = join(typesDir, candidate.name);
    const relativePath = `types/${candidate.name}`;
    const existing = await statNoFollow(filePath, relativePath);
    if (existing !== null && !existing.isFile()) {
      throw new Error(`${relativePath} is not a regular file`);
    }
    const current = existing === null ? null : await readFile(filePath, "utf8");
    if (current === null && candidate.optional) continue;
    if (current === candidate.content) {
      results.push({ path: relativePath, outcome: "unchanged" });
      continue;
    }
    if (check) {
      results.push({ path: relativePath, outcome: "stale" });
      continue;
    }
    await mkdir(typesDir, { recursive: true });
    await writeFileAtomically(filePath, relativePath, candidate.content);
    results.push({ path: relativePath, outcome: "written" });
  }
  return results;
}

interface PluginSdkLayout {
  kind: "vendored" | "package";
  pin: string | null;
}

export async function resolvePluginSdkLayout(
  rootDir: string,
): Promise<PluginSdkLayout> {
  const pin = await readDeclaredSdkPin(rootDir);
  const hasVendoredTypes =
    (await pathExists(join(rootDir, "types", "bb-plugin-sdk.d.ts"))) ||
    (await pathExists(join(rootDir, "types", "bb-plugin-sdk-app.d.ts")));
  const hasPathMap = await tsconfigMapsSdk(rootDir);
  return {
    kind: hasVendoredTypes || hasPathMap ? "vendored" : "package",
    pin,
  };
}

const SDK_PATH_MAP_PREFIXES = ["@get-bb/plugin-sdk", "@bb/plugin-sdk"] as const;

const VENDORED_DECLARATIONS = [
  "bb-plugin-sdk.d.ts",
  "bb-plugin-sdk-app.d.ts",
] as const;

const LEGACY_SDK_SPECIFIER_PATTERN =
  /(["'])@bb\/plugin-sdk((?:\/[^"'\n]*)?)\1/g;

const PLUGIN_SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;
const UNSCANNED_DIRECTORIES = new Set([
  "dist",
  "node_modules",
  ".git",
  "types",
]);
const MAX_SOURCE_SCAN_DEPTH = 12;

interface MigratePluginArgs {
  rootDir: string;
  sdkVersion: string;
  dryRun?: boolean;
}

export interface PluginPackageLayoutMigration {
  changed: boolean;
  pin: { from: string | null; to: string } | null;
  movedFromDependencies: boolean;
  enginesFloor: { from: string | null; to: string } | null;
  removedPathMaps: string[];
  removedIncludes: string[];
  deletedFiles: string[];
  removedTypesDir: boolean;
  rewrittenImports: RewrittenSdkImportFile[];
}

interface RewrittenSdkImportFile {
  path: string;
  imports: number;
}

export async function migratePluginToPackageLayout(
  args: MigratePluginArgs,
): Promise<PluginPackageLayoutMigration> {
  const { rootDir, sdkVersion, dryRun = false } = args;
  const manifestPlan = await planManifest(rootDir, sdkVersion, {
    raiseFloor: true,
    shimmedTypePins: "none",
  });
  const typesPlan = await planVendoredDeletions(rootDir);
  const tsconfigPlan = await planTsconfig(rootDir, {
    removeTypesIncludes: typesPlan.removedTypesDir,
  });
  const importPlan = await planSdkImportRewrites(rootDir);
  const result: PluginPackageLayoutMigration = {
    changed:
      manifestPlan.text !== null ||
      tsconfigPlan.text !== null ||
      typesPlan.deletedFiles.length > 0 ||
      typesPlan.removedTypesDir ||
      importPlan.length > 0,
    pin: manifestPlan.pin,
    movedFromDependencies: manifestPlan.movedFromDependencies,
    enginesFloor: manifestPlan.enginesFloor,
    removedPathMaps: tsconfigPlan.removedPathMaps,
    removedIncludes: tsconfigPlan.removedIncludes,
    deletedFiles: typesPlan.deletedFiles,
    removedTypesDir: typesPlan.removedTypesDir,
    rewrittenImports: importPlan,
  };
  if (dryRun) return result;
  if (manifestPlan.text !== null) {
    await writeJsonFileAtomically(rootDir, "package.json", manifestPlan.text);
  }
  const typesDir = join(rootDir, "types");
  for (const relativePath of typesPlan.deletedFiles) {
    await assertWritableTypesDir(rootDir, typesDir);
    const filePath = join(rootDir, relativePath);
    const stats = await statNoFollow(filePath, relativePath);
    if (stats === null) continue;
    if (!stats.isFile()) {
      throw new Error(`${relativePath} is not a regular file`);
    }
    await rm(filePath, { force: true });
  }
  if (typesPlan.removedTypesDir) {
    await assertWritableTypesDir(rootDir, typesDir);
    await rmdir(typesDir).catch(() => undefined);
    result.removedTypesDir = (await statNoFollow(typesDir, "types")) === null;
  }
  const appliedTsconfigPlan =
    typesPlan.removedTypesDir && !result.removedTypesDir
      ? await planTsconfig(rootDir, { removeTypesIncludes: false })
      : tsconfigPlan;
  result.removedIncludes = appliedTsconfigPlan.removedIncludes;
  if (appliedTsconfigPlan.text !== null) {
    await writeJsonFileAtomically(
      rootDir,
      "tsconfig.json",
      appliedTsconfigPlan.text,
    );
  }
  for (const file of importPlan) {
    await rewriteSdkImportsInFile(rootDir, file.path);
  }
  return result;
}

async function rewriteSdkImportsInFile(
  rootDir: string,
  relativePath: string,
): Promise<void> {
  const filePath = join(rootDir, ...relativePath.split("/"));
  await assertInsidePlugin(rootDir, dirname(filePath), relativePath);
  const stats = await statNoFollow(filePath, relativePath);
  if (stats === null || !stats.isFile()) return;
  const current = await readFile(filePath, "utf8");
  const rewritten = rewriteLegacySdkSpecifiers(current);
  if (rewritten.imports === 0) return;
  await writeFileAtomically(filePath, relativePath, rewritten.text);
}

function rewriteLegacySdkSpecifiers(content: string): {
  text: string;
  imports: number;
} {
  let imports = 0;
  const text = content.replace(
    LEGACY_SDK_SPECIFIER_PATTERN,
    (_match, quote: string, subpath: string) => {
      imports += 1;
      return `${quote}@get-bb/plugin-sdk${subpath}${quote}`;
    },
  );
  return { text, imports };
}

async function planSdkImportRewrites(
  rootDir: string,
): Promise<RewrittenSdkImportFile[]> {
  const found: RewrittenSdkImportFile[] = [];
  const walk = async (
    dir: string,
    prefix: string,
    depth: number,
  ): Promise<void> => {
    if (depth > MAX_SOURCE_SCAN_DEPTH) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(
      () => null,
    );
    if (entries === null) return;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relativePath =
        prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (UNSCANNED_DIRECTORIES.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;
        await walk(join(dir, entry.name), relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!PLUGIN_SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        continue;
      }
      let content: string;
      try {
        content = await readFile(join(dir, entry.name), "utf8");
      } catch {
        continue;
      }
      const { imports } = rewriteLegacySdkSpecifiers(content);
      if (imports > 0) found.push({ path: relativePath, imports });
    }
  };
  await walk(rootDir, "", 0);
  found.sort((left, right) => (left.path < right.path ? -1 : 1));
  return found;
}

async function assertInsidePlugin(
  rootDir: string,
  path: string,
  label: string,
): Promise<void> {
  const [realRoot, realPath] = await Promise.all([
    realpath(rootDir),
    realpath(path),
  ]);
  const rel = relative(realRoot, realPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} resolves outside the plugin (${realPath})`);
  }
}

interface SetPluginSdkPinArgs {
  rootDir: string;
  sdkVersion: string;
  app: boolean;
  dryRun?: boolean;
}

export interface ShimmedTypePinChange {
  name: string;
  from: string | null;
  to: string;
  movedFromDependencies: boolean;
}

interface PluginSdkPinChange {
  pin: { from: string | null; to: string } | null;
  movedFromDependencies: boolean;
  shimmedTypePins: ShimmedTypePinChange[];
}

export async function setPluginSdkPin(
  args: SetPluginSdkPinArgs,
): Promise<PluginSdkPinChange | null> {
  const { rootDir, sdkVersion, app, dryRun = false } = args;
  const plan = await planManifest(rootDir, sdkVersion, {
    raiseFloor: false,
    shimmedTypePins: app ? "all" : "declared",
  });
  if (plan.text === null) return null;
  if (!dryRun) {
    await writeJsonFileAtomically(rootDir, "package.json", plan.text);
  }
  return {
    pin: plan.pin,
    movedFromDependencies: plan.movedFromDependencies,
    shimmedTypePins: plan.shimmedTypePins,
  };
}

interface ManifestPlan {
  pin: { from: string | null; to: string } | null;
  movedFromDependencies: boolean;
  shimmedTypePins: ShimmedTypePinChange[];
  enginesFloor: { from: string | null; to: string } | null;
  text: string | null;
}

type ShimmedTypePinPolicy = "none" | "declared" | "all";

async function planManifest(
  rootDir: string,
  sdkVersion: string,
  options: { raiseFloor: boolean; shimmedTypePins: ShimmedTypePinPolicy },
): Promise<ManifestPlan> {
  const path = join(rootDir, "package.json");
  await statNoFollow(path, "package.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error("package.json could not be read");
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
    manifest = parsed as Record<string, unknown>;
  } catch {
    throw new Error("package.json is not valid JSON");
  }

  const declaredPin = readSdkPinFrom(manifest);
  const pin =
    declaredPin.version === sdkVersion
      ? null
      : { from: declaredPin.version, to: sdkVersion };
  const movedFromDependencies = declaredPin.inDependencies;
  if (pin !== null || movedFromDependencies) {
    if (movedFromDependencies) {
      const deps = asRecord(manifest.dependencies);
      delete deps["@get-bb/plugin-sdk"];
      if (Object.keys(deps).length === 0) {
        delete manifest.dependencies;
      } else {
        manifest.dependencies = deps;
      }
    }
    manifest.devDependencies = insertDependency(
      asRecord(manifest.devDependencies),
      "@get-bb/plugin-sdk",
      sdkVersion,
    );
  }

  const shimmedTypePins = applyShimmedTypePins(
    manifest,
    options.shimmedTypePins,
  );

  let enginesFloor: ManifestPlan["enginesFloor"] = null;
  if (options.raiseFloor) {
    const engines = asRecord(manifest.engines);
    const current = engines.bbPluginSdk;
    const from = typeof current === "string" ? current : null;
    if (isFloorBelow(from, sdkVersion)) {
      enginesFloor = { from, to: `>=${sdkVersion}` };
      manifest.engines = { ...engines, bbPluginSdk: `>=${sdkVersion}` };
    }
  }

  if (
    pin === null &&
    !movedFromDependencies &&
    shimmedTypePins.length === 0 &&
    enginesFloor === null
  ) {
    return {
      pin: null,
      movedFromDependencies: false,
      shimmedTypePins: [],
      enginesFloor: null,
      text: null,
    };
  }
  return {
    pin,
    movedFromDependencies,
    shimmedTypePins,
    enginesFloor,
    text: reserialize(raw, manifest),
  };
}

function applyShimmedTypePins(
  manifest: Record<string, unknown>,
  policy: ShimmedTypePinPolicy,
): ShimmedTypePinChange[] {
  if (policy === "none") return [];
  const changes: ShimmedTypePinChange[] = [];
  const deps = asRecord(manifest.dependencies);
  let devDeps = asRecord(manifest.devDependencies);
  let depsChanged = false;
  for (const [name, hostVersion] of Object.entries(
    PLUGIN_SHIMMED_TYPE_DEPENDENCIES,
  )) {
    const runtimeDeclared = deps[name];
    const devDeclared = devDeps[name];
    const inDependencies = typeof runtimeDeclared === "string";
    const declared =
      typeof devDeclared === "string"
        ? devDeclared
        : inDependencies
          ? runtimeDeclared
          : null;
    if (declared === null && policy === "declared") continue;
    if (declared === hostVersion && !inDependencies) continue;
    changes.push({
      name,
      from: declared,
      to: hostVersion,
      movedFromDependencies: inDependencies,
    });
    if (inDependencies) {
      delete deps[name];
      depsChanged = true;
    }
    devDeps = insertDependency(devDeps, name, hostVersion);
  }
  if (changes.length === 0) return [];
  if (depsChanged) {
    if (Object.keys(deps).length === 0) {
      delete manifest.dependencies;
    } else {
      manifest.dependencies = deps;
    }
  }
  manifest.devDependencies = devDeps;
  return changes;
}

function readSdkPinFrom(manifest: Record<string, unknown>): {
  inDependencies: boolean;
  version: string | null;
} {
  const inDependencies =
    typeof asRecord(manifest.dependencies)["@get-bb/plugin-sdk"] === "string";
  for (const field of ["devDependencies", "dependencies"] as const) {
    const declared = asRecord(manifest[field])["@get-bb/plugin-sdk"];
    if (typeof declared === "string")
      return { inDependencies, version: declared };
  }
  return { inDependencies, version: null };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function insertDependency(
  deps: Record<string, unknown>,
  name: string,
  version: string,
): Record<string, unknown> {
  if (name in deps) return { ...deps, [name]: version };
  const keys = Object.keys(deps);
  const sorted = keys.every(
    (key, index) => index === 0 || keys[index - 1]! < key,
  );
  if (!sorted) return { ...deps, [name]: version };
  const next: Record<string, unknown> = {};
  let inserted = false;
  for (const key of keys) {
    if (!inserted && name < key) {
      next[name] = version;
      inserted = true;
    }
    next[key] = deps[key];
  }
  if (!inserted) next[name] = version;
  return next;
}

function isFloorBelow(range: string | null, version: string): boolean {
  if (range === null || range.trim().length === 0) return true;
  const floor = parseVersionTuple(range);
  const target = parseVersionTuple(version);
  if (floor === null || target === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (floor[index]! !== target[index]!) return floor[index]! < target[index]!;
  }
  return false;
}

function parseVersionTuple(value: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(value);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

interface TsconfigPlan {
  removedPathMaps: string[];
  removedIncludes: string[];
  text: string | null;
}

async function planTsconfig(
  rootDir: string,
  options: { removeTypesIncludes: boolean },
): Promise<TsconfigPlan> {
  const empty: TsconfigPlan = {
    removedPathMaps: [],
    removedIncludes: [],
    text: null,
  };
  const path = join(rootDir, "tsconfig.json");
  if ((await statNoFollow(path, "tsconfig.json")) === null) return empty;
  const raw = await readFile(path, "utf8");
  let tsconfig: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
    tsconfig = parsed as Record<string, unknown>;
  } catch {
    throw new Error(
      "tsconfig.json is not valid JSON — remove the @get-bb/plugin-sdk paths entry by hand",
    );
  }

  const compilerOptions = asRecord(tsconfig.compilerOptions);
  const paths = asRecord(compilerOptions.paths);
  const removedPathMaps = Object.keys(paths).filter((key) =>
    SDK_PATH_MAP_PREFIXES.some(
      (name) => key === name || key.startsWith(`${name}/`),
    ),
  );
  const include = Array.isArray(tsconfig.include) ? tsconfig.include : null;
  const removedIncludes =
    include === null || !options.removeTypesIncludes
      ? []
      : include.filter(
          (entry): entry is string =>
            typeof entry === "string" &&
            (entry === "types" || entry.startsWith("types/")),
        );
  if (removedPathMaps.length === 0 && removedIncludes.length === 0) {
    return empty;
  }

  if (removedPathMaps.length > 0) {
    const nextPaths = Object.fromEntries(
      Object.entries(paths).filter(([key]) => !removedPathMaps.includes(key)),
    );
    if (Object.keys(nextPaths).length === 0) {
      delete compilerOptions.paths;
    } else {
      compilerOptions.paths = nextPaths;
    }
    tsconfig.compilerOptions = compilerOptions;
  }
  if (removedIncludes.length > 0 && include !== null) {
    tsconfig.include = include.filter(
      (entry) => typeof entry !== "string" || !removedIncludes.includes(entry),
    );
  }
  return {
    removedPathMaps,
    removedIncludes,
    text: reserialize(raw, tsconfig),
  };
}

async function planVendoredDeletions(
  rootDir: string,
): Promise<{ deletedFiles: string[]; removedTypesDir: boolean }> {
  const typesDir = join(rootDir, "types");
  await assertWritableTypesDir(rootDir, typesDir);
  if ((await statNoFollow(typesDir, "types")) === null) {
    return { deletedFiles: [], removedTypesDir: false };
  }
  const deletedFiles: string[] = [];
  for (const name of VENDORED_DECLARATIONS) {
    const stats = await statNoFollow(join(typesDir, name), `types/${name}`);
    if (stats === null) continue;
    if (!stats.isFile()) throw new Error(`types/${name} is not a regular file`);
    deletedFiles.push(`types/${name}`);
  }
  const remaining = (await readdir(typesDir)).filter(
    (name) => !deletedFiles.includes(`types/${name}`),
  );
  return { deletedFiles, removedTypesDir: remaining.length === 0 };
}

function reserialize(raw: string, value: Record<string, unknown>): string {
  const indentMatch = /\n([ \t]+)"/.exec(raw);
  const indent = indentMatch === null ? 2 : indentMatch[1]!;
  const serialized = JSON.stringify(value, null, indent);
  return raw.endsWith("\n") ? `${serialized}\n` : serialized;
}

async function writeJsonFileAtomically(
  rootDir: string,
  name: string,
  text: string,
): Promise<void> {
  await writeFileAtomically(join(rootDir, name), name, text);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readDeclaredSdkPin(rootDir: string): Promise<string | null> {
  const manifest = await readJsonFile(join(rootDir, "package.json"));
  if (manifest === null) return null;
  for (const field of ["devDependencies", "dependencies"] as const) {
    const deps = manifest[field];
    if (typeof deps !== "object" || deps === null) continue;
    const declared = (deps as Record<string, unknown>)["@get-bb/plugin-sdk"];
    if (typeof declared === "string") return declared;
  }
  return null;
}

async function tsconfigMapsSdk(rootDir: string): Promise<boolean> {
  const tsconfigPath = join(rootDir, "tsconfig.json");
  const tsconfig = await readJsonFile(tsconfigPath);
  if (tsconfig === null) {
    let raw: string;
    try {
      raw = await readFile(tsconfigPath, "utf8");
    } catch {
      return false;
    }
    return (
      raw.includes('"@get-bb/plugin-sdk') || raw.includes('"@bb/plugin-sdk')
    );
  }
  const compilerOptions = tsconfig.compilerOptions;
  if (typeof compilerOptions !== "object" || compilerOptions === null) {
    return false;
  }
  const paths = (compilerOptions as Record<string, unknown>).paths;
  if (typeof paths !== "object" || paths === null) return false;
  return Object.keys(paths).some(
    (key) =>
      key === "@get-bb/plugin-sdk" ||
      key.startsWith("@get-bb/plugin-sdk/") ||
      key === "@bb/plugin-sdk" ||
      key.startsWith("@bb/plugin-sdk/"),
  );
}

async function readJsonFile(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function statNoFollow(
  path: string,
  label: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`refusing to write through the symbolic link ${label}`);
  }
  return stats;
}

async function assertWritableTypesDir(
  rootDir: string,
  typesDir: string,
): Promise<void> {
  const stats = await statNoFollow(typesDir, "types");
  if (stats === null) return;
  if (!stats.isDirectory())
    throw new Error("types exists but is not a directory");
  const [realRoot, realTypes] = await Promise.all([
    realpath(rootDir),
    realpath(typesDir),
  ]);
  const rel = relative(realRoot, realTypes);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`types resolves outside the plugin (${realTypes})`);
  }
}

async function writeFileAtomically(
  filePath: string,
  label: string,
  content: string,
): Promise<void> {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}.bb-tmp`;
  const tempPath = `${filePath}.${suffix}`;
  if (await pathExists(tempPath)) {
    throw new Error(
      `refusing to overwrite the temporary file ${label}.${suffix}`,
    );
  }
  await writeFile(tempPath, content, { flag: "wx" });
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function pluginNameOf(packageName: string): string {
  return derivePluginId(packageName)
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function enginesRange(bbVersion: string): string {
  const match = /^(\d+)\.(\d+)/.exec(bbVersion);
  return match ? `>=${match[1]}.${match[2]}` : ">=0.0";
}

function registryRef(bbVersion: string): string {
  return bbVersion === "0.0.0" ? "main" : `desktop-v${bbVersion}`;
}

function componentsJsonSource(bbVersion: string): string {
  return `${JSON.stringify(
    {
      $schema: "https://ui.shadcn.com/schema.json",
      style: "new-york",
      tsx: true,
      tailwind: {
        config: "",
        css: "app.css",
        baseColor: "neutral",
        cssVariables: true,
      },
      aliases: {
        components: "@/components",
        ui: "@/components/ui",
        lib: "@/lib",
        utils: "@/lib/utils",
        hooks: "@/hooks",
      },
      registries: {
        "@bb": `https://raw.githubusercontent.com/get-bb/bb/${registryRef(bbVersion)}/packages/plugin-registry/r/{name}.json`,
      },
    },
    null,
    2,
  )}\n`;
}

function serverEntrySource(packageName: string): string {
  const id = derivePluginId(packageName);
  const name = pluginNameOf(packageName);
  return `// ${packageName} — a BB plugin backend entry.
//
// The default export is a factory that receives the plugin API. BB supplies
// the tiny defineRpcContract runtime helper; the API type remains type-only.
//
// The example is a todo list. One store in bb.storage.kv serves three
// surfaces: the Example todos page (app.tsx, over RPC), the \`bb ${id}\` CLI
// command (below), and the skill in skills/example-todos/SKILL.md that tells
// agents how to use that command. A write from any surface publishes a realtime signal so
// every open page refetches.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const todoSchema = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  createdAt: z.string(),
});
export type Todo = z.infer<typeof todoSchema>;

// Both schemas run at the wire boundary. Handler input/output are inferred
// from the shared contract; app.tsx imports only its type.
export const rpcContract = defineRpcContract({
  todos_list: {
    input: z.null(),
    output: z.object({ todos: z.array(todoSchema) }),
  },
  todos_add: {
    input: z.object({ title: z.string().trim().min(1).max(200) }),
    output: todoSchema,
  },
  todos_set_done: {
    input: z.object({ id: z.string(), done: z.boolean() }),
    output: todoSchema,
  },
  todos_remove: {
    input: z.object({ id: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
});

/** Realtime channel app.tsx listens on; the payload is the todo count. */
const TODOS_CHANGED = "todos-changed";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  // Declarative settings — rendered in BB's settings UI and editable with
  // \`bb plugin config ${id}\`. Add \`secret: true\` for values like API keys.
  // Settings are read once per load: reload the plugin after changing one.
  const settings = bb.settings.define({
    showDone: {
      type: "boolean",
      label: "Show completed todos",
      default: true,
    },
  });
  const { showDone } = await settings.get();

  // Namespaced key-value storage in bb.db (JSON values, up to 256KB each).
  // For bigger or relational data use bb.storage.database().
  async function readTodos(): Promise<Todo[]> {
    return (await bb.storage.kv.get<Todo[]>("todos")) ?? [];
  }
  async function writeTodos(todos: Todo[]): Promise<void> {
    await bb.storage.kv.set("todos", todos);
    // Ephemeral broadcast to every connected client; nothing is persisted.
    bb.realtime.publish(TODOS_CHANGED, { count: todos.length });
  }

  async function listTodos(): Promise<Todo[]> {
    const todos = await readTodos();
    return showDone ? todos : todos.filter((todo) => !todo.done);
  }
  async function addTodo(title: string): Promise<Todo> {
    const todo: Todo = {
      id: randomUUID().slice(0, 8),
      title,
      done: false,
      createdAt: new Date().toISOString(),
    };
    await writeTodos([...(await readTodos()), todo]);
    return todo;
  }
  async function setTodoDone(id: string, done: boolean): Promise<Todo | null> {
    const todos = await readTodos();
    const todo = todos.find((candidate) => candidate.id === id);
    if (todo === undefined) return null;
    todo.done = done;
    await writeTodos(todos);
    return todo;
  }
  async function removeTodo(id: string): Promise<boolean> {
    const todos = await readTodos();
    const remaining = todos.filter((todo) => todo.id !== id);
    if (remaining.length === todos.length) return false;
    await writeTodos(remaining);
    return true;
  }

  bb.rpc.register(rpcContract, {
    todos_list: async () => ({ todos: await listTodos() }),
    todos_add: ({ title }) => addTodo(title),
    todos_set_done: async ({ id, done }) => {
      const todo = await setTodoDone(id, done);
      if (todo === null) throw new Error(\`No todo with id \${id}\`);
      return todo;
    },
    todos_remove: async ({ id }) => ({ removed: await removeTodo(id) }),
  });

  // The \`bb ${id}\` command: what agents (and you) use from a shell. Parsing
  // argv is plugin-owned; \`commands\` is metadata BB renders into help and
  // the generated plugin-commands skill without running plugin code.
  const usage = [
    "Usage:",
    "  bb ${id} list [--json]",
    "  bb ${id} add <title> [--json]",
    "  bb ${id} done <todo-id> [--json]",
    "  bb ${id} undo <todo-id> [--json]",
    "  bb ${id} remove <todo-id> [--json]",
  ].join("\\n");
  function formatTodo(todo: Todo): string {
    return \`[\${todo.done ? "x" : " "}] \${todo.id}  \${todo.title}\`;
  }
  bb.cli.register({
    name: "${id}",
    summary: "Manage the ${name} plugin's example todo list",
    commands: [
      { name: "list", summary: "List todos", usage: "bb ${id} list [--json]" },
      {
        name: "add",
        summary: "Add a todo",
        usage: "bb ${id} add <title> [--json]",
      },
      {
        name: "done",
        summary: "Mark a todo done",
        usage: "bb ${id} done <todo-id> [--json]",
      },
      {
        name: "undo",
        summary: "Mark a todo not done",
        usage: "bb ${id} undo <todo-id> [--json]",
      },
      {
        name: "remove",
        summary: "Remove a todo",
        usage: "bb ${id} remove <todo-id> [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });
      const notFound = (missingId: string) => ({
        exitCode: 1,
        stderr: \`No todo with id \${missingId}. Run "bb ${id} list" to see ids.\`,
      });
      const todoId = args[0];
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "list": {
          const todos = await listTodos();
          return reply(
            todos,
            todos.length === 0 ? "No todos." : todos.map(formatTodo).join("\\n"),
          );
        }
        case "add": {
          const title = args.join(" ").trim();
          if (title === "") break;
          const todo = await addTodo(title);
          return reply(todo, \`Added \${formatTodo(todo)}\`);
        }
        case "done":
        case "undo": {
          if (todoId === undefined || args.length !== 1) break;
          const todo = await setTodoDone(todoId, command === "done");
          if (todo === null) return notFound(todoId);
          return reply(todo, formatTodo(todo));
        }
        case "remove": {
          if (todoId === undefined || args.length !== 1) break;
          if (!(await removeTodo(todoId))) return notFound(todoId);
          return reply({ removed: true, id: todoId }, \`Removed \${todoId}\`);
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  // Cleanup on reload/disable/shutdown; hooks run LIFO. The sanctioned place
  // to clear timers and close connections.
  bb.onDispose(() => {
    bb.log.info("disposed");
  });

  // Long-lived background work: starts after load, gets an AbortSignal on
  // reload/disable/shutdown, and restarts with backoff if it crashes. Sleeps
  // must wake on abort — a plain setTimeout sleeps through the stop window
  // and the plugin reports "degraded (service did not stop)" on reload.
  // bb.background.service("worker", {
  //   async start(signal) {
  //     while (!signal.aborted) {
  //       await new Promise((resolve) => {
  //         const timer = setTimeout(resolve, 60_000);
  //         signal.addEventListener(
  //           "abort",
  //           () => { clearTimeout(timer); resolve(undefined); },
  //           { once: true },
  //         );
  //       });
  //     }
  //   },
  // });
}
`;
}

function appEntrySource(packageName: string): string {
  const id = derivePluginId(packageName);
  return `// ${packageName} — a BB plugin frontend entry.
//
// Compiled by \`bb plugin build\` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never bundled),
// so this file must be loaded by BB, not imported directly.
//
// The components under components/ui/ are YOURS: vendored source (shadcn
// model), edit freely. Add more from the BB registry with
// \`npx shadcn add @bb/<name>\` (see components.json) — dropdowns, tables,
// the full shadcn set, version-matched to this BB install. Run
// \`npm install\` once before \`bb plugin build\`.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, Todo } from "./server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** The todo list, kept current by the server's "todos-changed" signal. */
function useTodos() {
  const rpc = useRpc<typeof rpcContract>();
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("todos_list").then((result) => {
      setTodos(result.todos);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  // server.ts publishes after every write — from this page, another window,
  // or \`bb ${id} add\` run by an agent — so the list never goes stale.
  useRealtime("todos-changed", refetch);
  return { rpc, todos, error, report, refetch };
}

function TodoRow({
  todo,
  onToggle,
  onRemove,
}: {
  todo: Todo;
  onToggle: (done: boolean) => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5 text-sm">
      <Checkbox
        checked={todo.done}
        onCheckedChange={(checked) => onToggle(checked === true)}
        aria-label={\`Mark "\${todo.title}" \${todo.done ? "not done" : "done"}\`}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          todo.done && "text-muted-foreground line-through",
        )}
      >
        {todo.title}
      </span>
      <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
        {todo.id}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-foreground"
        aria-label={\`Remove "\${todo.title}"\`}
        onClick={onRemove}
      >
        <Icon name="Trash2" className="size-4" />
      </Button>
    </li>
  );
}

/** The dashed box BB's own list pages use for loading and empty states. */
function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

// Tailwind classes compile against the host theme's live CSS variables —
// derive colors from the theme tokens, never hardcoded grays. The frame
// (scrolling page, centered column) matches BB's own nav-panel pages.
function TodosPage() {
  const { rpc, todos, error, report, refetch } = useTodos();
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = title.trim();
    if (next === "" || pending) return;
    setPending(true);
    try {
      await rpc.call("todos_add", { title: next });
      setTitle("");
      refetch();
    } catch (cause) {
      report(cause);
    } finally {
      setPending(false);
    }
  };
  const doneCount = todos?.filter((todo) => todo.done).length ?? 0;
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <p className="text-sm text-muted-foreground">
          Agents keep this list with <code>bb ${id}</code>; the skill in{" "}
          <code>skills/example-todos</code> tells them how.
        </p>
        <form onSubmit={add} className="mt-4 flex items-center gap-2">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs doing?"
            aria-label="New todo"
          />
          <Button type="submit" disabled={pending || title.trim() === ""}>
            <Icon name="Plus" className="size-4" />
            Add
          </Button>
        </form>
        {error === null ? null : (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="mt-4">
          {todos === null ? (
            <EmptyState>Loading todos…</EmptyState>
          ) : todos.length === 0 ? (
            <EmptyState>
              Nothing to do. Add one above, or run{" "}
              <code>bb ${id} add "Ship it"</code>.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-4">
              {todos.map((todo) => (
                <TodoRow
                  key={todo.id}
                  todo={todo}
                  onToggle={(done) => {
                    rpc
                      .call("todos_set_done", { id: todo.id, done })
                      .then(refetch, report);
                  }}
                  onRemove={() => {
                    rpc
                      .call("todos_remove", { id: todo.id })
                      .then(refetch, report);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
        {todos !== null && todos.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {doneCount} of {todos.length} done
          </p>
        ) : null}
      </div>
    </div>
  );
}

// The default export must be definePluginApp(...); BB interprets it after
// loading the bundle. navPanel adds a page to the left sidebar; register
// other UI under app.slots and composer actions, plus-menu rows, banners, or
// rich-text rules with app.composer.customize(...) (see the bb guide's
// plugins chapter).
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "example-todos",
    title: "Example todos",
    icon: "ListTodo",
    // Routed at /plugins/${id}/example-todos; the component receives the
    // remainder as \`subPath\` for deep links within the page.
    path: "example-todos",
    component: TodosPage,
  });
});
`;
}

function tsconfigSource(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        lib: ["ES2022", "DOM"],
        types: ["node"],
        paths: { "@/*": ["./*"] },
        noEmit: true,
        skipLibCheck: false,
      },
      include: ["server.ts", "app.tsx", "components", "lib", "hooks"],
    },
    null,
    2,
  )}\n`;
}

function skillSource(packageName: string): string {
  const id = derivePluginId(packageName);
  const name = pluginNameOf(packageName);
  return `---
name: example-todos
description: Read and update the ${name} plugin's example todo list with the \`bb ${id}\` CLI. Use when the user asks to add, complete, reopen, remove, or review todos, or when the steps of a task should be tracked as todos.
---

# Example todos

The ${name} plugin keeps one todo list. The Example todos page in the BB sidebar and
the \`bb ${id}\` command read and write the same list, so a change from either
side shows in the other at once.

## Commands

| Command | Effect |
| --- | --- |
| \`bb ${id} list\` | Show every todo with its id. \`[x]\` marks a done todo. |
| \`bb ${id} add <title>\` | Add a todo. Quote a title that has spaces. |
| \`bb ${id} done <todo-id>\` | Mark a todo done. |
| \`bb ${id} undo <todo-id>\` | Mark a todo not done. |
| \`bb ${id} remove <todo-id>\` | Delete a todo. |

Add \`--json\` to any command when the output drives code.

## Procedure

1. Run \`bb ${id} list\` before you change the list. Use the ids it prints;
   never guess an id.
2. Add todos one at a time with a short title that starts with a verb:
   \`bb ${id} add "Write the release notes"\`.
3. When you finish a todo, mark it done: \`bb ${id} done <todo-id>\`. Do not
   remove a todo to mark it done.
4. Remove a todo only when the user asks for it or when it duplicates
   another todo.
5. End with a short summary of what you added, completed, or removed.

## Rules

- Change the list only through \`bb ${id}\`. Do not edit bb.db or the plugin's
  storage directly.
- A non-zero exit with "No todo with id" means the id is stale: run
  \`bb ${id} list\` again.
`;
}

function pluginOverviewSource(packageName: string): string {
  const id = derivePluginId(packageName);
  return `Keep a todo list beside the work it belongs to, in the sidebar and in
your agent threads.

## What you get

- An **Example todos** page in the left sidebar that adds, completes, and
  removes todos.
- A \`bb ${id}\` command that does the same from a terminal.
- Live updates, so a change made in one place reaches every open page at once.

## How it works

The todos live in this plugin's own storage on the BB server, one list per
installation. Nothing leaves the machine, and the plugin needs no account, API
key, or external service.

## For agents

The bundled skill tells an agent to read the list with \`bb ${id} list\`, add
one todo at a time with \`bb ${id} add\`, and close finished work with
\`bb ${id} done\`.
`;
}

function readmeSource(packageName: string): string {
  const id = derivePluginId(packageName);
  return `# ${packageName}

A BB plugin that keeps a todo list. It shows every surface a plugin can own:

- \`server.ts\` — the backend: a todo store in \`bb.storage.kv\`, RPC methods
  for the page, a \`bb ${id}\` CLI command, a setting, and a realtime signal
  that keeps every open page current.
- \`app.tsx\` — the frontend: an **Example todos** page in the left sidebar
  (\`app.slots.navPanel\`) built from the vendored components.
- \`skills/example-todos/SKILL.md\` — a skill that tells agents how to keep the list
  with \`bb ${id}\`. BB imports it into agent threads automatically.
- \`PLUGIN_OVERVIEW.md\` — the store listing text: a longer version of
  \`bb.description\` that the plugin detail page shows under it. See
  [Store listing](#store-listing).

Try it: install the plugin, open **Example todos** in the sidebar, then run
\`bb ${id} add "Ship it"\` in a terminal. The page updates at once.

## UI components

\`components/ui/\` is vendored source you own (the shadcn model): edit the
files freely — they never update out from under you. Add more from the BB
component registry (the full shadcn set, version-matched to your BB install
via the pinned ref in \`components.json\`):

\`\`\`
npx shadcn add @bb/select @bb/table
\`\`\`

Run \`npm install\` once before \`bb plugin build\` — the vendored components'
npm deps bundle into your dist. React, and BB-shimmed packages like the
radix portal primitives and \`sonner\` (\`import { toast } from "sonner"\`
reaches BB's own toaster), are provided by the BB app at runtime and never
bundled. Every shimmed package is declared in \`devDependencies\` at the
host's version so those imports typecheck; keep them there (never in
\`dependencies\`, which would bundle a second copy), and \`bb plugin types\`
repins them alongside the SDK. Ship \`dist/\` (npm tarball or committed for
git installs) so people installing your plugin never need npm.

## Manifest

\`package.json\` is the plugin manifest. Notable fields:

- \`bb.server\` — backend entry (required).
- \`bb.app\` — frontend entry. Delete it, \`app.tsx\`, \`components/\`,
  \`hooks/\`, and \`lib/\` for a headless plugin.
- \`bb.skills\` — skill roots; omitted here, so BB reads \`skills/\`. Each
  directory with a \`SKILL.md\` is one skill, named after the directory.
- \`bb.name\` and \`bb.description\` — required human-facing identity.
- \`bb.branding\` — required; declare \`icon\` as a BB icon name or a
  plugin-relative compact SVG, or declare \`logo.light\` (with optional
  \`logo.dark\`). Logo assets must be relative \`.svg\`, \`.png\`, or
  \`.webp\` files.
- \`engines.bb\` — supported bb app version range.
- \`engines.bbPluginSdk\` — the lowest plugin SDK you need (scaffold:
  \`>=${PLUGIN_SDK_VERSION}\`). BB reads this as a floor, not a ceiling: a later
  SDK in the same major still loads your plugin.
- \`dependencies\` — every package your source imports that BB does not provide.
  \`bb plugin build\` inlines them into \`dist/\`, and git installs resolve this
  list alone, so a build-required package here rather than in
  \`devDependencies\` is what keeps your plugin installable. \`devDependencies\`
  is for types and tooling only (BB shims React, the portal primitives, and
  \`@get-bb/plugin-sdk\` at runtime — never bundle them).

Run \`bb plugin build\` before publishing git/npm installs. It writes
\`dist/server.js\` + \`server.meta.json\` and \`app.js\` / \`app.css\` /
\`app.meta.json\`. Each \`*.meta.json\` stamps SDK major/version,
\`artifactFormatVersion\`, \`pluginId\`, \`pluginVersion\`, and
\`builtWith\` so managed installs can verify the artifacts.

## Store listing

Two texts describe the plugin in the store. \`bb.description\` in package.json
is the one-sentence hook on every browse card and the lead paragraph on the
detail page; keep it under about 140 characters. \`PLUGIN_OVERVIEW.md\` is the
same claim at length, shown in an Overview section under that paragraph.
Rewrite the scaffold's copy for your plugin, and update it whenever
\`bb.description\` changes, so the two never disagree.

The submission to the public BB Community marketplace requires the file. Keep
it under 4000 characters (aim for 700 to 1800) and use headings, paragraphs,
emphasis, code, blockquotes, lists, thematic breaks, and absolute https links
only — raw HTML, images, tables, footnotes, and task lists are rejected. Do
not open with a \`#\` title or repeat \`bb.description\` verbatim; the page
shows both directly above.

## Install

From this directory (\`bb plugin new\` already ran the install; a fresh clone
needs it):

\`\`\`
npm install
bb plugin install .
\`\`\`

After editing sources, reload:

\`\`\`
bb plugin reload ${id}
\`\`\`

Or let \`bb plugin dev\` rebuild and reload on every save.

## Configure

\`\`\`
bb plugin config ${id}
bb plugin config ${id} set showDone false
bb plugin reload ${id}
\`\`\`

## Types & API reference

The plugin API ships as the npm package \`@get-bb/plugin-sdk\`, pinned to an
exact version in \`devDependencies\` (\`${PLUGIN_SDK_VERSION}\` — the SDK of the BB
that scaffolded this plugin). After \`npm install\`, the full surface is on disk
at:

\`\`\`
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts      # backend
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts  # frontend
\`\`\`

Your editor and \`tsc\` resolve \`@get-bb/plugin-sdk\` there through ordinary node
resolution — no path mapping. These are readable declarations: open them for an
exact signature.

The SDK surface grows with every BB release, so the pin has to track the BB you
actually run:

\`\`\`
bb plugin types          # sync this plugin's SDK surface to the running BB
bb plugin types --check  # CI: fail when it does not match
\`\`\`

Ask BB to write plugins for you: the \`bb-plugin-authoring\` skill documents
the whole surface with examples.

Confused by the API, or need something the types don't explain? Clone the BB
repo and read the source: <https://github.com/get-bb/bb>.
`;
}

export async function scaffoldPlugin(args: ScaffoldPluginArgs): Promise<void> {
  const { targetDir, packageName, bbVersion } = args;
  try {
    await mkdir(targetDir, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`directory already exists: ${targetDir}`);
    }
    throw error;
  }
  await writeFile(
    join(targetDir, "package.json"),
    JSON.stringify(
      {
        name: packageName,
        version: "0.1.0",
        type: "module",
        engines: {
          bb: enginesRange(bbVersion),
          bbPluginSdk: `>=${PLUGIN_SDK_VERSION}`,
        },
        bb: {
          name: pluginNameOf(packageName),
          description: "A BB plugin with an example todo list.",
          branding: { icon: "ListTodo" },
          server: "./server.ts",
          app: "./app.tsx",
        },
        dependencies: {
          ...PLUGIN_STARTER_DEPENDENCIES,
          zod: "^4.3.6",
        },
        devDependencies: {
          "@get-bb/plugin-sdk": PLUGIN_SDK_VERSION,
          "@types/better-sqlite3": "^7.6.12",
          "@types/node": "^22.0.0",
          "@types/react": "^19.0.0",
          "@types/react-dom": "^19.0.0",
          "better-sqlite3": "^12.0.0",
          "cron-parser": "^5.5.0",
          hono: "^4.11.9",
          typescript: "^5.7.0",
          ...PLUGIN_SHIMMED_TYPE_DEPENDENCIES,
        },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(join(targetDir, "server.ts"), serverEntrySource(packageName));
  await writeFile(join(targetDir, "app.tsx"), appEntrySource(packageName));
  await writeFile(join(targetDir, "tsconfig.json"), tsconfigSource());
  for (const file of PLUGIN_STARTER_FILES) {
    const filePath = join(targetDir, file.target);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content);
  }
  await writeFile(
    join(targetDir, "components.json"),
    componentsJsonSource(bbVersion),
  );
  const skillDir = join(targetDir, "skills", "example-todos");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), skillSource(packageName));
  await writeFile(join(targetDir, ".gitignore"), "dist/\nnode_modules/\n");
  await writeFile(join(targetDir, "README.md"), readmeSource(packageName));
  await writeFile(
    join(targetDir, "PLUGIN_OVERVIEW.md"),
    pluginOverviewSource(packageName),
  );
}
