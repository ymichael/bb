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
import { calculateExponentialBackoffDelay } from "@bb/domain";
import type { HostDaemonEnvironmentChangePayload } from "@bb/host-daemon-contract";
import type { HostType, ToolCallRequest, ToolCallResponse } from "@bb/domain";
import { AbortError } from "p-retry";

interface SessionState {
  value: string | null;
}

const COMMAND_FETCH_RETRY_DELAY_MS = 2_000;
const ENVIRONMENT_CHANGE_REPORT_DEBOUNCE_MS = 150;
const ENVIRONMENT_CHANGE_REPORT_RETRY_DELAY_MS = 1_000;
const ENVIRONMENT_CHANGE_REPORT_MAX_RETRY_DELAY_MS = 30_000;

interface BufferedEnvironmentChangeReporterArgs {
  debounceMs?: number;
  logger: HostDaemonLogger;
  reportEnvironmentChange: (
    change: HostDaemonEnvironmentChangePayload,
  ) => Promise<void>;
  retryMaxDelayMs?: number;
  retryDelayMs?: number;
}

interface BufferedEnvironmentChangeEntry {
  change: HostDaemonEnvironmentChangePayload;
  dirtyWhileInflight: boolean;
  inflight: boolean;
  retryAttempt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ScheduledEntryArgs {
  delayMs: number;
  change: HostDaemonEnvironmentChangePayload;
}

interface FlushEntryArgs {
  change: HostDaemonEnvironmentChangePayload;
}

function shouldRetryEnvironmentChangeError(error: unknown): boolean {
  return !(error instanceof AbortError);
}

export function createBufferedEnvironmentChangeReporter(
  args: BufferedEnvironmentChangeReporterArgs,
) {
  let disposed = false;
  const entries = new Map<
    string,
    Map<HostDaemonEnvironmentChangePayload["change"], BufferedEnvironmentChangeEntry>
  >();

  function getEntry(
    change: HostDaemonEnvironmentChangePayload,
  ): BufferedEnvironmentChangeEntry | undefined {
    return entries.get(change.environmentId)?.get(change.change);
  }

  function setEntry(
    change: HostDaemonEnvironmentChangePayload,
    entry: BufferedEnvironmentChangeEntry,
  ): void {
    let environmentEntries = entries.get(change.environmentId);
    if (!environmentEntries) {
      environmentEntries = new Map();
      entries.set(change.environmentId, environmentEntries);
    }
    environmentEntries.set(change.change, entry);
  }

  function deleteEntry(change: HostDaemonEnvironmentChangePayload): void {
    const environmentEntries = entries.get(change.environmentId);
    if (!environmentEntries) {
      return;
    }
    environmentEntries.delete(change.change);
    if (environmentEntries.size === 0) {
      entries.delete(change.environmentId);
    }
  }

  function scheduleEntry(scheduledEntryArgs: ScheduledEntryArgs): void {
    const entry = getEntry(scheduledEntryArgs.change);
    if (!entry || disposed) {
      return;
    }
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
    }
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void flushEntry({
        change: scheduledEntryArgs.change,
      });
    }, scheduledEntryArgs.delayMs);
  }

  async function flushEntry(payload: FlushEntryArgs): Promise<void> {
    const entry = getEntry(payload.change);
    if (!entry || entry.inflight || disposed) {
      return;
    }
    entry.inflight = true;
    try {
      await args.reportEnvironmentChange(entry.change);
      if (disposed) {
        return;
      }
      if (getEntry(payload.change) !== entry) {
        return;
      }
      entry.inflight = false;
      entry.retryAttempt = 0;
      if (entry.dirtyWhileInflight) {
        entry.dirtyWhileInflight = false;
        scheduleEntry({
          delayMs: args.debounceMs ?? ENVIRONMENT_CHANGE_REPORT_DEBOUNCE_MS,
          change: payload.change,
        });
        return;
      }
      deleteEntry(payload.change);
    } catch (error) {
      if (disposed) {
        return;
      }
      if (getEntry(payload.change) !== entry) {
        return;
      }
      entry.inflight = false;
      if (!shouldRetryEnvironmentChangeError(error)) {
        args.logger.warn(
          {
            change: entry.change,
            err: error,
          },
          "Dropping environment change after permanent failure",
        );
        if (getEntry(payload.change) === entry) {
          deleteEntry(payload.change);
        }
        return;
      }
      entry.retryAttempt += 1;
      args.logger.warn(
        {
          change: entry.change,
          err: error,
        },
        "Failed to report environment change",
      );
      scheduleEntry({
        delayMs: calculateExponentialBackoffDelay({
          attempt: entry.retryAttempt,
          baseDelayMs:
            args.retryDelayMs ?? ENVIRONMENT_CHANGE_REPORT_RETRY_DELAY_MS,
          maxDelayMs:
            args.retryMaxDelayMs ??
            ENVIRONMENT_CHANGE_REPORT_MAX_RETRY_DELAY_MS,
        }),
        change: payload.change,
      });
    }
  }

  return {
    queue(change: HostDaemonEnvironmentChangePayload): void {
      if (disposed) {
        return;
      }
      const existingEntry = getEntry(change);
      if (existingEntry) {
        if (existingEntry.inflight) {
          existingEntry.dirtyWhileInflight = true;
        }
        return;
      }
      setEntry(change, {
        change,
        dirtyWhileInflight: false,
        inflight: false,
        retryAttempt: 0,
        timer: null,
      });
      scheduleEntry({
        delayMs: args.debounceMs ?? ENVIRONMENT_CHANGE_REPORT_DEBOUNCE_MS,
        change,
      });
    },
    dispose(): void {
      disposed = true;
      for (const environmentEntries of entries.values()) {
        for (const entry of environmentEntries.values()) {
          if (entry.timer === null) {
            continue;
          }
          clearTimeout(entry.timer);
        }
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
