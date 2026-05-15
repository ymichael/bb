import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNodeEsmEntry,
  copyDirectory,
} from "../../../scripts/build-utils.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptsDir, "..");
const workspaceRoot = resolve(packageRoot, "..", "..");

async function assertPathExists(pathToCheck, label) {
  try {
    await access(pathToCheck);
  } catch {
    throw new Error(
      `Missing ${label} at ${pathToCheck}. Build @bb/app, @bb/server, and @bb/host-daemon before packaging bb-app.`,
    );
  }
}

async function copyBuildOutput({ from, label, to }) {
  await assertPathExists(from, label);
  await copyDirectory({ from, to });
}

const entrypoints = [
  ["bb-app", "bb-app.js"],
  ["bb", "bb.js"],
  ["bb-server", "bb-server.js"],
  ["bb-host-daemon", "bb-host-daemon.js"],
];

for (const [sourceName, outputName] of entrypoints) {
  await buildNodeEsmEntry({
    cleanDist: sourceName === "bb-app",
    entryPoint: resolve(packageRoot, "src", "bin", `${sourceName}.ts`),
    executable: true,
    outfile: resolve(packageRoot, "dist", outputName),
    packageRoot,
  });
}

await copyBuildOutput({
  from: resolve(workspaceRoot, "apps", "app", "dist"),
  label: "@bb/app dist",
  to: resolve(packageRoot, "app", "dist"),
});
await copyBuildOutput({
  from: resolve(workspaceRoot, "apps", "server", "dist"),
  label: "@bb/server dist",
  to: resolve(packageRoot, "server", "dist"),
});
await copyBuildOutput({
  from: resolve(workspaceRoot, "apps", "host-daemon", "dist"),
  label: "@bb/host-daemon dist",
  to: resolve(packageRoot, "host-daemon", "dist"),
});

process.stdout.write("bb-app: built package assets\n");
