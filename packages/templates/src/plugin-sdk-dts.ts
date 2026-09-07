import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PluginSdkDeclarations {
  root: string;
  app: string;
}

declare const __BB_PLUGIN_SDK_DTS_JSON__: string | undefined;

const ROOT_FILE = "bb-plugin-sdk.d.ts";
const APP_FILE = "bb-plugin-sdk-app.d.ts";
const BUNDLED_TYPES_RELATIVE = join("packages", "plugin-sdk", "bundled-types");

let cached: Promise<PluginSdkDeclarations> | null = null;

export function loadPluginSdkDeclarations(): Promise<PluginSdkDeclarations> {
  cached ??= loadUncached();
  return cached;
}

async function loadUncached(): Promise<PluginSdkDeclarations> {
  if (typeof __BB_PLUGIN_SDK_DTS_JSON__ === "string") {
    return parseDeclarations(__BB_PLUGIN_SDK_DTS_JSON__);
  }
  const typesDir = findWorkspaceBundledTypesDir();
  if (typesDir === null) {
    throw new Error(
      `Could not find ${BUNDLED_TYPES_RELATIVE} above ${moduleDir()}. ` +
        "Build the plugin SDK declarations first: " +
        "pnpm exec turbo run build:types --filter=@get-bb/plugin-sdk",
    );
  }
  const [root, app] = await Promise.all([
    readFile(join(typesDir, ROOT_FILE), "utf8"),
    readFile(join(typesDir, APP_FILE), "utf8"),
  ]);
  return { root, app };
}

function parseDeclarations(json: string): PluginSdkDeclarations {
  const parsed: unknown = JSON.parse(json);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("root" in parsed) ||
    !("app" in parsed) ||
    typeof parsed.root !== "string" ||
    typeof parsed.app !== "string"
  ) {
    throw new Error("Inlined plugin SDK declarations have an unexpected shape");
  }
  return { root: parsed.root, app: parsed.app };
}

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function findWorkspaceBundledTypesDir(): string | null {
  let dir = moduleDir();
  for (;;) {
    const candidate = join(dir, BUNDLED_TYPES_RELATIVE);
    if (existsSyncSafe(join(candidate, ROOT_FILE))) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

function existsSyncSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
