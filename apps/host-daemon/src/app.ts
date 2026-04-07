import { CommandRouter } from "./command-router.js";
import { createDaemon, type HostDaemon } from "./daemon.js";
import { createEventBuffer, type EventBuffer } from "./event-buffer.js";
import { createBufferedEnvironmentChangeReporter } from "./environment-change-reporter.js";
import {
  defaultListModels,
  shutdownDefaultListModelsRuntimes,
} from "./command-dispatch-support.js";
import { startLocalApiServer, type LocalApiServer } from "./local-api.js";
import type { HostDaemonLocalApiConfig } from "./local-api-config.js";
import type { HostDaemonLogger } from "./logger.js";
import { RuntimeManager } from "./runtime-manager.js";
import { createServerClient } from "./server-client.js";
import {
  ServerConnection,
  type CreateReconnectingWebSocket,
} from "./server-connection.js";
import { ensureThreadStorageRoot } from "./thread-storage-root.js";
import type { AgentRuntimeOptions } from "@bb/agent-runtime";
import type { HostType, ToolCallRequest, ToolCallResponse } from "@bb/domain";
import type { HostWatcher } from "@bb/host-watcher";

interface SessionState {
  value: string | null;
}

const COMMAND_FETCH_RETRY_DELAY_MS = 2_000;
const ENVIRONMENT_CHANGE_REPORT_DEBOUNCE_MS = 150;
const ENVIRONMENT_CHANGE_REPORT_RETRY_DELAY_MS = 1_000;
const ENVIRONMENT_CHANGE_REPORT_MAX_RETRY_DELAY_MS = 30_000;

export function createCommandFetchLoop<Command>(
  args: {
    logger: HostDaemonLogger;
    fetchCommands: () => Promise<Command[]>;
    handleCommands: (commands: Command[]) => Promise<void>;
    retryDelayMs?: number;
  },
) {
  let fetchRequested = false;
  let fetchPromise: Promise<void> | null = null;

  async function drainPendingCommands(): Promise<void> {
    let commands = await args.fetchCommands();

    while (commands.length > 0) {
      await args.handleCommands(commands);
      commands = await args.fetchCommands();
    }
  }

  async function request(): Promise<void> {
    fetchRequested = true;
    if (fetchPromise) {
      return fetchPromise;
    }

    fetchPromise = (async () => {
      try {
        while (fetchRequested) {
          fetchRequested = false;
          await drainPendingCommands();
        }
      } catch (error) {
        args.logger.error({ err: error }, "Failed to fetch host-daemon commands");
        setTimeout(() => {
          void request();
        }, args.retryDelayMs ?? COMMAND_FETCH_RETRY_DELAY_MS);
      } finally {
        fetchPromise = null;
        if (fetchRequested) {
          await request();
        }
      }
    })();

    return fetchPromise;
  }

  return {
    request,
  };
}

export interface CreateHostDaemonAppOptions {
  dataDir: string;
  serverUrl: string;
  hostKey: string;
  bridgeBundleDir?: string;
  hostType: HostType;
  hostId: string;
  hostName: string;
  instanceId: string;
  logger: HostDaemonLogger;
  releaseLock: () => Promise<void>;
  restart: () => Promise<void>;
  localApiConfig: HostDaemonLocalApiConfig | null;
  runtimeShellEnv?: AgentRuntimeOptions["shellEnv"];
  adapterFactory?: AgentRuntimeOptions["adapterFactory"];
  hostWatcher?: HostWatcher;
  onToolCall?: (request: ToolCallRequest) => Promise<ToolCallResponse>;
  openPath?: (path: string) => Promise<void>;
  pickFolder?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  createWebSocket?: CreateReconnectingWebSocket;
}

export interface HostDaemonApp {
  daemon: HostDaemon;
  eventBuffer: EventBuffer;
  localApi: LocalApiServer | null;
  runtimeManager: RuntimeManager;
  router: CommandRouter;
  connection: ServerConnection;
}

