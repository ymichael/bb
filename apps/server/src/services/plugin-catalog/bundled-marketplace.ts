import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BundledPluginRegistration } from "../plugins/builtin-registry.js";
import {
  BUNDLED_MARKETPLACE_NAME,
  isBundledMarketplaceEntry,
  parseBundledMarketplaceManifestJson,
  type MarketplaceManifestV2,
} from "./marketplace-manifest.js";
import {
  BUNDLED_MARKETPLACE_FILENAME,
  BUNDLED_MARKETPLACE_GENERATED_DIRECTORY,
} from "./bundled-marketplace-paths.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export function resolveBundledMarketplaceDirectory(
  baseDirectory = moduleDirectory,
): string {
  const candidates = [
    path.resolve(baseDirectory, "builtin-plugins"),
    path.resolve(
      baseDirectory,
      "../../generated",
      BUNDLED_MARKETPLACE_GENERATED_DIRECTORY,
    ),
    path.resolve(
      baseDirectory,
      "../src/generated",
      BUNDLED_MARKETPLACE_GENERATED_DIRECTORY,
    ),
  ];
  return (
    candidates.find((candidate) =>
      existsSync(path.join(candidate, BUNDLED_MARKETPLACE_FILENAME)),
    ) ?? candidates[1]
  );
}

export function loadBundledMarketplace(
  plugins: readonly BundledPluginRegistration[],
  baseDirectory = moduleDirectory,
): { catalog: MarketplaceManifestV2; directory: string; manifestJson: string } {
  const directory = resolveBundledMarketplaceDirectory(baseDirectory);
  const manifestPath = path.join(directory, BUNDLED_MARKETPLACE_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `the bundled marketplace document is missing at ${manifestPath}; run pnpm exec turbo run generate:bb-official-marketplace --filter=@bb/server`,
    );
  }
  const catalog = parseBundledMarketplaceManifestJson(
    readFileSync(manifestPath, "utf8"),
    `${BUNDLED_MARKETPLACE_NAME} marketplace catalog`,
  );
  const names = new Set(plugins.map((plugin) => plugin.name));
  const filtered = {
    ...catalog,
    plugins: catalog.plugins.filter(
      (entry) =>
        isBundledMarketplaceEntry(entry) &&
        names.has(entry.source.bundled.plugin),
    ),
  };
  return {
    catalog: filtered,
    directory,
    manifestJson: JSON.stringify(filtered),
  };
}
