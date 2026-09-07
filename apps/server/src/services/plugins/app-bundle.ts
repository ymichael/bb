import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import { PLUGIN_SDK_MAJOR } from "@bb/domain";
import {
  assertValidPluginCompactIconSvg,
  assertValidPluginIconSvg,
} from "@bb/plugin-build";

interface PluginArtifactMeta {
  sdkMajor: number;
  sdkVersion: string;
  artifactFormatVersion?: 1;
  pluginId?: string;
  pluginVersion?: string;
  builtWith?: {
    bbVersion: string;
    pluginSdkVersion: string;
  };
}

interface PluginArtifactMetaParseResult {
  meta: PluginArtifactMeta | null;
  error: string | null;
}

interface PluginAppBundleInfo {
  jsUrl: string;
  cssUrl: string | null;
  jsBytes: number;
  hash: string;
  sdkMajor: number;
  sdkVersion: string;
  compatible: boolean;
}

interface PluginAppState {
  hasApp: boolean;
  bundle: PluginAppBundleInfo | null;
}

interface PluginAppAssets {
  jsPath: string;
  cssPath: string | null;
  hash: string;
}

export interface PluginAppBundleSnapshot {
  state: PluginAppState;
  assets: PluginAppAssets | null;
}

const BRANDING_ASSET_CONTENT_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
};

export type PluginBrandingAssetVariant = "icon" | "logo" | "logo-dark";

export interface PluginBrandingAssetSnapshot {
  url: string;
  bytes: Uint8Array;
  contentType: string;
  hash: string;
}

export interface PluginBrandingAssetSet {
  compactIcon: PluginBrandingAssetSnapshot | null;
  logo: PluginBrandingAssetSnapshot | null;
  logoDark: PluginBrandingAssetSnapshot | null;
  icons: ReadonlyMap<string, PluginBrandingAssetSnapshot>;
}

export function brandingAssetHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

async function loadPluginBrandingAsset(
  pluginId: string,
  manifestPath: string | undefined,
  variant: PluginBrandingAssetVariant,
): Promise<PluginBrandingAssetSnapshot | null> {
  if (manifestPath === undefined) return null;
  const bytes = await readFile(manifestPath);
  if (variant === "icon") {
    assertValidPluginCompactIconSvg(bytes);
  }
  const extension = manifestPath
    .slice(manifestPath.lastIndexOf(".") + 1)
    .toLowerCase();
  const contentType = BRANDING_ASSET_CONTENT_TYPES[extension];
  if (contentType === undefined) return null;
  const hash = brandingAssetHash(bytes);
  return {
    url: `/api/v1/plugins/${encodeURIComponent(pluginId)}/assets/${variant}?h=${hash}`,
    bytes,
    contentType,
    hash,
  };
}

async function loadPluginIconAsset(
  pluginId: string,
  name: string,
  path: string,
): Promise<PluginBrandingAssetSnapshot> {
  const bytes = await readFile(path);
  assertValidPluginIconSvg(bytes, `bb.branding.experimental_icons["${name}"]`);
  const hash = brandingAssetHash(bytes);
  return {
    url: `/api/v1/plugins/${encodeURIComponent(pluginId)}/assets/icons/${encodeURIComponent(name)}.svg?h=${hash}`,
    bytes,
    contentType: "image/svg+xml",
    hash,
  };
}

export async function loadPluginBrandingAssets(
  pluginId: string,
  manifest: {
    branding: {
      compactIconPath?: string;
      logo?: { lightPath: string; darkPath?: string };
      icons: ReadonlyMap<string, string>;
    };
  },
): Promise<PluginBrandingAssetSet> {
  const icons = new Map<string, PluginBrandingAssetSnapshot>();
  for (const [name, path] of manifest.branding.icons) {
    icons.set(name, await loadPluginIconAsset(pluginId, name, path));
  }
  return {
    compactIcon: await loadPluginBrandingAsset(
      pluginId,
      manifest.branding.compactIconPath,
      "icon",
    ),
    logo: await loadPluginBrandingAsset(
      pluginId,
      manifest.branding.logo?.lightPath,
      "logo",
    ),
    logoDark: await loadPluginBrandingAsset(
      pluginId,
      manifest.branding.logo?.darkPath,
      "logo-dark",
    ),
    icons,
  };
}

