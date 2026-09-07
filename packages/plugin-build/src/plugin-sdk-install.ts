import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isRecord } from "./plugin-manifest.js";

export const PLUGIN_SDK_PACKAGE_NAME = "@get-bb/plugin-sdk";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function installedPluginSdkDirectory(
  fromDir: string,
): Promise<string | null> {
  let directory = fromDir;
  while (true) {
    const candidate = join(directory, "node_modules", PLUGIN_SDK_PACKAGE_NAME);
    if (await pathExists(join(candidate, "package.json"))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export async function installedPluginSdkExportTarget(
  packageDir: string,
  subpath: string,
): Promise<string | null> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(json) || !isRecord(json.exports)) return null;
  let target: unknown = json.exports[subpath];
  while (isRecord(target)) {
    target = target.import ?? target.node ?? target.default ?? target.require;
  }
  return typeof target === "string" ? target : null;
}
