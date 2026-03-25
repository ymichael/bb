import { fileURLToPath } from "node:url";
export { startHostDaemon } from "./start-host-daemon.js";
export type { StartHostDaemonOptions } from "./start-host-daemon.js";
import { startHostDaemon } from "./start-host-daemon.js";

async function main(): Promise<void> {
  const daemon = await startHostDaemon();
  await daemon.waitUntilStopped();
}

const entrypointPath = process.argv[1];
const isMainModule =
  typeof entrypointPath === "string" &&
  fileURLToPath(import.meta.url) === entrypointPath;

if (isMainModule) {
  void main().catch((error) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
