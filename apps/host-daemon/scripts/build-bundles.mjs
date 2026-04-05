import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";
import { bundleTargets } from "./bundle-manifest.mjs";

async function main() {
  for (const target of bundleTargets) {
    await mkdir(dirname(target.outfile), { recursive: true });
    await build({
      banner: {
        js: target.banner,
      },
      bundle: true,
      entryPoints: [target.entryPoint],
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
}

void main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
