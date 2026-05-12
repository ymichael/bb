import { chmod, cp, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

export const NODE_ESM_REQUIRE_BANNER = [
  'import { createRequire as __createRequire } from "node:module";',
  'import { dirname as __pathDirname } from "node:path";',
  'import { fileURLToPath as __fileURLToPath } from "node:url";',
  "const require = __createRequire(import.meta.url);",
  "var __filename = __fileURLToPath(import.meta.url);",
  "var __dirname = __pathDirname(__filename);",
].join("\n");

export const NATIVE_EXTERNAL_PACKAGES = [
  "@parcel/watcher",
  "better-sqlite3",
  "bufferutil",
  "fsevents",
  "pino",
  "pino-pretty",
  "pino-roll",
  "thread-stream",
  "utf-8-validate",
];

export function externalPackagePatterns(packageNames) {
  return packageNames.flatMap((packageName) => [
    packageName,
    `${packageName}/*`,
  ]);
}

export function createNativeExternalPatterns() {
  return externalPackagePatterns(NATIVE_EXTERNAL_PACKAGES);
}

export async function removeFileAndMap(outfile) {
  await Promise.all([
    rm(outfile, { force: true }),
    rm(`${outfile}.map`, { force: true }),
  ]);
}

export async function copyDirectory({ from, to }) {
  await rm(to, { force: true, recursive: true });
  await cp(from, to, { recursive: true });
}

export async function buildNodeEsmEntry({
  cleanDist,
  entryPoint,
  executable = false,
  outfile,
  packageRoot,
  sourcemap = true,
  target = "node22",
}) {
  if (cleanDist) {
    await rm(path.join(packageRoot, "dist"), { force: true, recursive: true });
  } else {
    await removeFileAndMap(outfile);
  }

  await build({
    banner: {
      js: NODE_ESM_REQUIRE_BANNER,
    },
    bundle: true,
    conditions: ["source"],
    entryPoints: [entryPoint],
    external: createNativeExternalPatterns(),
    format: "esm",
    legalComments: "none",
    outfile,
    platform: "node",
    sourcemap,
    target,
  });

  if (executable) {
    await chmod(outfile, 0o755);
  }
}

export async function buildNodeCjsEntry({
  entryPoint,
  executable = false,
  outfile,
  sourcemap = true,
  target = "node22",
}) {
  await removeFileAndMap(outfile);

  await build({
    bundle: true,
    conditions: ["source"],
    entryPoints: [entryPoint],
    external: createNativeExternalPatterns(),
    format: "cjs",
    legalComments: "none",
    outfile,
    platform: "node",
    sourcemap,
    target,
  });

  if (executable) {
    await chmod(outfile, 0o755);
  }
}

export async function generateTemplatesIfRequested(enabled) {
  if (!enabled) {
    return;
  }

  await import("../packages/templates/scripts/generate-templates.mjs");
}
