import { CommandRouter } from "./command-router.js";
import { createDaemon, type HostDaemon } from "./daemon.js";
import {
  createEventBuffer,
  EventBufferDisposedError,
  type EventBuffer,
} from "./event-buffer.js";
import { createEnvironmentChangeReporter } from "./environment-change-reporter.js";
import { InteractiveRequestRegistry } from "./interactive-request-registry.js";
import {
  defaultListModels,
  type ReplayTaskRegistry,
  shutdownDefaultListModelsRuntimes,
} from "./command-dispatch-support.js";
import { startLocalApiServer, type LocalApiServer } from "./local-api.js";
import type { HostDaemonLocalApiConfig } from "./local-api-config.js";
import type { HostDaemonLogger } from "./logger.js";
import {
  RuntimeManager,
  type RuntimeManagerOptions,
} from "./runtime-manager.js";
import {
  TerminalManager,
  type TerminalManagerOptions,
} from "./terminals/terminal-manager.js";
import { hostDaemonConfig } from "@bb/config/host-daemon";
import { createReplayCaptureService } from "@bb/replay-capture/writer";
import { createServerClient } from "./server-client.js";
import {
  ServerConnection,
  type CreateReconnectingWebSocket,
} from "./server-connection.js";
import { ensureThreadStorageRoot } from "./thread-storage-root.js";
import type { AgentRuntimeOptions } from "@bb/agent-runtime";
import {
  calculateExponentialBackoffDelay,
  type HostType,
  type ToolCallRequest,
  type ToolCallResponse,
} from "@bb/domain";
import type { HostWatcher } from "@bb/host-watcher";

interface SessionState {
  value: string | null;
}

const COMMAND_FETCH_RETRY_DELAY_MS = 2_000;
const COMMAND_FETCH_RETRY_MAX_DELAY_MS = 30_000;
const COMMAND_FETCH_RETRY_JITTER_RATIO = 0.25;
const ENVIRONMENT_CHANGE_REPORT_DEBOUNCE_MS = 150;
const INTERACTIVE_INTERRUPT_RETRY_DELAY_MS = 1_000;
// Keeps unrelated thread/provider work moving while bounding memory and provider
// pressure when the server has a large backlog.
const DEFAULT_MAX_IN_FLIGHT_COMMANDS = 32;

interface CommandFetchRetryDelayArgs {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface CommandFetchLoopOptions<Command> {
  logger: HostDaemonLogger;
  fetchCommands: () => Promise<Command[]>;
  handleCommands: (commands: Command[]) => Promise<void>;
  maxInFlightCommands?: number;
  retryDelayMs?: number;
}

export interface CommandFetchLoop {
  request: () => Promise<void>;
  stopAndDrain: () => Promise<void>;
}

function resolveMaxInFlightCommands(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_IN_FLIGHT_COMMANDS;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("maxInFlightCommands must be a finite number >= 1");
  }
  return Math.floor(value);
}

function calculateCommandFetchRetryDelayMs(
  args: CommandFetchRetryDelayArgs,
): number {
  const exponentialDelayMs = calculateExponentialBackoffDelay({
    attempt: args.attempt,
    baseDelayMs: args.baseDelayMs,
    maxDelayMs: args.maxDelayMs,
  });
  const jitterMultiplier =
    1 + (Math.random() * 2 - 1) * COMMAND_FETCH_RETRY_JITTER_RATIO;
  return Math.max(
    1,
    Math.min(
      args.maxDelayMs,
      Math.round(exponentialDelayMs * jitterMultiplier),
    ),
  );
}

