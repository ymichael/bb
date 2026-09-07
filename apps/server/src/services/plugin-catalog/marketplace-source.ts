import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PluginMarketplaceSourceKind } from "@bb/db";
import {
  parsePluginSource,
  realPathInside,
  runInstallCommand,
} from "../plugins/install-sources.js";
import {
  boundedResponseBytes,
  MARKETPLACE_FETCH_TIMEOUT_MS,
  type MarketplaceFetch,
} from "./marketplace-http.js";
import {
  entryScreenshotUrls,
  parseMarketplaceManifest,
  parseMarketplaceManifestJson,
  type MarketplaceIconBase,
  type MarketplaceManifest,
} from "./marketplace-manifest.js";

const MARKETPLACE_MANIFEST_FILENAME = "marketplace.json";

const MARKETPLACE_MANIFEST_MAX_BYTES = 1_048_576;

type MarketplaceSource =
  | { kind: "https"; manifestUrl: string }
  | { kind: "git"; url: string; ref: string }
  | { kind: "path"; directory: string };

const GIT_CLONE_ARGS = ["-c", "core.hooksPath=/dev/null"] as const;

const SOURCE_FORMS =
  'expected "https://<manifest-url>", "git:<url>[@<ref>]", or "path:<directory>"';

export function parseMarketplaceSource(raw: string): MarketplaceSource {
  const source = raw.trim();
  if (source.length === 0) {
    throw new Error(`invalid marketplace source: ${SOURCE_FORMS}`);
  }
  if (source.startsWith("path:")) {
    const directory = source.slice("path:".length);
    if (directory.length === 0) {
      throw new Error("marketplace source has an empty path");
    }
    return { kind: "path", directory: resolve(directory) };
  }
  if (source.startsWith("git:")) {
    const parsed = parsePluginSource(source);
    if (parsed.kind !== "git") {
      throw new Error(`invalid marketplace git source "${source}"`);
    }
    if (parsed.selector.kind !== "ref") {
      throw new Error(
        `invalid marketplace git source "${source}": a marketplace ref names one branch, tag, or commit`,
      );
    }
    return { kind: "git", url: parsed.url, ref: parsed.selector.ref };
  }
  if (/^https:\/\//iu.test(source)) {
    return { kind: "https", manifestUrl: source };
  }
  if (/^http:\/\//iu.test(source)) {
    throw new Error(
      `invalid marketplace source "${source}": plain http is refused, use https`,
    );
  }
  throw new Error(`invalid marketplace source "${source}": ${SOURCE_FORMS}`);
}

export function marketplaceSourceDisplay(source: MarketplaceSource): string {
  if (source.kind === "https") return source.manifestUrl;
  if (source.kind === "path") return `path:${source.directory}`;
  return `git:${source.url}@${source.ref}`;
}

export function marketplaceSourceFromRow(row: {
  sourceKind: PluginMarketplaceSourceKind;
  manifestUrl: string;
  sourceGitRef: string | null;
}): MarketplaceSource {
  if (row.sourceKind === "https") {
    return { kind: "https", manifestUrl: row.manifestUrl };
  }
  if (row.sourceKind === "path") {
    return { kind: "path", directory: row.manifestUrl };
  }
  if (row.sourceGitRef === null) {
    throw new Error("git marketplace row has no ref");
  }
  return { kind: "git", url: row.manifestUrl, ref: row.sourceGitRef };
}

export function marketplaceSourceColumns(source: MarketplaceSource): {
  sourceKind: PluginMarketplaceSourceKind;
  manifestUrl: string;
  sourceGitRef: string | null;
} {
  if (source.kind === "https") {
    return {
      sourceKind: "https",
      manifestUrl: source.manifestUrl,
      sourceGitRef: null,
    };
  }
  if (source.kind === "path") {
    return {
      sourceKind: "path",
      manifestUrl: source.directory,
      sourceGitRef: null,
    };
  }
  return {
    sourceKind: "git",
    manifestUrl: source.url,
    sourceGitRef: source.ref,
  };
}

interface MaterializedMarketplace {
  catalog: MarketplaceManifest;
  manifestJson: string;
  unchanged: boolean;
  etag: string | null;
  lastModified: string | null;
  commit: string | null;
  iconBase: MarketplaceIconBase;
  dispose(): Promise<void>;
}

export async function materializeMarketplace(args: {
  source: MarketplaceSource;
  cached: {
    manifestJson: string;
    etag: string | null;
    lastModified: string | null;
  } | null;
  stagingDir: string;
  fetch: MarketplaceFetch;
  fallbackManifestUrl?: string;
  warn?: (message: string) => void;
}): Promise<MaterializedMarketplace> {
  if (args.source.kind === "https") {
    return materializeHttps(
      args.source,
      args.cached,
      args.fetch,
      args.fallbackManifestUrl,
      args.warn,
    );
  }
  if (args.source.kind === "path") {
    return materializeLocal(
      args.source.directory,
      null,
      async () => {},
      args.warn,
    );
  }
  return materializeGit(args.source, args.stagingDir, args.warn);
}

