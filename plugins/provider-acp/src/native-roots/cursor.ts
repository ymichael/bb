import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  experimental_resolveVendorPluginRoots,
  type ExperimentalVendorPlugin,
} from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import type { AcpNativeRootsResolver } from "./resolver.js";
import { readJsonFile } from "./shared.js";

const cursorPluginPathsSchema = z.union([z.string(), z.array(z.string())]);

const cursorPluginManifestSchema = z
  .object({
    name: z.string().min(1),
    skills: cursorPluginPathsSchema.optional(),
    commands: cursorPluginPathsSchema.optional(),
  })
  .passthrough();

type CursorPluginManifest = z.infer<typeof cursorPluginManifestSchema>;

interface CursorPluginCandidate {
  completedAtMs: number;
  plugin: ExperimentalVendorPlugin;
}

async function readCursorPluginManifest(
  pluginRootPath: string,
): Promise<CursorPluginManifest | null> {
  for (const relativePath of [
    path.join(".cursor-plugin", "plugin.json"),
    "plugin.json",
  ]) {
    const manifest = await readJsonFile(
      path.join(pluginRootPath, relativePath),
      cursorPluginManifestSchema,
    );
    if (manifest !== null) {
      return manifest;
    }
  }
  return null;
}

function cursorVendorPlugin(
  pluginRootPath: string,
  manifest: CursorPluginManifest,
): ExperimentalVendorPlugin {
  return {
    rootPath: pluginRootPath,
    name: manifest.name,
    origin: "user",
    ...(manifest.skills === undefined ? {} : { skills: manifest.skills }),
    ...(manifest.commands === undefined ? {} : { commands: manifest.commands }),
  };
}

async function readDirectoryEntries(directoryPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function sortedDirectoryEntries(entries: readonly Dirent[]): Dirent[] {
  return entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function resolveLocalCursorPlugins(
  homeDir: string,
): Promise<ExperimentalVendorPlugin[]> {
  const localPluginsPath = path.join(homeDir, ".cursor", "plugins", "local");
  const entries = await readDirectoryEntries(localPluginsPath);

  const plugins: ExperimentalVendorPlugin[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const pluginRootPath = path.join(localPluginsPath, entry.name);
    const stat = await fs.stat(pluginRootPath).catch(() => null);
    if (stat === null || !stat.isDirectory()) {
      continue;
    }
    const manifest = await readCursorPluginManifest(pluginRootPath);
    if (manifest === null) {
      continue;
    }
    plugins.push(cursorVendorPlugin(pluginRootPath, manifest));
  }
  return plugins;
}

async function resolveMarketplaceCursorPlugins(
  homeDir: string,
): Promise<ExperimentalVendorPlugin[]> {
  const cachePath = path.join(homeDir, ".cursor", "plugins", "cache");
  const plugins: ExperimentalVendorPlugin[] = [];
  for (const marketplace of sortedDirectoryEntries(
    await readDirectoryEntries(cachePath),
  )) {
    const marketplacePath = path.join(cachePath, marketplace.name);
    for (const pluginEntry of sortedDirectoryEntries(
      await readDirectoryEntries(marketplacePath),
    )) {
      const pluginPath = path.join(marketplacePath, pluginEntry.name);
      const candidates: CursorPluginCandidate[] = [];
      for (const version of sortedDirectoryEntries(
        await readDirectoryEntries(pluginPath),
      )) {
        const pluginRootPath = path.join(pluginPath, version.name);
        const completion = await fs
          .lstat(path.join(pluginRootPath, ".cache-complete"))
          .catch(() => null);
        if (completion === null || !completion.isFile()) {
          continue;
        }
        const manifest = await readCursorPluginManifest(pluginRootPath);
        if (manifest === null) {
          continue;
        }
        candidates.push({
          completedAtMs: completion.mtimeMs,
          plugin: cursorVendorPlugin(pluginRootPath, manifest),
        });
      }
      const latest = candidates.sort(
        (left, right) =>
          right.completedAtMs - left.completedAtMs ||
          right.plugin.rootPath.localeCompare(left.plugin.rootPath),
      )[0];
      if (latest !== undefined) {
        plugins.push(latest.plugin);
      }
    }
  }
  return plugins;
}

async function deduplicateCursorPlugins(
  plugins: readonly ExperimentalVendorPlugin[],
): Promise<ExperimentalVendorPlugin[]> {
  const uniquePlugins: ExperimentalVendorPlugin[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    const key = await fs.realpath(plugin.rootPath).catch(() => plugin.rootPath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniquePlugins.push(plugin);
  }
  return uniquePlugins;
}

export const resolveCursorNativeRoots: AcpNativeRootsResolver = async (
  args,
) => {
  const plugins = await deduplicateCursorPlugins([
    ...(await resolveLocalCursorPlugins(args.homeDir)),
    ...(await resolveMarketplaceCursorPlugins(args.homeDir)),
  ]);
  return experimental_resolveVendorPluginRoots({
    plugins,
    layout: "claude",
  });
};