export function createCommandFetchLoop<Command>(
  args: CommandFetchLoopOptions<Command>,
): CommandFetchLoop {
  let fetchRequested = false;
  let fetchPromise: Promise<void> | null = null;
  let stopped = false;
  let retryTimer: NodeJS.Timeout | null = null;
  const pendingCommands: Command[] = [];
  const inFlightHandlers = new Set<Promise<void>>();
  const maxInFlightCommands = resolveMaxInFlightCommands(
    args.maxInFlightCommands,
  );
  const retryBaseDelayMs = args.retryDelayMs ?? COMMAND_FETCH_RETRY_DELAY_MS;
  let retryAttempt = 0;

  function resetRetryBackoff(): void {
    retryAttempt = 0;
  }

  function scheduleRetry(): void {
    if (stopped || retryTimer) {
      return;
    }
    retryAttempt += 1;
    const retryDelayMs = calculateCommandFetchRetryDelayMs({
      attempt: retryAttempt,
      baseDelayMs: retryBaseDelayMs,
      maxDelayMs: COMMAND_FETCH_RETRY_MAX_DELAY_MS,
    });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void request();
    }, retryDelayMs);
  }

  function clearRetry(): void {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function startAvailableCommands(): void {
    while (
      pendingCommands.length > 0 &&
      inFlightHandlers.size < maxInFlightCommands
    ) {
      const command = pendingCommands.shift();
      if (command === undefined) {
        return;
      }
      const handlerPromise = args
        .handleCommands([command])
        .then(() => {
          resetRetryBackoff();
        })
        .catch((error) => {
          fetchRequested = false;
          args.logger.error(
            { err: error },
            "Failed to handle host-daemon commands",
          );
          scheduleRetry();
        })
        .finally(() => {
          inFlightHandlers.delete(handlerPromise);
          if (canMakeProgress()) {
            void ensurePump();
          }
        });
      inFlightHandlers.add(handlerPromise);
    }
  }

  function canMakeProgress(): boolean {
    if (pendingCommands.length > 0) {
      return inFlightHandlers.size < maxInFlightCommands;
    }
    return (
      !stopped && fetchRequested && inFlightHandlers.size < maxInFlightCommands
    );
  }

  async function fetchUntilCapacityBlocked(): Promise<void> {
    while (
      !stopped &&
      fetchRequested &&
      pendingCommands.length === 0 &&
      inFlightHandlers.size < maxInFlightCommands
    ) {
      const commands = await args.fetchCommands();
      resetRetryBackoff();
      if (commands.length === 0) {
        fetchRequested = false;
        return;
      }
      pendingCommands.push(...commands);
      startAvailableCommands();
    }
  }

  async function drainPendingCommands(): Promise<void> {
    startAvailableCommands();
    await fetchUntilCapacityBlocked();
  }

  async function ensurePump(): Promise<void> {
    if (fetchPromise) {
      return fetchPromise;
    }

    fetchPromise = (async () => {
      try {
        await drainPendingCommands();
      } catch (error) {
        args.logger.error(
          { err: error },
          "Failed to fetch host-daemon commands",
        );
        fetchRequested = false;
        scheduleRetry();
      } finally {
        fetchPromise = null;
        if (canMakeProgress()) {
          await ensurePump();
        }
      }
    })();

    return fetchPromise;
  }

  async function request(): Promise<void> {
    if (stopped) {
      return;
    }
    fetchRequested = true;
    return ensurePump();
  }

  async function stopAndDrain(): Promise<void> {
    stopped = true;
    fetchRequested = false;
    clearRetry();
    while (
      fetchPromise ||
      pendingCommands.length > 0 ||
      inFlightHandlers.size > 0
    ) {
      startAvailableCommands();
      if (fetchPromise) {
        await fetchPromise;
        continue;
      }
      if (inFlightHandlers.size > 0) {
        await Promise.race(inFlightHandlers);
      }
    }
  }

  return {
    request,
    stopAndDrain,
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
  createRuntime?: RuntimeManagerOptions["createRuntime"];
  runtimeShellEnv?: AgentRuntimeOptions["shellEnv"];
  hostWatcher?: HostWatcher;
  onToolCall?: (request: ToolCallRequest) => Promise<ToolCallResponse>;
  pickFolder?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  createWebSocket?: CreateReconnectingWebSocket;
}

export interface HostDaemonApp {
  daemon: HostDaemon;
  eventBuffer: EventBuffer;
  localApi: LocalApiServer | null;
  runtimeManager: RuntimeManager;
  terminalManager: TerminalManager;
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
  let interactiveInterruptRetryTimeout: ReturnType<typeof setTimeout> | null =
    null;
  let eventBuffer: EventBuffer;

  async function flushThreadEventsBeforeInteractiveRegistration(): Promise<void> {
    // Interactive registration creates server-owned turn-scoped timeline state,
    // so the server must first observe the provider turn/started for that turn.
    await eventBuffer.flushRequired();
  }

  async function flushThreadEventsBeforeToolCall(): Promise<void> {
    // Dynamic tool calls can append server-owned turn-scoped events, so the
    // server must first observe any provider turn/started already in the spool.
    await eventBuffer.flushRequired();
  }

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
    beforeInteractiveRequestRegistrationAttempt:
      flushThreadEventsBeforeInteractiveRegistration,
    fetchFn: options.fetchFn,
  });

  const environmentChangeReporter = createEnvironmentChangeReporter({
    debounceMs: ENVIRONMENT_CHANGE_REPORT_DEBOUNCE_MS,
    logger: options.logger,
    reportEnvironmentChange: (change) =>
      serverClient.postEnvironmentChange(change),
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
      interactiveInterruptRetryTimeout !== null ||
      sessionState.value === null ||
      pendingInteractiveInterrupts.size === 0
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

  eventBuffer = createEventBuffer({
    dataDir: options.dataDir,
    logger: options.logger,
    postEvents: (events) => serverClient.postEvents(events),
  });
  const replayTasks: ReplayTaskRegistry = new Map();
  async function abortReplayTasks(): Promise<void> {
    const tasks = [...replayTasks.values()];
    for (const task of tasks) {
      task.abort.abort();
    }
    await Promise.allSettled(tasks.map((task) => task.done));
  }
  const replayCapture = createReplayCaptureService({
    dataDir: options.dataDir,
    enabled: hostDaemonConfig.BB_DEV_REPLAY_CAPTURE,
    logger: options.logger,
  });

  const interactiveRequestRegistry = new InteractiveRequestRegistry({
    registerRequest: (request) =>
      serverClient.registerInteractiveRequest(request),
    onRegistrationFailure: ({ error, request }) => {
      enqueueInteractiveInterrupt({
        providerId: request.providerId,
        reason: `Failed to register interactive request while provider was waiting: ${error.message}`,
        threadIds: [request.threadId],
      });
    },
  });

  const runtimeManager = new RuntimeManager({
    bridgeBundleDir: options.bridgeBundleDir,
    createRuntime: options.createRuntime,
    hostWatcher: options.hostWatcher,
    shellEnv: options.runtimeShellEnv,
    onCapture: (entry) => {
      replayCapture?.recordRuntimeCaptureEntry(entry);
    },
    onEvent: ({ environmentId, event }) => {
      try {
        eventBuffer.push({
          threadId: event.threadId,
          event,
        });
      } catch (error) {
        if (error instanceof EventBufferDisposedError) {
          options.logger.warn(
            {
              environmentId,
              eventType: event.type,
              threadId: event.threadId,
            },
            "Ignoring runtime event received after event buffer disposal",
          );
          return;
        }
        throw error;
      }
      replayCapture?.recordThreadEvent({
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
          await flushThreadEventsBeforeToolCall();
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
      if (!info.expected && info.stderr) {
        options.logger.warn(
          {
            providerId: info.providerId,
            threadIds: info.threadIds,
            code: info.code,
            signal: info.signal,
            stderr: info.stderr,
          },
          "Unexpected provider process exited with stderr",
        );
      }
      if (info.threadIds.length === 0) {
        return;
      }
      const reason = `Provider "${info.providerId}" exited while awaiting user interaction`;
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
  let sendTerminalMessage: TerminalManagerOptions["sendMessage"] = () => false;
  const terminalManager = new TerminalManager({
    logger: options.logger,
    runtimeManager,
    sendMessage: (message) => sendTerminalMessage(message),
  });

  const router = new CommandRouter({
    dataDir: options.dataDir,
    fetchProjectAttachment: (args) => serverClient.fetchProjectAttachment(args),
    runtimeManager,
    terminalManager,
    listModels: (args) =>
      defaultListModels(args, {
        bridgeBundleDir: options.bridgeBundleDir,
      }),
    resolveInteractiveRequest: async (request) => {
      interactiveRequestRegistry.resolve(request);
    },
    replayTasks,
    threadStorageRootPath,
    logger: options.logger,
    recordReplayCaptureThreadMetadata: (metadata) =>
      replayCapture?.recordThreadMetadata(metadata),
    recordReplayCaptureTurnRequest: (input) =>
      replayCapture?.recordTurnRequest(input),
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
    onTerminalMessage: (message) => terminalManager.handleMessage(message),
    onSessionOpened: (session) => {
      sessionState.value = session.sessionId;
      runtimeManager.replaceTrackedThreadStorageTargets(
        session.trackedThreadTargets,
      );
      void eventBuffer.flush().catch((error) => {
        options.logger.warn(
          { err: error, sessionId: session.sessionId },
          "Failed to flush buffered events after session opened",
        );
      });
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
  sendTerminalMessage = (message) => connection.sendMessage(message);

  const localApi = options.localApiConfig
    ? await startLocalApiServer({
        hostId: options.hostId,
        localApiConfig: options.localApiConfig,
        serverUrl: options.serverUrl,
        serverPort: Number(new URL(options.serverUrl).port) || 0,
        devAppPort: hostDaemonConfig.BB_DEV_APP_PORT,
        appUrl: hostDaemonConfig.BB_APP_URL || undefined,
        getConnected: () => connection.sessionId != null,
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
    flushEventBuffer: async () => {
      await abortReplayTasks();
      await commandFetchLoop.stopAndDrain();
      await eventBuffer.flush();
    },
    shutdownRuntimes: async () => {
      environmentChangeReporter.dispose();
      await localApi?.close();
      await terminalManager.shutdownAll();
      await runtimeManager.shutdownAll();
      await eventBuffer.flush();
      await eventBuffer.dispose();
      await shutdownDefaultListModelsRuntimes();
      await replayCapture?.drain();
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
    terminalManager,
    router,
    connection,
  };
}