async function materializeHttps(
  source: Extract<MarketplaceSource, { kind: "https" }>,
  cached: {
    manifestJson: string;
    etag: string | null;
    lastModified: string | null;
  } | null,
  fetchMarketplace: MarketplaceFetch,
  fallbackManifestUrl: string | undefined,
  warn: ((message: string) => void) | undefined,
): Promise<MaterializedMarketplace> {
  const cachedCatalog =
    cached === null
      ? null
      : parseMarketplaceManifestJson(
          cached.manifestJson,
          "stored marketplace catalog",
          warn,
        );

  async function requestManifest(
    manifestUrl: string,
    useCache: boolean,
    preferJson: boolean,
  ): Promise<Response> {
    const headers = new Headers(
      preferJson ? { accept: "application/json" } : undefined,
    );
    if (useCache && cached?.etag != null) {
      headers.set("if-none-match", cached.etag);
    }
    if (useCache && cached?.lastModified != null) {
      headers.set("if-modified-since", cached.lastModified);
    }
    return fetchMarketplace(manifestUrl, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS),
    });
  }

  let manifestUrl = source.manifestUrl;
  let response = await requestManifest(
    manifestUrl,
    fallbackManifestUrl === undefined || cachedCatalog?.schemaVersion === 2,
    fallbackManifestUrl === undefined,
  );
  if (response.status === 404 && fallbackManifestUrl !== undefined) {
    if (cachedCatalog?.schemaVersion === 2 && cached !== null) {
      await response.body?.cancel();
      warn?.(
        "the marketplace v2 manifest returned HTTP 404; BB kept the stored v2 catalog and did not request v1",
      );
      const iconBase = {
        kind: "url",
        manifestUrl: source.manifestUrl,
      } as const;
      for (const entry of cachedCatalog.plugins) {
        entryScreenshotUrls(entry, iconBase, warn);
      }
      return {
        catalog: cachedCatalog,
        manifestJson: cached.manifestJson,
        unchanged: true,
        etag: cached.etag,
        lastModified: cached.lastModified,
        commit: null,
        iconBase,
        dispose: async () => {},
      };
    }
    await response.body?.cancel();
    manifestUrl = fallbackManifestUrl;
    response = await requestManifest(
      manifestUrl,
      cachedCatalog?.schemaVersion === 1,
      true,
    );
  }
  const unchanged = response.status === 304 && cached !== null;
  if (!unchanged && !response.ok) {
    await response.body?.cancel();
    throw new Error(`request failed with HTTP ${response.status}`);
  }
  let manifestJson: string;
  let catalog: MarketplaceManifest;
  if (unchanged) {
    await response.body?.cancel();
    manifestJson = cached.manifestJson;
    catalog =
      cachedCatalog ??
      parseMarketplaceManifestJson(
        manifestJson,
        "stored marketplace catalog",
        warn,
      );
  } else {
    const raw = new TextDecoder().decode(
      await boundedResponseBytes(
        response,
        MARKETPLACE_MANIFEST_MAX_BYTES,
        "marketplace manifest",
      ),
    );
    catalog = parseMarketplaceManifestJson(raw, "marketplace manifest", warn);
    manifestJson = JSON.stringify(catalog);
  }
  const iconBase = { kind: "url", manifestUrl } as const;
  for (const entry of catalog.plugins) {
    entryScreenshotUrls(entry, iconBase, warn);
  }
  return {
    catalog,
    manifestJson,
    unchanged,
    etag: response.headers.get("etag") ?? (unchanged ? cached.etag : null),
    lastModified:
      response.headers.get("last-modified") ??
      (unchanged ? cached.lastModified : null),
    commit: null,
    iconBase,
    dispose: async () => {},
  };
}

async function materializeLocal(
  root: string,
  commit: string | null,
  dispose: () => Promise<void>,
  warn: ((message: string) => void) | undefined,
): Promise<MaterializedMarketplace> {
  try {
    const isDirectory = await stat(root)
      .then((entry) => entry.isDirectory())
      .catch(() => false);
    if (!isDirectory) {
      throw new Error(`marketplace directory does not exist: ${root}`);
    }
    const manifestPath = await realPathInside(
      root,
      join(root, MARKETPLACE_MANIFEST_FILENAME),
      "marketplace manifest",
    );
    const manifestSize = (await stat(manifestPath)).size;
    if (manifestSize > MARKETPLACE_MANIFEST_MAX_BYTES) {
      throw new Error(
        `marketplace manifest exceeds ${MARKETPLACE_MANIFEST_MAX_BYTES} bytes`,
      );
    }
    const raw = await readFile(manifestPath, "utf8");
    const catalog = parseMarketplaceManifest(
      JSON.parse(raw) as unknown,
      "marketplace manifest",
      warn,
    );
    const iconBase = { kind: "dir", root } as const;
    for (const entry of catalog.plugins) {
      entryScreenshotUrls(entry, iconBase, warn);
    }
    return {
      catalog,
      manifestJson: JSON.stringify(catalog),
      unchanged: false,
      etag: null,
      lastModified: null,
      commit,
      iconBase,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function materializeGit(
  source: Extract<MarketplaceSource, { kind: "git" }>,
  stagingDir: string,
  warn: ((message: string) => void) | undefined,
): Promise<MaterializedMarketplace> {
  await mkdir(stagingDir, { recursive: true });
  const checkout = join(stagingDir, randomUUID());
  const dispose = () => rm(checkout, { recursive: true, force: true });
  try {
    await runInstallCommand("git", [
      ...GIT_CLONE_ARGS,
      "clone",
      "--quiet",
      "--no-checkout",
      source.url,
      checkout,
    ]);
    await runInstallCommand("git", [
      ...GIT_CLONE_ARGS,
      "-C",
      checkout,
      "checkout",
      "--quiet",
      "--detach",
      source.ref,
    ]);
    const commit = await runInstallCommand("git", [
      "-C",
      checkout,
      "rev-parse",
      "HEAD",
    ]);
    await rm(join(checkout, ".git"), { recursive: true, force: true });
    return await materializeLocal(checkout, commit, dispose, warn);
  } catch (error) {
    await dispose();
    throw error;
  }
}
