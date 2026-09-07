import { createUpdatedPackageContent } from "./lib/package-version.mjs";
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareSemver, resolveVersionArgument } from "./lib/semver.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const USAGE =
  "Usage: node scripts/bump-version.mjs <new-version>|--patch|--minor|--major";
const defaultRepoRoot = resolve(dirname(scriptPath), "..");
const packageTargets = [
  {
    label: "bb-app",
    path: "packages/bb-app/package.json",
  },
  {
    label: "@bb/desktop",
    path: "apps/desktop/package.json",
  },
];
const defaultFileSystem = {
  readFile,
  rename,
  unlink,
  writeFile,
};

function parsePackageJson({ content, packagePath }) {
  const packageJson = JSON.parse(content);

  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    Array.isArray(packageJson)
  ) {
    throw new Error(`Invalid package JSON object in ${packagePath}`);
  }

  if (typeof packageJson.version !== "string") {
    throw new Error(`Missing string version field in ${packagePath}`);
  }

  return packageJson;
}

async function readPackageTarget({ fileSystem, repoRoot, target }) {
  const absolutePath = resolve(repoRoot, target.path);
  const content = await fileSystem.readFile(absolutePath, "utf8");
  const packageJson = parsePackageJson({
    content,
    packagePath: target.path,
  });

  return {
    absolutePath,
    content,
    packageJson,
    target,
  };
}

function findMaxCurrentVersion(packageReads) {
  return packageReads.reduce((maxVersion, packageRead) => {
    const currentVersion = packageRead.packageJson.version;

    return compareSemver(currentVersion, maxVersion) > 0
      ? currentVersion
      : maxVersion;
  }, packageReads[0].packageJson.version);
}

function createPackageVersionSummary(packageReads) {
  return packageReads
    .map(
      (packageRead) =>
        `${packageRead.target.label}=${packageRead.packageJson.version}`,
    )
    .join(" ");
}

async function writePackageTargetsAtomically({ fileSystem, updates }) {
  const preparedUpdates = [];
  const renamedUpdates = [];

  try {
    for (const update of updates) {
      const temporaryPath = resolve(
        dirname(update.absolutePath),
        `.tmp-${process.pid}-${randomUUID()}-${update.target.label.replaceAll(
          "/",
          "-",
        )}.json`,
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

export async function bumpVersion(options) {
  const repoRoot = options.repoRoot;
  const args = options.args;
  const log = options.log;
  const fileSystem = options.fileSystem ?? defaultFileSystem;

  if (args.length !== 1) {
    throw new Error(USAGE);
  }

  const packageReads = await Promise.all(
    packageTargets.map((target) =>
      readPackageTarget({ fileSystem, repoRoot, target }),
    ),
  );
  const maxCurrentVersion = findMaxCurrentVersion(packageReads);
  const newVersion = resolveVersionArgument({
    argument: args[0],
    currentVersion: maxCurrentVersion,
    usage: USAGE,
  });

  if (compareSemver(newVersion, maxCurrentVersion) <= 0) {
    throw new Error(
      `New version ${newVersion} must be greater than current max ${maxCurrentVersion} across ${createPackageVersionSummary(packageReads)}.`,
    );
  }

  const updates = packageReads.map((packageRead) => ({
    ...packageRead,
    nextContent: createUpdatedPackageContent({
      content: packageRead.content,
      packageJson: packageRead.packageJson,
      newVersion,
    }),
  }));

  await writePackageTargetsAtomically({ fileSystem, updates });
  log(`Bumped: bb-app + @bb/desktop → ${newVersion}`);
}

async function main() {
  const repoRoot = process.env.BB_BUMP_VERSION_REPO_ROOT ?? defaultRepoRoot;

  await bumpVersion({
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
