import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  PLUGIN_SERVER_EXTERNALS,
  RUNTIME_SLOT_BY_SPECIFIER,
  SHIMMED_TYPE_PACKAGES,
} from "@bb/plugin-build";
import { scaffoldPlugin } from "@bb/templates/plugin-scaffold";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const DIRS_WITHOUT_BUNDLED_SOURCE = new Set([
  "node_modules",
  "dist",
  "types",
  "skills",
]);

async function generatedSourceFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!DIRS_WITHOUT_BUNDLED_SOURCE.has(entry.name)) {
          await walk(entryPath);
        }
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.push(entryPath);
      }
    }
  }
  await walk(rootDir);
  return files;
}

function importedSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (
      specifier === undefined ||
      specifier.startsWith(".") ||
      specifier.startsWith("@/") ||
      specifier.startsWith("node:")
    ) {
      continue;
    }
    specifiers.add(specifier);
  }
  return [...specifiers];
}

function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : (segments[0] ?? specifier);
}

const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
const pluginSdkRoot = join(repoRoot, "packages", "plugin-sdk");

async function backendTestHarnessImports(): Promise<string[]> {
  const harnessDir = join(pluginSdkRoot, "src", "testing");
  const packages = new Set<string>();
  for (const entry of await readdir(harnessDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const source = await readFile(join(harnessDir, entry.name), "utf8");
    for (const specifier of importedSpecifiers(source)) {
      packages.add(packageNameOf(specifier));
    }
  }
  return [...packages];
}

async function sdkOptionalPeers(): Promise<Set<string>> {
  const manifest: { peerDependencies?: Record<string, string> } = JSON.parse(
    await readFile(join(pluginSdkRoot, "package.json"), "utf8"),
  );
  return new Set(Object.keys(manifest.peerDependencies ?? {}));
}

async function scaffoldWithDependencies(workDir: string): Promise<{
  targetDir: string;
  dependencies: string[];
  devDependencies: string[];
}> {
  const packageName = "bb-plugin-deps";
  const targetDir = join(workDir, packageName);
  await scaffoldPlugin({
    targetDir,
    packageName,
    bbVersion: "0.9.0",
  });
  const manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8"));
  return {
    targetDir,
    dependencies: Object.keys(manifest.dependencies ?? {}),
    devDependencies: Object.keys(manifest.devDependencies ?? {}),
  };
}

describe("scaffold dependency classification", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "bb-scaffold-deps-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("declares every bundled import as a dependency", async () => {
    const { targetDir, dependencies } = await scaffoldWithDependencies(workDir);

    const misdeclared: string[] = [];
    for (const file of await generatedSourceFiles(targetDir)) {
      for (const specifier of importedSpecifiers(
        await readFile(file, "utf8"),
      )) {
        if (specifier in RUNTIME_SLOT_BY_SPECIFIER) continue;
        const packageName = packageNameOf(specifier);
        if (PLUGIN_SERVER_EXTERNALS.includes(packageName)) continue;
        if (dependencies.includes(packageName)) continue;
        misdeclared.push(`${relative(targetDir, file)} imports "${specifier}"`);
      }
    }

    expect(misdeclared).toEqual([]);
  });

  it("declares every runtime-shimmed package as a type-only devDependency", async () => {
    const { dependencies, devDependencies } =
      await scaffoldWithDependencies(workDir);

    expect(
      SHIMMED_TYPE_PACKAGES.filter((name) => !devDependencies.includes(name)),
    ).toEqual([]);
    expect(
      SHIMMED_TYPE_PACKAGES.filter((name) => dependencies.includes(name)),
    ).toEqual([]);
  });

  it("declares every optional peer the backend test harness imports", async () => {
    const { dependencies, devDependencies } =
      await scaffoldWithDependencies(workDir);
    const declared = new Set([...dependencies, ...devDependencies]);
    const optionalPeers = await sdkOptionalPeers();

    const missing = (await backendTestHarnessImports()).filter(
      (name) => optionalPeers.has(name) && !declared.has(name),
    );

    expect(missing).toEqual([]);
  });

  it("keeps host-provided packages out of dependencies", async () => {
    const { dependencies } = await scaffoldWithDependencies(workDir);

    expect(
      dependencies.filter(
        (name) =>
          name in RUNTIME_SLOT_BY_SPECIFIER ||
          PLUGIN_SERVER_EXTERNALS.includes(name),
      ),
    ).toEqual([]);
  });
});