function parsePluginArtifactMeta(raw: string): PluginArtifactMetaParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { meta: null, error: "metadata is not valid JSON" };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { meta: null, error: "metadata must be a JSON object" };
  }
  const meta = Object.fromEntries(Object.entries(json));
  if (
    typeof meta.sdkMajor !== "number" ||
    !Number.isSafeInteger(meta.sdkMajor) ||
    meta.sdkMajor < 0 ||
    typeof meta.sdkVersion !== "string" ||
    semver.valid(meta.sdkVersion) === null ||
    semver.major(meta.sdkVersion) !== meta.sdkMajor
  ) {
    return {
      meta: null,
      error:
        "sdkMajor must be a non-negative integer and must match the valid semver sdkVersion",
    };
  }
  const authoritativeKeys = [
    "artifactFormatVersion",
    "pluginId",
    "pluginVersion",
    "builtWith",
  ];
  const hasAuthoritativeField = authoritativeKeys.some((key) => key in meta);
  if (!hasAuthoritativeField) {
    return {
      meta: { sdkMajor: meta.sdkMajor, sdkVersion: meta.sdkVersion },
      error: null,
    };
  }
  if (meta.artifactFormatVersion !== 1) {
    return {
      meta: null,
      error: `unknown artifactFormatVersion ${JSON.stringify(meta.artifactFormatVersion)}; supported value is 1`,
    };
  }
  if (typeof meta.pluginId !== "string" || meta.pluginId.length === 0) {
    return { meta: null, error: "pluginId must be a non-empty string" };
  }
  if (
    typeof meta.pluginVersion !== "string" ||
    meta.pluginVersion.length === 0
  ) {
    return { meta: null, error: "pluginVersion must be a non-empty string" };
  }
  if (
    typeof meta.builtWith !== "object" ||
    meta.builtWith === null ||
    Array.isArray(meta.builtWith)
  ) {
    return { meta: null, error: "builtWith must be an object" };
  }
  const builtWith = Object.fromEntries(Object.entries(meta.builtWith));
  if (
    typeof builtWith.bbVersion !== "string" ||
    builtWith.bbVersion.length === 0 ||
    typeof builtWith.pluginSdkVersion !== "string" ||
    semver.valid(builtWith.pluginSdkVersion) === null
  ) {
    return {
      meta: null,
      error:
        "builtWith.bbVersion must be non-empty and builtWith.pluginSdkVersion must be a valid semver",
    };
  }
  if (builtWith.pluginSdkVersion !== meta.sdkVersion) {
    return {
      meta: null,
      error: `builtWith.pluginSdkVersion ${builtWith.pluginSdkVersion} does not match sdkVersion ${meta.sdkVersion}`,
    };
  }
  return {
    meta: {
      sdkMajor: meta.sdkMajor,
      sdkVersion: meta.sdkVersion,
      artifactFormatVersion: 1,
      pluginId: meta.pluginId,
      pluginVersion: meta.pluginVersion,
      builtWith: {
        bbVersion: builtWith.bbVersion,
        pluginSdkVersion: builtWith.pluginSdkVersion,
      },
    },
    error: null,
  };
}

export function parsePluginAppBundleMeta(
  raw: string,
): PluginArtifactMeta | null {
  return parsePluginArtifactMeta(raw).meta;
}

export function validatePluginArtifactMeta(args: {
  artifact: "server" | "app" | "host";
  raw: string;
  pluginId: string;
  pluginVersion: string;
}): string | null {
  const parsed = parsePluginArtifactMeta(args.raw);
  if (parsed.meta === null) {
    return `${args.artifact} artifact for plugin "${args.pluginId}" has invalid metadata: ${parsed.error ?? "unknown error"}`;
  }
  const meta = parsed.meta;
  if (meta.sdkMajor !== PLUGIN_SDK_MAJOR) {
    return `${args.artifact} artifact for plugin "${args.pluginId}" was built for SDK major ${meta.sdkMajor}, running SDK major is ${PLUGIN_SDK_MAJOR}; rebuild the ${args.artifact} artifact with this bb version`;
  }
  if (meta.artifactFormatVersion !== 1) return null;
  if (meta.pluginId !== args.pluginId) {
    return `${args.artifact} artifact pluginId "${meta.pluginId}" does not match manifest pluginId "${args.pluginId}"`;
  }
  if (meta.pluginVersion !== args.pluginVersion) {
    return `${args.artifact} artifact pluginVersion "${meta.pluginVersion}" does not match manifest version "${args.pluginVersion}"`;
  }
  return null;
}

export async function readPluginAppBundleMeta(
  rootDir: string,
): Promise<PluginArtifactMeta | null> {
  let raw: string;
  try {
    raw = await readFile(join(rootDir, "dist", "app.meta.json"), "utf8");
  } catch {
    return null;
  }
  return parsePluginAppBundleMeta(raw);
}

export async function loadPluginAppBundle(
  pluginId: string,
  rootDir: string,
): Promise<PluginAppBundleSnapshot> {
  const distDir = join(rootDir, "dist");
  const jsPath = join(distDir, "app.js");
  const cssPath = join(distDir, "app.css");
  let metaRaw: string;
  try {
    metaRaw = await readFile(join(distDir, "app.meta.json"), "utf8");
  } catch {
    return { state: { hasApp: true, bundle: null }, assets: null };
  }
  const meta = parsePluginAppBundleMeta(metaRaw);
  let js: Buffer;
  try {
    js = await readFile(jsPath);
  } catch {
    return { state: { hasApp: true, bundle: null }, assets: null };
  }
  if (meta === null) {
    return { state: { hasApp: true, bundle: null }, assets: null };
  }
  let css: Buffer | null;
  try {
    css = await readFile(cssPath);
  } catch {
    css = null;
  }
  const hasher = createHash("sha256").update(js);
  if (css !== null) hasher.update(css);
  hasher.update(metaRaw);
  const hash = hasher.digest("hex").slice(0, 16);
  const assetUrl = (file: string) =>
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/assets/${file}?h=${hash}`;
  return {
    state: {
      hasApp: true,
      bundle: {
        jsUrl: assetUrl("app.js"),
        cssUrl: css !== null ? assetUrl("app.css") : null,
        jsBytes: js.byteLength,
        hash,
        sdkMajor: meta.sdkMajor,
        sdkVersion: meta.sdkVersion,
        compatible: meta.sdkMajor === PLUGIN_SDK_MAJOR,
      },
    },
    assets: { jsPath, cssPath: css !== null ? cssPath : null, hash },
  };
}
