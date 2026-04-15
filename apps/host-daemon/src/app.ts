import {
  readRuntimeMaterialState,
  writeRuntimeMaterialState,
} from "@bb/host-runtime-material";
import { CommandRouter } from "./command-router.js";
import { createDaemon, type HostDaemon } from "./daemon.js";
import { createEventBuffer, type EventBuffer } from "./event-buffer.js";
import { createBufferedEnvironmentChangeReporter } from "./environment-change-reporter.js";
import { InteractiveRequestRegistry } from "./interactive-request-registry.js";
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
const INTERACTIVE_INTERRUPT_RETRY_DELAY_MS = 1_000;

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

interface PendingInteractiveInterruptRequest {
  providerId: string;
  reason: string;
  threadIds: readonly string[];
}

export async function createHostDaemonApp(
  options: CreateHostDaemonAppOptions,
): Promise<HostDaemonApp> {
  const threadStorageRootPath = await ensureThreadStorageRoot(options.dataDir);
  const sessionState: SessionState = {
    value: null,
  };
  const pendingInteractiveInterrupts = new Map<
    string,
    PendingInteractiveInterruptRequest
  >();
  let flushPendingInteractiveInterruptsPromise: Promise<void> | null = null;
  let interactiveInterruptRetryTimeout: ReturnType<typeof setTimeout> | null = null;

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

  function buildInteractiveInterruptKey(
    request: PendingInteractiveInterruptRequest,
  ): string {
    return [
      request.providerId,
      request.reason,
      [...request.threadIds].sort().join(","),
    ].join("|");
  }

  function clearInteractiveInterruptRetry(): void {
    if (interactiveInterruptRetryTimeout !== null) {
      clearTimeout(interactiveInterruptRetryTimeout);
      interactiveInterruptRetryTimeout = null;
    }
  }

  function scheduleInteractiveInterruptRetry(): void {
    if (
      interactiveInterruptRetryTimeout !== null
      || sessionState.value === null
      || pendingInteractiveInterrupts.size === 0
    ) {
      return;
    }

    interactiveInterruptRetryTimeout = setTimeout(() => {
      interactiveInterruptRetryTimeout = null;
      void flushPendingInteractiveInterrupts();
    }, INTERACTIVE_INTERRUPT_RETRY_DELAY_MS);
  }

  async function flushPendingInteractiveInterrupts(): Promise<void> {
    if (flushPendingInteractiveInterruptsPromise) {
      await flushPendingInteractiveInterruptsPromise;
      return;
    }

    clearInteractiveInterruptRetry();

    flushPendingInteractiveInterruptsPromise = (async () => {
      while (sessionState.value !== null) {
        const nextEntry = pendingInteractiveInterrupts.entries().next().value;
        if (!nextEntry) {
          return;
        }

        const [key, request] = nextEntry;
        try {
          await serverClient.interruptInteractiveRequests(request);
          pendingInteractiveInterrupts.delete(key);
        } catch (error) {
          options.logger.warn(
            {
              err: error,
              providerId: request.providerId,
              threadIds: request.threadIds,
            },
            "Failed to flush pending interactive interrupt request",
          );
          scheduleInteractiveInterruptRetry();
          return;
        }
      }
    })();

    try {
      await flushPendingInteractiveInterruptsPromise;
    } finally {
      flushPendingInteractiveInterruptsPromise = null;
    }
  }

  function enqueueInteractiveInterrupt(
    request: PendingInteractiveInterruptRequest,
  ): void {
    pendingInteractiveInterrupts.set(
      buildInteractiveInterruptKey(request),
      request,
    );
    void flushPendingInteractiveInterrupts();
  }

  const eventBuffer = createEventBuffer({
    logger: options.logger,
    postEvents: (events) => serverClient.postEvents(events),
  });

  const interactiveRequestRegistry = new InteractiveRequestRegistry({
    registerRequest: (request) => serverClient.registerInteractiveRequest(request),
    onRegistrationFailure: ({ error, request }) => {
      enqueueInteractiveInterrupt({
        providerId: request.providerId,
        reason:
          `Failed to register interactive request while provider was waiting: ${error.message}`,
        threadIds: [request.threadId],
      });
    },
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
    onWorkspaceStatusChanged: ({ environmentId, changeKinds }) => {
      for (const change of changeKinds) {
        environmentChangeReporter.queue({
          environmentId,
          change,
        });
      }
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
    onInteractiveRequest: async (request) => {
      try {
        return await interactiveRequestRegistry.registerAndWait(request);
      } catch (error) {
        options.logger.error(
          {
            err: error,
            threadId: request.threadId,
            providerThreadId: request.providerThreadId,
            turnId: request.turnId,
            providerRequestId: request.providerRequestId,
            kind: "approval",
          },
          "Failed to forward interactive provider request to server",
        );
        throw error;
      }
    },
    onProcessExit: (info) => {
      if (info.threadIds.length === 0) {
        return;
      }
      const reason =
        `Provider "${info.providerId}" exited while awaiting user interaction`;
      interactiveRequestRegistry.interruptThreads({
        providerId: info.providerId,
        threadIds: info.threadIds,
        reason,
      });

      enqueueInteractiveInterrupt({
        providerId: info.providerId,
        threadIds: info.threadIds,
        reason,
      });
    },
    threadStorageRootPath,
  });

  const router = new CommandRouter({
    fetchRuntimeMaterial: (version) =>
      serverClient.fetchRuntimeMaterial({ version }),
    readPersistedRuntimeMaterial: () =>
      readRuntimeMaterialState(options.dataDir),
    runtimeManager,
    listModels: (providerId) =>
      defaultListModels(providerId, {
        bridgeBundleDir: options.bridgeBundleDir,
      }),
    resolveInteractiveRequest: async (request) => {
      interactiveRequestRegistry.resolve(request);
    },
    threadStorageRootPath,
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
    persistRuntimeMaterial: (snapshot) =>
      writeRuntimeMaterialState(options.dataDir, snapshot),
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
      void flushPendingInteractiveInterrupts();
      void commandFetchLoop.request();
    },
    setSession: (session) => {
      sessionState.value = session?.sessionId ?? null;
      if (session === null) {
        clearInteractiveInterruptRetry();
      }
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
    onStart: async () => {
      options.logger.info(
        { dataDir: options.dataDir, serverUrl: options.serverUrl },
        "Host daemon connecting",
      );
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
