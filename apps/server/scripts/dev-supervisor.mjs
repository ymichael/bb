import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDevSupervisor } from "@bb/scripts/lib/run-dev-supervisor";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const repoRoot = resolve(packageRoot, "..", "..");

void runDevSupervisor({
  buildCwd: repoRoot,
  buildFilters: ["@bb/server"],
  childArgs: ["dist/index.js"],
  childCommand: process.execPath,
  childCwd: packageRoot,
  serviceName: "server",
}).catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
