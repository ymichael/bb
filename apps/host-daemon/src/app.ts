import { readCommandCursor, writeCommandCursor } from "./command-cursor.js";
import { CommandRouter } from "./command-router.js";
import { createDaemon, type HostDaemon } from "./daemon.js";
import { createEventBuffer, type EventBuffer } from "./event-buffer.js";
import { startLocalApiServer, type LocalApiServer } from "./local-api.js";
import type { HostDaemonLogger } from "./logger.js";
import { RuntimeManager } from "./runtime-manager.js";
import { createServerClient } from "./server-client.js";
import {
  ServerConnection,
  type CreateReconnectingWebSocket,
} from "./server-connection.js";
import type { AgentRuntimeOptions } from "@bb/agent-runtime";
import type { HostType, ToolCallRequest, ToolCallResponse } from "@bb/domain";

interface CursorState {
  value: number;
}

interface SessionState {
  value: string | null;
}

const COMMAND_FETCH_RETRY_DELAY_MS = 2_000;

export function createCommandFetchLoop(args: {
  logger: HostDaemonLogger;
  getCursor: () => number;
  fetchCommands: (options: { afterCursor: number }) => Promise<unknown[]>;
  handleCommands: (commands: unknown[]) => Promise<void>;
  retryDelayMs?: number;
}) {
  let fetchRequested = false;
  let fetchPromise: Promise<void> | null = null;

  async function drainPendingCommands(): Promise<void> {
    let commands = await args.fetchCommands({
      afterCursor: args.getCursor(),
    });

    while (commands.length > 0) {
      await args.handleCommands(commands);
      commands = await args.fetchCommands({
        afterCursor: args.getCursor(),
      });
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
  authToken: string;
  hostType: HostType;
  hostId: string;
  hostName: string;
  instanceId: string;
  logger: HostDaemonLogger;
  releaseLock: () => Promise<void>;
  restart: () => Promise<void>;
  enableLocalApi: boolean;
  localApiPort: number;
  readCursor?: typeof readCommandCursor;
  writeCursor?: typeof writeCommandCursor;
  adapterFactory?: AgentRuntimeOptions["adapterFactory"];
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
  const cursorState: CursorState = {
    value: await (options.readCursor ?? readCommandCursor)(options.dataDir),
  };
  const sessionState: SessionState = {
    value: null,
  };

  const serverClient = createServerClient({
    serverUrl: options.serverUrl,
    authToken: options.authToken,
    logger: options.logger,
    getSessionId: () => {
      if (!sessionState.value) {
        throw new Error("Server session is not open");
      }
      return sessionState.value;
    },
    fetchFn: options.fetchFn,
  });

  const eventBuffer = createEventBuffer({
    logger: options.logger,
    postEvents: (events) => serverClient.postEvents(events),
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
    onToolCall: options.onToolCall ?? ((request) => serverClient.callTool(request)),
  });

  const router = new CommandRouter({
    runtimeManager,
    logger: options.logger,
    initialCursor: cursorState.value,
    reportResult: async (result) => {
      await serverClient.reportCommandResult(result);
      cursorState.value = result.cursor;
      await (options.writeCursor ?? writeCommandCursor)(
        options.dataDir,
        result.cursor,
      );
    },
  });

  const commandFetchLoop = createCommandFetchLoop({
    logger: options.logger,
    getCursor: () => cursorState.value,
    fetchCommands: (fetchOptions) => serverClient.fetchCommands(fetchOptions),
    handleCommands: (commands) =>
      router.handleCommands(commands as Parameters<typeof router.handleCommands>[0]),
  });

  const connection = new ServerConnection({
    serverUrl: options.serverUrl,
    authToken: options.authToken,
    hostId: options.hostId,
    hostName: options.hostName,
    hostType: options.hostType,
    instanceId: options.instanceId,
    logger: options.logger,
    serverClient,
    createWebSocket: options.createWebSocket,
    getHeartbeatPayload: () => ({
      bufferDepth: eventBuffer.depth(),
      lastCommandCursor: cursorState.value || undefined,
    }),
    getActiveThreads: () => runtimeManager.listActiveThreads(),
    onCommandsAvailable: () => commandFetchLoop.request(),
    onSessionOpened: (session) => {
      sessionState.value = session.sessionId;
      eventBuffer.seed(session.threadHighWaterMarks);
    },
    setSession: (session) => {
      sessionState.value = session?.sessionId ?? null;
    },
  });

  const localApi =
    options.enableLocalApi
      ? await startLocalApiServer({
          hostId: options.hostId,
          port: options.localApiPort,
          serverUrl: options.serverUrl,
          getConnected: () => connection.sessionId != null,
          openPath: options.openPath,
          pickFolder: options.pickFolder,
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
      await localApi?.close();
      await runtimeManager.shutdownAll();
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
