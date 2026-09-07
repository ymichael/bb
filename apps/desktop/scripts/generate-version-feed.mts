import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  bbDesktopVersionFeedSchema,
  createBbDesktopVersionFeedFileName,
  type BbDesktopVersionFeed,
} from "@bb/desktop-contract";
import {
  createDesktopReleaseConfig,
  resolveDesktopBuildPlatform,
  resolveDesktopReleaseChannel,
} from "./desktop-release-channel.mjs";

const packageRoot = process.cwd();
const packageJsonPath = resolve(packageRoot, "package.json");
const releaseChannel = resolveDesktopReleaseChannel(process.env);
const releaseConfig = createDesktopReleaseConfig(releaseChannel);
const buildPlatform = resolveDesktopBuildPlatform(process.platform);
const updateMetadataFileName =
  releaseConfig.updateMetadataFileNames[buildPlatform];
const updateMetadataPath = resolve(
  packageRoot,
  "release",
  updateMetadataFileName,
);
const desktopVersionFeedPath = resolve(
  packageRoot,
  "release",
  createBbDesktopVersionFeedFileName(buildPlatform),
);

const packageJsonSchema = z.object({
  version: z.string().min(1),
});

const updateMetadataFileSchema = z.object({
  url: z.string().min(1),
  sha512: z.string().min(1),
  size: z.number().int().nonnegative(),
});

const updateMetadataSchema = z.object({
  version: z.string().min(1),
  files: z.array(updateMetadataFileSchema).min(1),
  path: z.string().min(1),
  sha512: z.string().min(1),
  releaseDate: z.iso.datetime(),
});

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

const packageJson = packageJsonSchema.parse(
  parseJson(await readFile(packageJsonPath, "utf8")),
);
const updateMetadata = updateMetadataSchema.parse(
  parseYaml(await readFile(updateMetadataPath, "utf8")),
);

if (updateMetadata.version !== packageJson.version) {
  throw new Error(
    `${updateMetadataFileName} version ${updateMetadata.version} did not match apps/desktop/package.json version ${packageJson.version}`,
  );
}

const desktopVersionFeed: BbDesktopVersionFeed = {
  channel: releaseChannel,
  files: updateMetadata.files,
  minimumSystemVersion: null,
  path: updateMetadata.path,
  platform: buildPlatform,
  releaseDate: updateMetadata.releaseDate,
  releaseName: `${releaseConfig.applicationName} desktop ${packageJson.version}`,
  releaseNotes: null,
  schemaVersion: 1,
  sha512: updateMetadata.sha512,
  stagingPercentage: null,
  version: packageJson.version,
};

const validatedFeed = bbDesktopVersionFeedSchema.parse(desktopVersionFeed);
await writeFile(
  desktopVersionFeedPath,
  `${JSON.stringify(validatedFeed, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`Wrote ${desktopVersionFeedPath}\n`);
