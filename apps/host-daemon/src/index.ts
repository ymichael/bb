import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { commonConfig, hostDaemonConfig } from "@bb/config/host-daemon";
import { createLogger } from "@bb/logger";
import { createDaemon, type HostDaemon } from "./daemon.js";
import { loadHostIdentity } from "./identity.js";
import { acquireDaemonLock } from "./lock.js";
import { restartHostDaemon } from "./restart.js";

export interface StartHostDaemonOptions {
  dataDir?: string;
  createInstanceId?: () => string;
  acquireLock?: typeof acquireDaemonLock;
  loadIdentity?: typeof loadHostIdentity;
  createDaemonLifecycle?: typeof createDaemon;
  restartProcess?: typeof restartHostDaemon;
}

export async function startHostDaemon(
  options: StartHostDaemonOptions = {},
): Promise<HostDaemon> {
  const dataDir = options.dataDir ?? commonConfig.BB_DATA_DIR;
  const releaseLock = await (options.acquireLock ?? acquireDaemonLock)(dataDir);

  try {
    const logger = createLogger({
      component: "host-daemon",
      base: {
        serverUrl: hostDaemonConfig.BB_SERVER_URL,
      },
    });
    const identity = await (options.loadIdentity ?? loadHostIdentity)({
      dataDir,
    });
    const daemon = (options.createDaemonLifecycle ?? createDaemon)({
      identity: {
        ...identity,
        instanceId: (options.createInstanceId ?? randomUUID)(),
      },
      logger,
      releaseLock,
      restart: async () => {
        await (options.restartProcess ?? restartHostDaemon)({
          releaseLock,
        });
      },
    });

    await daemon.start();
    return daemon;
  } catch (error) {
    await releaseLock().catch(() => undefined);
    throw error;
  }
}

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
    console.error(error);
    process.exitCode = 1;
  });
}
