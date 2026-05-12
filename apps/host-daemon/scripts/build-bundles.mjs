import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";
import { bundleSupportFileTargets, bundleTargets } from "./bundle-manifest.mjs";
import {
  createNativeExternalPatterns,
  generateTemplatesIfRequested,
} from "../../../scripts/build-utils.mjs";

async function main() {
  await generateTemplatesIfRequested(true);

  for (const target of bundleTargets) {
    await mkdir(dirname(target.outfile), { recursive: true });
    await build({
      banner: {
        js: target.banner,
      },
      bundle: true,
      conditions: ["source"],
      entryPoints: [target.entryPoint],
      external: createNativeExternalPatterns(),
      format: "esm",
      legalComments: "none",
      minify: true,
      outfile: target.outfile,
      platform: "node",
      sourcemap: false,
      target: "node22",
    });
    if (target.executable) {
      await chmod(target.outfile, 0o755);
    }
    const bundleStats = await stat(target.outfile);
    console.log(`${target.label}: ${bundleStats.size} bytes`);
  }

  for (const target of bundleSupportFileTargets) {
    await mkdir(dirname(target.outfile), { recursive: true });
    await copyFile(target.source, target.outfile);
    const fileStats = await stat(target.outfile);
    console.log(`${target.label}: ${fileStats.size} bytes`);
  }
}

void main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
