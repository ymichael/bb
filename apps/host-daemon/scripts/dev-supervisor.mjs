import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDevSupervisor } from "@bb/scripts/lib/run-dev-supervisor";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");

void runDevSupervisor({
  childArgs: ["../../packages/scripts/dist/commands/run-host-daemon.js", "--auto-join"],
  childCommand: process.execPath,
  childCwd: packageRoot,
  serviceName: "host-daemon",
}).catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
