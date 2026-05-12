import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_UNEXPECTED_RESTART_BACKOFF,
  runDevSupervisor,
} from "@bb/scripts/lib/run-dev-supervisor";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");

void runDevSupervisor({
  childArgs: ["--conditions=source", "--import", "tsx", "src/index.ts"],
  childCommand: process.execPath,
  childCwd: packageRoot,
  unexpectedRestartBackoff: DEFAULT_UNEXPECTED_RESTART_BACKOFF,
  serviceName: "server",
}).catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