export async function createHostDaemonApp(
  options: CreateHostDaemonAppOptions,
): Promise<HostDaemonApp> {
  const threadStorageRootPath = await ensureThreadStorageRoot(options.dataDir);
  const sessionState: SessionState = {
    value: null,
  };

  const serverClient = createServerClient({
    serverUrl: options.serverUrl,
    hostKey: options.hostKey,
    logger: options.logger,
    getSessionId: () => {
      if (!sessionState.value) {
        throw new Error("Server session is not open");
      }
      return sessionState.value;
    },
    fetchFn: options.fetchFn,
  });

  const environmentChangeReporter = createBufferedEnvironmentChangeReporter({
    debounceMs: ENVIRONMENT_CHANGE_REPORT_DEBOUNCE_MS,
    logger: options.logger,
    reportEnvironmentChange: (change) => serverClient.postEnvironmentChange(change),
    retryDelayMs: ENVIRONMENT_CHANGE_REPORT_RETRY_DELAY_MS,
    retryMaxDelayMs: ENVIRONMENT_CHANGE_REPORT_MAX_RETRY_DELAY_MS,
  });

  const eventBuffer = createEventBuffer({
    logger: options.logger,
    postEvents: (events) => serverClient.postEvents(events),
  });

  const runtimeManager = new RuntimeManager({
    adapterFactory: options.adapterFactory,
    bridgeBundleDir: options.bridgeBundleDir,
    hostWatcher: options.hostWatcher,
    shellEnv: options.runtimeShellEnv,
    onEvent: ({ environmentId, event }) => {
      eventBuffer.push({
        environmentId,
        threadId: event.threadId,
        event,
      });
    },
    onThreadStorageChanged: ({ environmentId }) => {
      environmentChangeReporter.queue({
        environmentId,
        change: "thread-storage-changed",
      });
    },
    onThreadStorageWatchError: ({ error }) => {
      options.logger.warn(
        {
          rootPath: error.rootPath,
          watchError: error.message,
        },
        "Thread storage watch unavailable; retrying in background",
      );
    },
    onWorkspaceStatusChanged: ({ environmentId }) => {
      environmentChangeReporter.queue({
        environmentId,
        change: "work-status-changed",
      });
    },
    onWorkspaceStatusWatchError: ({ error }) => {
      options.logger.warn(
        {
          environmentId: error.environmentId,
          rootPath: error.rootPath,
          watchError: error.message,
        },
        "Workspace status watch unavailable; retrying in background",
      );
    },
    onToolCall:
      options.onToolCall ??
      (async (request) => {
        try {
          return await serverClient.callTool(request);
        } catch (error) {
          options.logger.error(
            {
              err: error,
              tool: request.tool,
              threadId: request.threadId,
              providerThreadId: request.providerThreadId,
              turnId: request.turnId,
              callId: request.callId,
            },
            "Failed to forward dynamic tool call to server",
          );
          throw error;
        }
      }),
    threadStorageRootPath,
  });

  const router = new CommandRouter({
    runtimeManager,
    listModels: (providerId) =>
      defaultListModels(providerId, {
        bridgeBundleDir: options.bridgeBundleDir,
      }),
    logger: options.logger,
    seedThreadHighWaterMark: ({ threadId, sequence }) =>
      eventBuffer.seed({ [threadId]: sequence }),
    eventSink: {
      emit: (event) => eventBuffer.push(event),
      flush: () => eventBuffer.flush(),
    },
    reportResult: async (report) => {
      await serverClient.reportCommandResult(report);
    },
  });

  const commandFetchLoop = createCommandFetchLoop({
    logger: options.logger,
    fetchCommands: () => serverClient.fetchCommands(),
    handleCommands: (commands) => router.handleCommands(commands),
  });

  const connection = new ServerConnection({
    serverUrl: options.serverUrl,
    hostKey: options.hostKey,
    hostId: options.hostId,
    hostName: options.hostName,
    hostType: options.hostType,
    dataDir: options.dataDir,
    instanceId: options.instanceId,
    logger: options.logger,
    serverClient,
    createWebSocket: options.createWebSocket,
    getActiveThreads: () => runtimeManager.listActiveThreads(),
    onCommandsAvailable: () => commandFetchLoop.request(),
    onSessionOpened: (session) => {
      sessionState.value = session.sessionId;
      runtimeManager.replaceTrackedThreadStorageTargets(
        session.trackedThreadTargets,
      );
      eventBuffer.seed(session.threadHighWaterMarks);
      void commandFetchLoop.request();
    },
    setSession: (session) => {
      sessionState.value = session?.sessionId ?? null;
    },
  });

  const localApi =
    options.localApiConfig
      ? await startLocalApiServer({
          hostId: options.hostId,
          localApiConfig: options.localApiConfig,
          serverUrl: options.serverUrl,
          getConnected: () => connection.sessionId != null,
          openPath: options.openPath,
          pickFolder: options.pickFolder,
          listActiveThreads: () => runtimeManager.listActiveThreads(),
          restart: () => {
            process.kill(process.pid, "SIGUSR2");
          },
        })
      : null;

  const daemon = createDaemon({
    identity: {
      hostId: options.hostId,
      hostName: options.hostName,
      instanceId: options.instanceId,
    },
    logger: options.logger,
    releaseLock: options.releaseLock,
    flushEventBuffer: () => eventBuffer.flush(),
    shutdownRuntimes: async () => {
      eventBuffer.dispose();
      environmentChangeReporter.dispose();
      await localApi?.close();
      await runtimeManager.shutdownAll();
      await shutdownDefaultListModelsRuntimes();
      await connection.shutdown();
    },
    restart: options.restart,
    onStart: async () => {
      await connection.start();
      await commandFetchLoop.request();
    },
  });
  connection.setSessionCloseHandler((reason) =>
    daemon.shutdown(`session-close:${reason}`),
  );

  return {
    daemon,
    eventBuffer,
    localApi,
    runtimeManager,
    router,
    connection,
  };
}
