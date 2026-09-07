import { parseMarketplaceManifestJson } from "../src/services/plugin-catalog/marketplace-manifest.js";

const manifestUrl = process.argv[2];
if (manifestUrl === undefined) {
  throw new Error("a marketplace manifest URL is required");
}

const response = await fetch(manifestUrl, {
  redirect: "error",
});
if (response.status === 404) {
  console.log(`Skipped missing marketplace manifest ${manifestUrl}`);
  process.exit(0);
}
if (!response.ok) {
  throw new Error(`marketplace request failed with HTTP ${response.status}`);
}

const manifest = parseMarketplaceManifestJson(
  await response.text(),
  `marketplace manifest at ${manifestUrl}`,
);
if (manifest.schemaVersion !== 2) {
  throw new Error(
    `marketplace manifest at ${manifestUrl} has schema version ${manifest.schemaVersion}; expected 2`,
  );
}
console.log(
  `Parsed marketplace manifest v${manifest.schemaVersion} with ${manifest.plugins.length} plugins`,
);
