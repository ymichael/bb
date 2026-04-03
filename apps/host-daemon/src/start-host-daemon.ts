import { randomUUID } from "node:crypto";
import { commonConfig, hostDaemonConfig } from "@bb/config/host-daemon";
import type { AgentRuntimeOptions } from "@bb/agent-runtime";
import type { HostType, ToolCallRequest, ToolCallResponse } from "@bb/domain";
import { createLogger } from "@bb/logger";
import { createHostDaemonApp } from "./app.js";
import type { HostDaemon } from "./daemon.js";
import { loadHostIdentity } from "./identity.js";
import { acquireDaemonLock } from "./lock.js";
import { restartHostDaemon } from "./restart.js";
import { prepareRuntimeShellEnv } from "./runtime-shell-env.js";
import type { CreateReconnectingWebSocket } from "./server-connection.js";

export interface StartHostDaemonOptions {
  dataDir?: string;
  serverUrl?: string;
  authToken?: string;
  hostType?: HostType;
  enableLocalApi?: boolean;
  localApiPort?: number;
  createInstanceId?: () => string;
  acquireLock?: typeof acquireDaemonLock;
  loadIdentity?: typeof loadHostIdentity;
  restartProcess?: typeof restartHostDaemon;
  adapterFactory?: AgentRuntimeOptions["adapterFactory"];
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
  const serverUrl = options.serverUrl ?? hostDaemonConfig.BB_SERVER_URL;
  const authToken = options.authToken ?? commonConfig.BB_SECRET_TOKEN;
  const hostType = options.hostType ?? "persistent";
  const enableLocalApi = options.enableLocalApi ?? hostType === "persistent";
  const localApiPort =
    options.localApiPort ?? hostDaemonConfig.BB_HOST_DAEMON_PORT;
  const releaseLock = await (options.acquireLock ?? acquireDaemonLock)(dataDir);

  let app: Awaited<ReturnType<typeof createHostDaemonApp>> | undefined;
  try {
    const identity = await (options.loadIdentity ?? loadHostIdentity)({ dataDir });
    const instanceId = (options.createInstanceId ?? randomUUID)();
    const runtimeShellEnv = await prepareRuntimeShellEnv({
      dataDir,
      serverUrl,
      localApiPort,
    });
    app = await createHostDaemonApp({
      dataDir,
      serverUrl,
      authToken,
      hostType,
      hostId: identity.hostId,
      hostName: identity.hostName,
      instanceId,
      logger: createLogger({ component: "host-daemon", base: { serverUrl } }),
      releaseLock,
      restart: () =>
        (options.restartProcess ?? restartHostDaemon)({
          releaseLock,
        }),
      enableLocalApi,
      localApiPort,
      runtimeShellEnv,
      adapterFactory: options.adapterFactory,
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
