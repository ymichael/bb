import { createUpdatedPackageContent } from "./lib/package-version.mjs";
// Bumps @get-bb/plugin-sdk in the two files that must always agree:
//
//   packages/domain/src/plugin-sdk-version.ts  (PLUGIN_SDK_VERSION)
//   packages/plugin-sdk/package.json           (version)
//
// The publish job is publish-if-missing (.github/workflows/publish-bb-app.yml,
// job publish-plugin-sdk): it never republishes a version that already exists on
// npm. So any change to the package's published content — dist/, bundled-types/,
// README.md, or a consumer-facing manifest field — needs a new version, or npm
// keeps serving the old content forever. check-npm-version-guard.mjs fails CI
// when that happens and points here.
//
// Both files are written atomically: a temp file per target, then renames, with
// the originals restored if any rename fails. A half-applied bump would leave
// the repo in the exact inconsistent state this script exists to prevent.
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareSemver, resolveVersionArgument } from "./lib/semver.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), "..");
const USAGE =
  "Usage: node scripts/bump-plugin-sdk.mjs <new-version>|--patch|--minor|--major";
const MANIFEST_PATH = "packages/plugin-sdk/package.json";
const VERSION_MODULE_PATH = "packages/domain/src/plugin-sdk-version.ts";

/**
 * Matches the `PLUGIN_SDK_VERSION` export in plugin-sdk-version.ts. Anchored to
 * the export statement rather than the bare string so the long explanatory
 * comment above it — which cites version numbers — is never rewritten.
 */
const VERSION_EXPORT_PATTERN =
  /(export const PLUGIN_SDK_VERSION = ")([^"]+)(";)/u;

const defaultFileSystem = { readFile, rename, unlink, writeFile };

function readManifestVersion({ content, path }) {
  const packageJson = JSON.parse(content);

  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    Array.isArray(packageJson)
  ) {
    throw new Error(`Invalid package JSON object in ${path}`);
  }

  if (typeof packageJson.version !== "string") {
    throw new Error(`Missing string version field in ${path}`);
  }

  return { packageJson, version: packageJson.version };
}

function readModuleVersion({ content, path }) {
  const match = VERSION_EXPORT_PATTERN.exec(content);

  if (match === null) {
    throw new Error(`Could not find the PLUGIN_SDK_VERSION export in ${path}`);
  }

  return match[2];
}

function writeModuleVersion({ content, newVersion }) {
  return content.replace(
    VERSION_EXPORT_PATTERN,
    (_match, prefix, _current, suffix) => `${prefix}${newVersion}${suffix}`,
  );
}

async function writeTargetsAtomically({ fileSystem, updates }) {
  const preparedUpdates = [];
  const renamedUpdates = [];

  try {
    for (const update of updates) {
      const temporaryPath = resolve(
        dirname(update.absolutePath),
        `.tmp-${process.pid}-${randomUUID()}-plugin-sdk-bump`,
      );

      await fileSystem.writeFile(temporaryPath, update.nextContent);
      preparedUpdates.push({ ...update, temporaryPath });
    }

    for (const update of preparedUpdates) {
      await fileSystem.rename(update.temporaryPath, update.absolutePath);
      renamedUpdates.push(update);
    }
  } catch (error) {
    for (const update of [...renamedUpdates].reverse()) {
      await fileSystem.writeFile(update.absolutePath, update.content);
    }

    for (const update of preparedUpdates) {
      await fileSystem.unlink(update.temporaryPath).catch(() => {});
    }

    throw error;
  }
}

export async function bumpPluginSdk(options) {
  const repoRoot = options.repoRoot;
  const args = options.args;
  const log = options.log;
  const fileSystem = options.fileSystem ?? defaultFileSystem;

  if (args.length !== 1) {
    throw new Error(USAGE);
  }

  const manifestAbsolutePath = resolve(repoRoot, MANIFEST_PATH);
  const moduleAbsolutePath = resolve(repoRoot, VERSION_MODULE_PATH);
  const [manifestContent, moduleContent] = await Promise.all([
    fileSystem.readFile(manifestAbsolutePath, "utf8"),
    fileSystem.readFile(moduleAbsolutePath, "utf8"),
  ]);

  const { packageJson, version: manifestVersion } = readManifestVersion({
    content: manifestContent,
    path: MANIFEST_PATH,
  });
  const moduleVersion = readModuleVersion({
    content: moduleContent,
    path: VERSION_MODULE_PATH,
  });

  // Drifted sources have no single "current" version to bump from, and picking
  // one would silently pin the other. Make the operator resolve it.
  if (manifestVersion !== moduleVersion) {
    throw new Error(
      `Version mismatch before bump: ${MANIFEST_PATH}=${manifestVersion} ${VERSION_MODULE_PATH}=${moduleVersion}. Set both to the same version, then bump.`,
    );
  }

  const newVersion = resolveVersionArgument({
    argument: args[0],
    currentVersion: manifestVersion,
    usage: USAGE,
  });

  if (compareSemver(newVersion, manifestVersion) <= 0) {
    throw new Error(
      `New version ${newVersion} must be greater than current ${manifestVersion}.`,
    );
  }

  await writeTargetsAtomically({
    fileSystem,
    updates: [
      {
        absolutePath: manifestAbsolutePath,
        content: manifestContent,
        nextContent: createUpdatedPackageContent({
          content: manifestContent,
          packageJson,
          newVersion,
        }),
      },
      {
        absolutePath: moduleAbsolutePath,
        content: moduleContent,
        nextContent: writeModuleVersion({
          content: moduleContent,
          newVersion,
        }),
      },
    ],
  });

  log(
    `Bumped: @get-bb/plugin-sdk ${manifestVersion} → ${newVersion} (${MANIFEST_PATH} + ${VERSION_MODULE_PATH})`,
  );
}

async function main() {
  const repoRoot = process.env.BB_BUMP_PLUGIN_SDK_REPO_ROOT ?? defaultRepoRoot;

  await bumpPluginSdk({
    args: process.argv.slice(2),
    log: console.log,
    repoRoot,
  });
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);

    console.error(message);
    process.exitCode = 1;
  });
}
