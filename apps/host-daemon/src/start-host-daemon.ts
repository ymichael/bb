import { randomUUID } from "node:crypto";
import {
  commonConfig,
  hostDaemonConfig,
} from "@bb/config/host-daemon";
import type { AgentRuntimeOptions } from "@bb/agent-runtime";
import type { HostType, ToolCallRequest, ToolCallResponse } from "@bb/domain";
import { createHostWatcher, type HostWatcher } from "@bb/host-watcher";
import { createLogger } from "@bb/logger";
import { createHostDaemonApp } from "./app.js";
import {
  readHostAuthState,
  resolveServerUrl,
  writeHostAuthState,
} from "./auth-state.js";
import type { HostDaemon } from "./daemon.js";
import { enrollDaemonHost } from "./enroll.js";
import { loadHostIdentity } from "./identity.js";
import { acquireDaemonLock } from "./lock.js";
import {
  resolveHostDaemonLocalApiConfig,
  type HostDaemonLocalApiOverrides,
} from "./local-api-config.js";
import { restartHostDaemon } from "./restart.js";
import {
  prepareRuntimeShellEnv,
  resolveLocalBbExecutableDirectory,
} from "./runtime-shell-env.js";
import type { CreateReconnectingWebSocket } from "./server-connection.js";

export interface StartHostDaemonOptions {
  dataDir?: string;
  serverUrl?: string;
  enrollKey?: string;
  hostId?: string;
  hostName?: string;
  bbExecutableDirectory?: string;
  bridgeBundleDir?: string;
  hostType?: HostType;
  enableLocalApi?: boolean;
  localApi?: HostDaemonLocalApiOverrides;
  createInstanceId?: () => string;
  acquireLock?: typeof acquireDaemonLock;
  loadIdentity?: typeof loadHostIdentity;
  restartProcess?: typeof restartHostDaemon;
  adapterFactory?: AgentRuntimeOptions["adapterFactory"];
  hostWatcher?: HostWatcher;
  onToolCall?: (request: ToolCallRequest) => Promise<ToolCallResponse>;
  openPath?: (path: string) => Promise<void>;
  pickFolder?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  createWebSocket?: CreateReconnectingWebSocket;
}

export async function startHostDaemon(
  options: StartHostDaemonOptions = {},
): Promise<HostDaemon> {
  const dataDir = options.dataDir ?? commonConfig.BB_DATA_DIR;
  const enableLocalApi = options.enableLocalApi ?? true;
  const releaseLock = await (options.acquireLock ?? acquireDaemonLock)(dataDir);

  let app: Awaited<ReturnType<typeof createHostDaemonApp>> | undefined;
  try {
    const persistedAuth = await readHostAuthState(dataDir);
    const identity = await (options.loadIdentity ?? loadHostIdentity)({
      dataDir,
      providedHostId: options.hostId,
      providedHostName: options.hostName,
    });
    const instanceId = (options.createInstanceId ?? randomUUID)();
    const serverUrl = resolveServerUrl({
      persistedServerUrl: persistedAuth?.serverUrl ?? null,
      providedServerUrl: options.serverUrl ?? hostDaemonConfig.BB_SERVER_URL,
    });
    if (!serverUrl) {
      throw new Error("Host daemon server URL is required");
    }

    const hostType =
      persistedAuth?.hostType ??
      options.hostType ??
      "persistent";
    if (persistedAuth && options.hostType && persistedAuth.hostType !== options.hostType) {
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
          fetchFn: options.fetchFn,
          hostId: identity.hostId,
          hostName: identity.hostName,
          hostType,
          serverUrl,
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
      await writeHostAuthState(dataDir, {
        hostId: identity.hostId,
        hostKey,
        hostType,
        serverUrl,
      });
    }

    const localApiConfig = enableLocalApi
      ? resolveHostDaemonLocalApiConfig({
        hostType,
        localApi: options.localApi,
      })
      : null;
    const bbExecutableDirectory =
      options.bbExecutableDirectory ??
      (await resolveLocalBbExecutableDirectory());
    const hostWatcher =
      options.hostWatcher ??
      (await createHostWatcher({
        hostType,
      }));
    const runtimeShellEnv = prepareRuntimeShellEnv({
      bbExecutableDirectory,
      serverUrl,
      localApiPort:
        localApiConfig?.port ?? hostDaemonConfig.BB_HOST_DAEMON_PORT,
    });
    app = await createHostDaemonApp({
      dataDir,
      serverUrl,
      hostKey,
      bridgeBundleDir: options.bridgeBundleDir,
      hostType,
      hostId: identity.hostId,
      hostName: identity.hostName,
      instanceId,
      logger: createLogger({
        component: "host-daemon",
        base: { serverUrl },
        transportMode: hostType === "ephemeral" ? "stream" : "worker",
      }),
      releaseLock,
      restart: () =>
        (options.restartProcess ?? restartHostDaemon)({
          releaseLock,
        }),
      localApiConfig,
      runtimeShellEnv,
      adapterFactory: options.adapterFactory,
      hostWatcher,
      onToolCall: options.onToolCall,
      openPath: options.openPath,
      pickFolder: options.pickFolder,
      fetchFn: options.fetchFn,
      createWebSocket: options.createWebSocket,
    });
    await app.daemon.start();
    return app.daemon;
  } catch (error) {
    await app?.localApi?.close().catch(() => undefined);
    await releaseLock().catch(() => undefined);
    throw error;
  }
}
