import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export { startHostDaemon } from "./start-host-daemon.js";
export type { StartHostDaemonOptions } from "./start-host-daemon.js";
import { hostDaemonEntrypointConfig } from "@bb/config/host-daemon-entrypoint";
import { startHostDaemon } from "./start-host-daemon.js";

const entrypointDir = dirname(fileURLToPath(import.meta.url));

function resolveEntrypointBridgeBundleDir(): string | undefined {
  return existsSync(join(entrypointDir, "bb-claude-code-bridge.mjs"))
    ? entrypointDir
    : undefined;
}

async function main(): Promise<void> {
  const daemon = await startHostDaemon({
    bbExecutableDirectory: hostDaemonEntrypointConfig.BB_CLI_DIR,
    bridgeBundleDir:
      hostDaemonEntrypointConfig.BB_BRIDGE_DIR ??
      resolveEntrypointBridgeBundleDir(),
    enrollKey: hostDaemonEntrypointConfig.BB_HOST_ENROLL_KEY,
    hostId: hostDaemonEntrypointConfig.BB_HOST_ID,
    hostName: hostDaemonEntrypointConfig.BB_HOST_NAME,
    hostType: hostDaemonEntrypointConfig.BB_HOST_TYPE,
  });
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
