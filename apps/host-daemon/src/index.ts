import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { commonConfig, hostDaemonConfig } from "@bb/config/host-daemon";
import type { HostType, ToolCallRequest, ToolCallResponse } from "@bb/domain";
import { createLogger } from "@bb/logger";
import type { AgentRuntimeOptions } from "@bb/agent-runtime";
import type { HostDaemonActiveThread } from "@bb/host-daemon-contract";
import { readCommandCursor, writeCommandCursor } from "./command-cursor.js";
import { createDaemon, type HostDaemon } from "./daemon.js";
import { createEventBuffer, type EventBuffer } from "./event-buffer.js";
import { loadHostIdentity } from "./identity.js";
import { acquireDaemonLock } from "./lock.js";
import { startLocalApiServer } from "./local-api.js";
import { restartHostDaemon } from "./restart.js";
import { RuntimeManager } from "./runtime-manager.js";
import { ServerConnection } from "./server-connection.js";
import { CommandRouter } from "./command-router.js";

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
  createDaemonLifecycle?: typeof createDaemon;
  restartProcess?: typeof restartHostDaemon;
  readCursor?: typeof readCommandCursor;
  writeCursor?: typeof writeCommandCursor;
  adapterFactory?: AgentRuntimeOptions["adapterFactory"];
  onToolCall?: (request: ToolCallRequest) => Promise<ToolCallResponse>;
  openPath?: (path: string) => Promise<void>;
  pickFolder?: () => Promise<string | null>;
}

export async function startHostDaemon(
  options: StartHostDaemonOptions = {},
): Promise<HostDaemon> {
  const dataDir = options.dataDir ?? commonConfig.BB_DATA_DIR;
  const serverUrl = options.serverUrl ?? hostDaemonConfig.BB_SERVER_URL;
  const authToken = options.authToken ?? commonConfig.BB_SECRET_TOKEN;
  const hostType = options.hostType ?? "persistent";
  const enableLocalApi = options.enableLocalApi ?? hostType === "persistent";
  const releaseLock = await (options.acquireLock ?? acquireDaemonLock)(dataDir);

  try {
    const logger = createLogger({
      component: "host-daemon",
      base: {
        serverUrl,
      },
    });
    const instanceId = (options.createInstanceId ?? randomUUID)();
    const identity = await (options.loadIdentity ?? loadHostIdentity)({
      dataDir,
    });
    const currentCursor = {
      value: await (options.readCursor ?? readCommandCursor)(dataDir),
    };
    let daemonInstance: HostDaemon | null = null;
    let requestCommandFetch: () => Promise<void> = async () => undefined;
    let connection: ServerConnection | null = null;
    const localApi =
      enableLocalApi
        ? await startLocalApiServer({
            hostId: identity.hostId,
            port: options.localApiPort ?? hostDaemonConfig.BB_HOST_DAEMON_PORT,
            serverUrl,
            getConnected: () => connection?.sessionId != null,
            openPath: options.openPath,
            pickFolder: options.pickFolder,
            restart: () => {
              process.kill(process.pid, "SIGUSR2");
            },
          })
        : null;
    const onToolCall = options.onToolCall;

    const eventBuffer: EventBuffer = createEventBuffer({
      postEvents: async (events) => {
        if (!connection) {
          throw new Error("Server connection is not initialized");
        }
        return connection.postEvents(events);
      },
    });
    const runtimeManager = new RuntimeManager({
      adapterFactory: options.adapterFactory,
      onEvent: ({ environmentId, event }) => {
        eventBuffer.push({
          environmentId,
          threadId: event.threadId,
          event,
        });
      },
      onToolCall: onToolCall
        ? (request) => onToolCall(request)
        : (request) => {
            if (!connection) {
              throw new Error("Server connection is not initialized");
            }
            return connection.callTool(request);
          },
    });
    connection = new ServerConnection({
      serverUrl,
      authToken,
      hostId: identity.hostId,
      hostName: identity.hostName,
      hostType,
      instanceId,
      getHeartbeatPayload: () => ({
        bufferDepth: eventBuffer.depth(),
        lastCommandCursor: currentCursor.value || undefined,
      }),
      getActiveThreads: (): HostDaemonActiveThread[] =>
        runtimeManager.listActiveThreads(),
      onCommandsAvailable: () => {
        void requestCommandFetch();
      },
      onSessionClose: (reason) => {
        if (!daemonInstance) {
          return;
        }
        void daemonInstance.shutdown(`session-close:${reason}`);
      },
      onSessionOpened: (session) => {
        eventBuffer.seed(session.threadHighWaterMarks);
      },
    });
    const router = new CommandRouter({
      runtimeManager,
      initialCursor: currentCursor.value,
      reportResult: async (result) => {
        if (!connection) {
          throw new Error("Server connection is not initialized");
        }
        await connection.reportCommandResult(result);
        currentCursor.value = result.cursor;
        await (options.writeCursor ?? writeCommandCursor)(dataDir, result.cursor);
      },
    });

    let fetchRequested = false;
    let fetchPromise: Promise<void> | null = null;
    requestCommandFetch = async (): Promise<void> => {
      fetchRequested = true;
      if (fetchPromise) {
        return fetchPromise;
      }

      fetchPromise = (async () => {
        try {
          while (fetchRequested) {
            fetchRequested = false;

            while (true) {
              if (!connection) {
                throw new Error("Server connection is not initialized");
              }
              const commands = await connection.fetchCommands({
                afterCursor: currentCursor.value,
              });
              if (commands.length === 0) {
                break;
              }
              await router.handleCommands(commands);
            }
          }
        } catch (error) {
          logger.error({ err: error }, "Failed to fetch host-daemon commands");
        } finally {
          fetchPromise = null;
          if (fetchRequested) {
            void requestCommandFetch();
          }
        }
      })();

      return fetchPromise;
    };

    daemonInstance = (options.createDaemonLifecycle ?? createDaemon)({
      identity: {
        ...identity,
        instanceId,
      },
      logger,
      releaseLock,
      flushEventBuffer: () => eventBuffer.flush(),
      shutdownRuntimes: async () => {
        eventBuffer.dispose();
        await localApi?.close();
        await runtimeManager.shutdownAll();
        await connection?.shutdown();
      },
      restart: async () => {
        await (options.restartProcess ?? restartHostDaemon)({
          releaseLock,
        });
      },
      onStart: async () => {
        if (!connection) {
          throw new Error("Server connection is not initialized");
        }
        await connection.start();
        await requestCommandFetch();
      },
    });

    await daemonInstance.start();
    return daemonInstance;
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
