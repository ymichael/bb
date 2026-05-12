import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { bundleSupportFileTargets, bundleTargets } from "./bundle-manifest.mjs";

const execFileAsync = promisify(execFile);

async function main() {
  let totalBytes = 0;

  for (const target of bundleTargets) {
    await execFileAsync("node", ["--check", target.outfile]);
    const bundleStats = await stat(target.outfile);
    totalBytes += bundleStats.size;
    console.log(`${target.label}: syntax ok (${bundleStats.size} bytes)`);
  }

  for (const target of bundleSupportFileTargets) {
    if (target.syntaxCheck) {
      await execFileAsync("node", ["--check", target.outfile]);
    }
    const fileStats = await stat(target.outfile);
    totalBytes += fileStats.size;
    console.log(`${target.label}: present (${fileStats.size} bytes)`);
  }

  console.log(`total bundle size: ${totalBytes} bytes`);
}

void main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
