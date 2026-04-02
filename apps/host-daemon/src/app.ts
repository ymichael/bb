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
import type { HostDaemonEnvironmentChangeRequest } from "@bb/host-daemon-contract";
import type { HostType, ToolCallRequest, ToolCallResponse } from "@bb/domain";
import { AbortError } from "p-retry";

interface SessionState {
  value: string | null;
}

const COMMAND_FETCH_RETRY_DELAY_MS = 2_000;
const ENVIRONMENT_CHANGE_REPORT_DEBOUNCE_MS = 150;
const ENVIRONMENT_CHANGE_REPORT_RETRY_DELAY_MS = 1_000;

type BufferedEnvironmentChange = Omit<
  HostDaemonEnvironmentChangeRequest,
  "sessionId"
>;

interface BufferedEnvironmentChangeReporterArgs {
  debounceMs?: number;
  logger: HostDaemonLogger;
  reportEnvironmentChange: (
    change: BufferedEnvironmentChange,
  ) => Promise<void>;
  retryDelayMs?: number;
}

interface BufferedEnvironmentChangeEntry {
  change: BufferedEnvironmentChange;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ScheduledEntryArgs {
  delayMs: number;
  key: string;
}

interface FlushEntryArgs {
  key: string;
}

function shouldRetryEnvironmentChangeError(error: unknown): boolean {
  return !(error instanceof AbortError);
}

export function createBufferedEnvironmentChangeReporter(
  args: BufferedEnvironmentChangeReporterArgs,
) {
  let disposed = false;
  const entries = new Map<string, BufferedEnvironmentChangeEntry>();

  function toKey(change: BufferedEnvironmentChange): string {
    return `${change.environmentId}:${change.change}`;
  }

  function scheduleEntry(args: ScheduledEntryArgs): void {
    const entry = entries.get(args.key);
    if (!entry || disposed) {
      return;
    }
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
    }
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void flushEntry({
        key: args.key,
      });
    }, args.delayMs);
  }

  async function flushEntry(payload: FlushEntryArgs): Promise<void> {
    const entry = entries.get(payload.key);
    if (!entry || disposed) {
      return;
    }
    try {
      await args.reportEnvironmentChange(entry.change);
      if (disposed) {
        return;
      }
      if (entries.get(payload.key) === entry) {
        entries.delete(payload.key);
      }
    } catch (error) {
      if (disposed) {
        return;
      }
      if (!shouldRetryEnvironmentChangeError(error)) {
        args.logger.warn(
          {
            change: entry.change,
            err: error,
          },
          "Dropping environment change after permanent failure",
        );
        if (entries.get(payload.key) === entry) {
          entries.delete(payload.key);
        }
        return;
      }
      args.logger.warn(
        {
          change: entry.change,
          err: error,
        },
        "Failed to report environment change",
      );
      scheduleEntry({
        delayMs:
          args.retryDelayMs ?? ENVIRONMENT_CHANGE_REPORT_RETRY_DELAY_MS,
        key: payload.key,
      });
    }
  }

  return {
    queue(change: BufferedEnvironmentChange): void {
      if (disposed) {
        return;
      }
      const key = toKey(change);
      if (entries.has(key)) {
        return;
      }
      entries.set(key, {
        change,
        timer: null,
      });
      scheduleEntry({
        delayMs: args.debounceMs ?? ENVIRONMENT_CHANGE_REPORT_DEBOUNCE_MS,
        key,
      });
    },
    dispose(): void {
      disposed = true;
      for (const entry of entries.values()) {
        if (entry.timer === null) {
          continue;
        }
        clearTimeout(entry.timer);
      }
      entries.clear();
    },
  };
}

export function createCommandFetchLoop(args: {
  logger: HostDaemonLogger;
  fetchCommands: () => Promise<unknown[]>;
  handleCommands: (commands: unknown[]) => Promise<void>;
  retryDelayMs?: number;
}) {
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

  const environmentChangeReporter = createBufferedEnvironmentChangeReporter({
    logger: options.logger,
    reportEnvironmentChange: (change) => serverClient.postEnvironmentChange(change),
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
    onWorkspaceStatusChanged: ({ environmentId }) => {
      environmentChangeReporter.queue({
        environmentId,
        change: "work-status-changed",
      });
    },
    onWorkspaceStatusWatchError: ({ environmentId, error }) => {
      options.logger.warn(
        {
          environmentId,
          rootPath: error.rootPath,
          watchError: error.message,
        },
        "Workspace status watch unavailable; retrying in background",
      );
    },
    onToolCall: options.onToolCall ?? ((request) => serverClient.callTool(request)),
  });

  const router = new CommandRouter({
    runtimeManager,
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
    handleCommands: (commands) =>
      router.handleCommands(commands as Parameters<typeof router.handleCommands>[0]),
  });

  const connection = new ServerConnection({
    serverUrl: options.serverUrl,
    authToken: options.authToken,
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
      eventBuffer.seed(session.threadHighWaterMarks);
      void commandFetchLoop.request();
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
