import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  buildPluginApp,
  buildPluginHost,
  buildPluginServer,
  resolvePluginBuildToolchain,
} from "@bb/plugin-build";
import { isPluginOwnedIconPath, pluginPackageJsonSchema } from "@bb/domain";
import { z } from "zod";
import {
  BUNDLED_MARKETPLACE_FILENAME,
  BUNDLED_MARKETPLACE_GENERATED_DIRECTORY,
} from "../src/services/plugin-catalog/bundled-marketplace-paths.js";
import {
  BUILTIN_PLUGINS_DIRECTORY_NAME,
  BUNDLED_PLUGINS,
  resolveBuiltinPluginRootPathForModuleDir,
  type BundledPluginDefinition,
} from "../src/services/plugins/builtin-registry.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, "..");
const sourceModuleDir = path.resolve(serverRoot, "src", "services", "plugins");
const targetRoot = path.resolve(
  serverRoot,
  "dist",
  BUILTIN_PLUGINS_DIRECTORY_NAME,
);
const bundledMarketplaceManifestPath = path.resolve(
  serverRoot,
  "src",
  "generated",
  BUNDLED_MARKETPLACE_GENERATED_DIRECTORY,
  BUNDLED_MARKETPLACE_FILENAME,
);
const bbAppPackageJsonPath = path.resolve(
  serverRoot,
  "..",
  "..",
  "packages",
  "bb-app",
  "package.json",
);

const RUNTIME_DIRS = ["dist", "skills"] as const;

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readAuthoritativeBbVersion(): Promise<string> {
  try {
    const json: unknown = JSON.parse(
      await readFile(bbAppPackageJsonPath, "utf8"),
    );
    const parsed = z.object({ version: z.string().min(1) }).safeParse(json);
    if (parsed.success) return parsed.data.version;
  } catch (error) {
    throw new Error(
      `cannot read authoritative bb version from ${bbAppPackageJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  throw new Error(
    `cannot read authoritative bb version from ${bbAppPackageJsonPath}`,
  );
}

async function copyIfExists(from: string, to: string): Promise<void> {
  if (await exists(from)) {
    await cp(from, to, { recursive: true });
  }
}

async function writeRuntimePackageJson(args: {
  sourceRoot: string;
  targetDir: string;
}): Promise<void> {
  const raw = await readFile(
    path.join(args.sourceRoot, "package.json"),
    "utf8",
  );
  const packageJson = pluginPackageJsonSchema.parse(JSON.parse(raw));
  await writeFile(
    path.join(args.targetDir, "package.json"),
    `${JSON.stringify(
      {
        ...packageJson,
        bb: {
          ...packageJson.bb,
          server: "./dist/server.js",
          ...(packageJson.bb.app === undefined ? {} : { app: "./dist/app.js" }),
          ...(packageJson.bb.host === undefined
            ? {}
            : { host: "./dist/host.js" }),
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function runStageAssets(sourceRoot: string): Promise<void> {
  const scriptPath = path.join(sourceRoot, "scripts", "stage-assets.mjs");
  if (!(await exists(scriptPath))) return;
  await import(pathToFileURL(scriptPath).href);
}

async function copyBuiltinPlugin(args: {
  bbVersion: string;
  build: boolean;
  name: string;
  sourceRoot: string;
  targetRoot: string;
}): Promise<void> {
  if (args.build) {
    const toolchain = await resolvePluginBuildToolchain(
      path.join(serverRoot, "node_modules", ".bb-toolchain"),
    );
    await buildPluginServer(args.sourceRoot, args.bbVersion, toolchain);
    const raw = await readFile(
      path.join(args.sourceRoot, "package.json"),
      "utf8",
    );
    const packageJson = pluginPackageJsonSchema.parse(JSON.parse(raw));
    if (packageJson.bb.app !== undefined) {
      await buildPluginApp(args.sourceRoot, args.bbVersion, toolchain);
    }
    if (packageJson.bb.host !== undefined) {
      await buildPluginHost(args.sourceRoot, args.bbVersion, toolchain);
    }
    await runStageAssets(args.sourceRoot);
  }

  const targetDir = path.join(args.targetRoot, args.name);
  await mkdir(targetDir, { recursive: true });

  await writeRuntimePackageJson({
    sourceRoot: args.sourceRoot,
    targetDir,
  });
  for (const dirName of RUNTIME_DIRS) {
    await copyIfExists(
      path.join(args.sourceRoot, dirName),
      path.join(targetDir, dirName),
    );
  }
  const packageJson = pluginPackageJsonSchema.parse(
    JSON.parse(
      await readFile(path.join(args.sourceRoot, "package.json"), "utf8"),
    ),
  );
  const logo = packageJson.bb.branding.logo;
  const compactIcon = isPluginOwnedIconPath(packageJson.bb.branding.icon ?? "")
    ? packageJson.bb.branding.icon
    : undefined;
  const declaredIcons = Object.values(
    packageJson.bb.branding.experimental_icons ?? {},
  );
  for (const asset of [
    compactIcon,
    logo?.light,
    logo?.dark,
    ...declaredIcons,
  ]) {
    if (asset === undefined) continue;
    const sourcePath = path.resolve(args.sourceRoot, asset);
    const targetPath = path.resolve(targetDir, asset);
    if (
      (sourcePath !== args.sourceRoot &&
        !sourcePath.startsWith(args.sourceRoot + path.sep)) ||
      (targetPath !== targetDir && !targetPath.startsWith(targetDir + path.sep))
    ) {
      throw new Error(
        `manifest branding asset escapes plugin directory: ${asset}`,
      );
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath);
  }
}

export async function copyBuiltinPlugins(args: {
  bbVersion: string;
  build?: boolean;
  plugins?: readonly Pick<BundledPluginDefinition, "name">[];
  sourceModuleDir?: string;
  targetRoot?: string;
}): Promise<void> {
  const resolvedSourceModuleDir = args.sourceModuleDir ?? sourceModuleDir;
  const resolvedTargetRoot = args.targetRoot ?? targetRoot;
  const plugins = args.plugins ?? BUNDLED_PLUGINS;
  const build = args.build ?? true;

  await rm(resolvedTargetRoot, { recursive: true, force: true });
  await mkdir(resolvedTargetRoot, { recursive: true });
  await cp(
    bundledMarketplaceManifestPath,
    path.join(resolvedTargetRoot, BUNDLED_MARKETPLACE_FILENAME),
  );

  for (const plugin of plugins) {
    await copyBuiltinPlugin({
      bbVersion: args.bbVersion,
      build,
      name: plugin.name,
      sourceRoot: resolveBuiltinPluginRootPathForModuleDir({
        moduleDir: resolvedSourceModuleDir,
        name: plugin.name,
      }),
      targetRoot: resolvedTargetRoot,
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const targetFlagIndex = process.argv.indexOf("--target");
  const targetArg =
    targetFlagIndex !== -1 ? process.argv[targetFlagIndex + 1] : undefined;
  await copyBuiltinPlugins({
    bbVersion: await readAuthoritativeBbVersion(),
    ...(targetArg !== undefined ? { targetRoot: path.resolve(targetArg) } : {}),
  });
}
