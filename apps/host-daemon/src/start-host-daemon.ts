import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { loadHostDaemonStartConfig } from "@bb/config/host-daemon";
import type { HostType } from "@bb/domain";
import {
  createHostWatcher,
  createSubprocessParcelWatcherBackend,
  setParcelWatcherBackend,
} from "@bb/host-watcher";
import { createLogger } from "@bb/logger";
import { createHostDaemonApp } from "./app.js";
import {
  readHostAuthState,
  resolveServerUrl,
  writeHostAuthState,
} from "./auth-state.js";
import type { HostDaemon } from "./daemon.js";
import { enrollDaemonHost } from "./enroll.js";
import { loadHostIdentity, persistHostId } from "./identity.js";
import { acquireDaemonLock } from "./lock.js";
import { resolveHostDaemonLocalApiConfig } from "./local-api-config.js";
import {
  createUserShellPathResolver,
  prepareRuntimeShellEnv,
  resolveBbExecutablePathInDirectory,
  resolveLocalBbExecutablePath,
} from "./runtime-shell-env.js";
import type { HostDaemonLogger } from "./logger.js";
import {
  startMachineAuthProxy,
  type MachineAuthProxy,
} from "./machine-auth-proxy.js";

interface StartHostDaemonOptions {
  enrollKey?: string;
  hostId?: string;
  hostName?: string;
  bbExecutableDirectory?: string;
  bridgeBundleDir?: string;
  hostType?: HostType;
  machineCredential?: string;
  connectMachineId?: string;
  autoUpdate?: boolean;
}

export async function startHostDaemon(
  options: StartHostDaemonOptions = {},
): Promise<HostDaemon> {
  const resolvedConfig = loadHostDaemonStartConfig({});
  const dataDir = resolvedConfig.dataDir;
  const hostDaemonConfig = resolvedConfig.connectionConfig;
  let lockDiagnosticsLogger: HostDaemonLogger | null = null;
  let handleDaemonLockLost: () => void = () => process.exit(1);
  const releaseLock = await acquireDaemonLock(dataDir, {
    logger: {
      warn: (fields, message) => {
        if (lockDiagnosticsLogger) {
          lockDiagnosticsLogger.warn(fields, message);
        } else {
          console.warn(message, fields);
        }
      },
      error: (fields, message) => {
        if (lockDiagnosticsLogger) {
          lockDiagnosticsLogger.error(fields, message);
        } else {
          console.error(message, fields);
        }
      },
    },
    onLockLost: () => handleDaemonLockLost(),
  });

  let app: Awaited<ReturnType<typeof createHostDaemonApp>> | undefined;
  let machineAuthProxy: MachineAuthProxy | undefined;
  try {
    const persistedAuth = await readHostAuthState(dataDir);
    const identity = await loadHostIdentity({
      dataDir,
      providedHostId: options.hostId,
      providedHostName: options.hostName,
    });
    const instanceId = randomUUID();
    const serverUrl = resolveServerUrl({
      providedServerUrl: hostDaemonConfig.BB_SERVER_URL,
    });
    if (!serverUrl) {
      throw new Error("Host daemon server URL is required");
    }

    const hostType =
      persistedAuth?.hostType ?? options.hostType ?? "persistent";
    if (
      persistedAuth &&
      options.hostType &&
      persistedAuth.hostType !== options.hostType
    ) {
      throw new Error(
        `Configured host type ${options.hostType} does not match persisted auth state ${persistedAuth.hostType}`,
      );
    }

    if (persistedAuth && persistedAuth.hostId !== identity.hostId) {
      throw new Error(
        `Resolved host ID ${identity.hostId} does not match persisted auth state ${persistedAuth.hostId}`,
      );
    }

    const hostKey =
      persistedAuth?.hostKey ??
      (
        await enrollDaemonHost({
          hostId: identity.hostId,
          hostName: identity.hostName,
          hostType,
          connectMachineId: options.connectMachineId,
          serverUrl,
          machineCredential: options.machineCredential,
          token:
            options.enrollKey ??
            (() => {
              throw new Error(
                `Missing host bootstrap material. Provide BB_HOST_ENROLL_KEY or populate ${dataDir}/auth.json first.`,
              );
            })(),
        })
      ).hostKey;

    if (!persistedAuth) {
      await persistHostId({ dataDir, hostId: identity.hostId });
      await writeHostAuthState(dataDir, {
        hostId: identity.hostId,
        hostKey,
        hostType,
      });
    }

    const localApiConfig = resolveHostDaemonLocalApiConfig({
      hostDaemonPort: hostDaemonConfig.BB_HOST_DAEMON_PORT,
    });
    const bbExecutablePath =
      options.bbExecutableDirectory !== undefined
        ? resolveBbExecutablePathInDirectory(options.bbExecutableDirectory)
        : await resolveLocalBbExecutablePath();
    const bbExecutableDirectory = dirname(bbExecutablePath);
    const logger = createLogger({
      component: "host-daemon",
      base: { serverUrl },
      dataDir,
      transportMode: "worker",
    });
    lockDiagnosticsLogger = logger;
    if (options.machineCredential !== undefined) {
      machineAuthProxy = await startMachineAuthProxy({
        machineCredential: options.machineCredential,
        serverUrl,
      });
    }
    setParcelWatcherBackend(
      createSubprocessParcelWatcherBackend({
        log: (level, message, fields) => {
          if (level === "error") {
            logger.error(fields ?? {}, message);
          } else if (level === "warn") {
            logger.warn(fields ?? {}, message);
          } else {
            logger.info(fields ?? {}, message);
          }
        },
      }),
    );
    const hostWatcher = createHostWatcher();
    const resolveUserShellPath = createUserShellPathResolver();
    const resolveRuntimeShellEnv = async () =>
      prepareRuntimeShellEnv({
        bbExecutableDirectory,
        bbExecutablePath,
        hostDaemonPort: localApiConfig.port,
        inheritedPath: (await resolveUserShellPath()) ?? process.env.PATH,
        serverUrl: machineAuthProxy?.serverUrl ?? serverUrl,
      });
    const runtimeShellEnv = await resolveRuntimeShellEnv();
    const runtimeShellEnvResolvedAtMs = Date.now();
    app = await createHostDaemonApp({
      dataDir,
      serverUrl,
      hostKey,
      machineCredential: options.machineCredential,
      connectMachineId: options.connectMachineId,
      autoUpdate: options.autoUpdate,
      bridgeBundleDir: options.bridgeBundleDir,
      hostType,
      hostId: identity.hostId,
      hostName: identity.hostName,
      instanceId,
      appUrl:
        hostDaemonConfig.BB_APP_URL === ""
          ? undefined
          : hostDaemonConfig.BB_APP_URL,
      devAppPort: hostDaemonConfig.BB_DEV_APP_PORT,
      logger,
      releaseLock,
      localApiConfig,
      runtimeShellEnv,
      runtimeShellEnvResolvedAtMs,
      resolveRuntimeShellEnv,
      hostWatcher,
      closeMachineAuthProxy: machineAuthProxy?.close,
      exitProcess: (code) => process.exit(code),
    });
    const startedApp = app;
    handleDaemonLockLost = () => {
      void startedApp.daemon
        .shutdown("daemon-lock-lost", 1)
        .catch(() => process.exit(1));
    };
    await app.daemon.start();
    return app.daemon;
  } catch (error) {
    if (!app) {
      await machineAuthProxy?.close().catch(() => undefined);
      await releaseLock().catch(() => undefined);
    }
    throw error;
  }
}
