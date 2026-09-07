import { startDesktopBrowserBroker } from "./desktop-browser-broker.js";
import { CommandRouter } from "./command-router.js";
import { createDaemon, type HostDaemon } from "./daemon.js";
import {
  createEventSink,
  EventSinkDisposedError,
  type EventSink,
} from "./event-sink.js";
import {
  InteractiveRequestRegistry,
  InteractiveRequestRegistryError,
} from "./interactive-request-registry.js";
import { startEventLoopStallMonitor } from "./event-loop-stall-monitor.js";
import { startHostDaemonHealthMonitor } from "./host-daemon-health-monitor.js";
import { startLocalApiServer, type LocalApiServer } from "./local-api.js";
import type { HostDaemonLocalApiConfig } from "./local-api-config.js";
import type { HostDaemonLogger } from "./logger.js";
import type { HostDaemonDaemonWsMessage } from "@bb/host-daemon-contract";
import {
  RuntimeManager,
  type RuntimeManagerReapIdleProviderSessionsArgs,
  type RuntimeManagerReapIdleProviderSessionsResult,
  type RuntimeManagerOptions,
} from "./runtime-manager.js";
import { WatchManager } from "./watch-manager.js";
import { ConnectTunnelClient } from "./connect-tunnel/index.js";
import {
  TerminalManager,
  type TerminalManagerOptions,
} from "./terminals/terminal-manager.js";
import {
  createServerClient,
  ServerResponseError,
  type FetchFn,
} from "./server-client.js";
import {
  cleanupInjectedSkillStagingDirs,
  ensureDataDirSkillsRootPath,
} from "./injected-skills.js";
import {
  ServerConnection,
  type HandleServerSessionInvalidatedArgs,
  type ServerSessionInvalidationSource,
  type CreateReconnectingWebSocket,
} from "./server-connection.js";
import { runtimeErrorLogFields, summarizeError } from "./error-utils.js";
import { ensureThreadStorageRoot } from "./thread-storage-root.js";
import type { AgentRuntimeOptions } from "@bb/agent-runtime";
import { createProtocolSelfUpdater } from "./protocol-self-update.js";
import {
  type HostType,
  type ToolCallRequest,
  type ToolCallResponse,
} from "@bb/domain";
import {
  disposeParcelWatcherBackend,
  type HostWatcher,
} from "@bb/host-watcher";
import { PluginHostManager } from "./plugin-host-manager.js";

interface SessionState {
  value: string | null;
}

const INTERACTIVE_INTERRUPT_RETRY_DELAY_MS = 1_000;
const IDLE_PROVIDER_SESSION_REAP_AFTER_MS = 30 * 60 * 1000;
const IDLE_PROVIDER_SESSION_REAP_INTERVAL_MS = 5 * 60 * 1000;
const RUNTIME_SHELL_ENV_REFRESH_TTL_MS = 10_000;

type RuntimeShellEnv = NonNullable<AgentRuntimeOptions["shellEnv"]>;

interface RuntimeShellEnvRefreshEntry {
  expiresAtMs: number;
  promise: Promise<RuntimeShellEnv>;
}

interface IdleProviderSessionReaperTimer {
  clear(): void;
  unref(): void;
}

type IdleProviderSessionReaperIntervalFn = (
  callback: () => void,
  intervalMs: number,
) => IdleProviderSessionReaperTimer;

interface IdleProviderSessionReaper {
  stop(): void;
}

interface IdleProviderSessionReaperRuntimeManager {
  reapIdleProviderSessions(
    args: RuntimeManagerReapIdleProviderSessionsArgs,
  ): Promise<RuntimeManagerReapIdleProviderSessionsResult>;
}

interface StartIdleProviderSessionReaperArgs {
  logger: HostDaemonLogger;
  nowMs: () => number;
  runtimeManager: IdleProviderSessionReaperRuntimeManager;
  setIntervalFn: IdleProviderSessionReaperIntervalFn;
}

interface CreateHostDaemonAppOptions {
  dataDir: string;
  serverUrl: string;
  hostKey: string;
  bridgeBundleDir?: string;
  hostType: HostType;
  hostId: string;
  hostName: string;
  instanceId: string;
  appUrl?: string;
  devAppPort?: number;
  logger: HostDaemonLogger;
  machineCredential?: string;
  connectMachineId?: string;
  autoUpdate?: boolean;
  releaseLock: () => Promise<void>;
  localApiConfig: HostDaemonLocalApiConfig | null;
  createRuntime?: RuntimeManagerOptions["createRuntime"];
  runtimeShellEnv?: AgentRuntimeOptions["shellEnv"];
  runtimeShellEnvResolvedAtMs?: number;
  resolveRuntimeShellEnv?: () => Promise<
    NonNullable<AgentRuntimeOptions["shellEnv"]>
  >;
  nowMs?: () => number;
  hostWatcher?: HostWatcher;
  onToolCall?: (request: ToolCallRequest) => Promise<ToolCallResponse>;
  fetchFn?: FetchFn;
  createWebSocket?: CreateReconnectingWebSocket;
  closeMachineAuthProxy?: () => Promise<void>;
  exitProcess?: (code: number) => void;
}

export interface HostDaemonApp {
  daemon: HostDaemon;
  eventSink: EventSink;
  localApi: LocalApiServer | null;
  runtimeManager: RuntimeManager;
  watchManager: WatchManager;
  connectTunnel: ConnectTunnelClient;
  terminalManager: TerminalManager;
  router: CommandRouter;
  connection: ServerConnection;
}

interface PendingInteractiveInterruptRequest {
  providerId: string;
  reason: string;
  threadIds: readonly string[];
}

export function startIdleProviderSessionReaper(
  args: StartIdleProviderSessionReaperArgs,
): IdleProviderSessionReaper {
  let running = false;
  const timer = args.setIntervalFn(() => {
    if (running) {
      return;
    }
    running = true;
    void args.runtimeManager
      .reapIdleProviderSessions({
        idleForMs: IDLE_PROVIDER_SESSION_REAP_AFTER_MS,
        nowMs: args.nowMs(),
      })
      .then((result) => {
        if (result.reapedSessions.length === 0) {
          return;
        }
        args.logger.info(
          {
            count: result.reapedSessions.length,
            sessions: result.reapedSessions.map((session) => ({
              environmentId: session.environmentId,
              idleForMs: session.idleForMs,
              providerId: session.providerId,
              threadId: session.threadId,
            })),
          },
          "Reaped idle provider sessions",
        );
      })
      .catch((error) => {
        args.logger.warn(
          {
            ...runtimeErrorLogFields(error),
          },
          "Idle provider session reaper failed",
        );
      })
      .finally(() => {
        running = false;
      });
  }, IDLE_PROVIDER_SESSION_REAP_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      timer.clear();
    },
  };
}

interface SessionRequestArgs<TResult> {
  request: () => Promise<TResult>;
  source: ServerSessionInvalidationSource;
}

interface MaybeInvalidateSessionArgs {
  error: unknown;
  observedSessionId: string | null;
  source: ServerSessionInvalidationSource;
}

export async function createHostDaemonApp(
  options: CreateHostDaemonAppOptions,
): Promise<HostDaemonApp> {
  const threadStorageRootPath = await ensureThreadStorageRoot(options.dataDir);
  const dataDirSkillsRootPath = await ensureDataDirSkillsRootPath(
    options.dataDir,
  );
  await cleanupInjectedSkillStagingDirs({
    dataDir: options.dataDir,
    keepCatalogHashes: [],
    logger: options.logger,
  });
  const sessionState: SessionState = {
    value: null,
  };
  const pendingInteractiveInterrupts = new Map<
    string,
    PendingInteractiveInterruptRequest
  >();
  let runtimeManager: RuntimeManager;
  let watchManager: WatchManager;
  let flushPendingInteractiveInterruptsPromise: Promise<void> | null = null;
  let interactiveInterruptRetryTimeout: ReturnType<typeof setTimeout> | null =
    null;
  let eventSink: EventSink;
  let handleServerSessionInvalidated = (
    _args: HandleServerSessionInvalidatedArgs,
  ): void => undefined;

  function maybeInvalidateServerSession(
    args: MaybeInvalidateSessionArgs,
  ): void {
    if (
      args.observedSessionId === null ||
      !(args.error instanceof ServerResponseError) ||
      args.error.code !== "inactive_session"
    ) {
      return;
    }

    handleServerSessionInvalidated({
      code: "inactive_session",
      observedSessionId: args.observedSessionId,
      source: args.source,
    });
  }

  async function runSessionRequest<TResult>(
    args: SessionRequestArgs<TResult>,
  ): Promise<TResult> {
    const observedSessionId = sessionState.value;
    try {
      return await args.request();
    } catch (error) {
      maybeInvalidateServerSession({
        error,
        observedSessionId,
        source: args.source,
      });
      throw error;
    }
  }

  async function flushThreadEventsBeforeInteractiveRegistration(): Promise<void> {
    await eventSink.flush();
  }

  async function flushThreadEventsBeforeToolCall(): Promise<void> {
    await eventSink.flush();
  }

  const serverClient = createServerClient({
    serverUrl: options.serverUrl,
    hostKey: options.hostKey,
    logger: options.logger,
    machineCredential: options.machineCredential,
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
          await runSessionRequest({
            source: "interruptInteractiveRequests",
            request: () => serverClient.interruptInteractiveRequests(request),
          });
          pendingInteractiveInterrupts.delete(key);
        } catch (error) {
          options.logger.warn(
            {
              providerId: request.providerId,
              threadIds: request.threadIds,
              ...runtimeErrorLogFields(error),
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

  eventSink = createEventSink({
    isSessionOpen: () => sessionState.value !== null,
    logger: options.logger,
    postEvents: (events) =>
      runSessionRequest({
        source: "postEvents",
        request: () => serverClient.postEvents(events),
      }),
  });

  const interactiveRequestRegistry = new InteractiveRequestRegistry({
    registerRequest: (request) =>
      runSessionRequest({
        source: "registerInteractiveRequest",
        request: () => serverClient.registerInteractiveRequest(request),
      }),
    onRegistrationFailure: ({ error, request }) => {
      enqueueInteractiveInterrupt({
        providerId: request.providerId,
        reason: `Failed to register interactive request while provider was waiting: ${error.message}`,
        threadIds: [request.threadId],
      });
    },
  });

  let sendServerMessage = (_message: HostDaemonDaemonWsMessage) => false;
  watchManager = new WatchManager({
    dataDir: options.dataDir,
    hostWatcher: options.hostWatcher,
    refreshWorkspace: (args) =>
      runtimeManager.refreshEnvironmentWorkspace(args),
    shellEnv: () => runtimeManager.getShellEnv(),
    threadStorageRootPath,
    onThreadStorageChanged: ({ environmentId }) => {
      sendServerMessage({
        type: "environment-change",
        environmentId,
        change: "thread-storage-changed",
      });
    },
    onThreadStorageWatchError: ({ error }) => {
      options.logger.warn(
        {
          watchSource: "thread-storage",
          rootPath: error.rootPath,
          watchError: error.message,
        },
        "Host filesystem watch error (live updates for this path may be stale until it recovers)",
      );
    },
    onWorkspaceStatusChanged: ({ environmentId, changeKinds }) => {
      for (const change of changeKinds) {
        sendServerMessage({
          type: "environment-change",
          environmentId,
          change,
        });
      }
    },
    onWorkspaceMetadataChanged: ({ environmentId, workspace }) => {
      sendServerMessage({
        type: "environment-metadata-change",
        environmentId,
        workspace,
      });
    },
    onWorkspaceStatusWatchError: ({ error }) => {
      options.logger.warn(
        {
          watchSource: "workspace-status",
          environmentId: error.environmentId,
          rootPath: error.rootPath,
          watchError: error.message,
        },
        "Host filesystem watch error (live updates for this path may be stale until it recovers)",
      );
    },
  });
  const connectTunnel = new ConnectTunnelClient({
    serverUrl: options.serverUrl,
    hostName: options.hostName,
    machineCredential: options.machineCredential,
    fetchFn: options.fetchFn,
    logger: options.logger,
    onIdentity: (identity) => {
      sendServerMessage({
        type: "connect-tunnel.identity",
        identity,
      });
    },
    onStatusChange: (status) => {
      options.logger.debug(
        { connectTunnelStatus: status },
        "Machine tunnel status",
      );
    },
  });
  runtimeManager = new RuntimeManager({
    bridgeBundleDir: options.bridgeBundleDir,
    createRuntime: options.createRuntime,
    dataDir: options.dataDir,
    dataDirSkillsRootPath,
    fetchSkillTree: (treeHash) =>
      runSessionRequest({
        source: "fetchSkillTree",
        request: () => serverClient.fetchSkillTree(treeHash),
      }),
    hostWatcher: options.hostWatcher,
    logger: options.logger,
    shellEnv: options.runtimeShellEnv,
    onEvent: ({ environmentId, event }) => {
      try {
        eventSink.emit({
          threadId: event.threadId,
          event,
        });
      } catch (error) {
        if (error instanceof EventSinkDisposedError) {
          options.logger.warn(
            {
              environmentId,
              eventType: event.type,
              threadId: event.threadId,
            },
            "Ignoring runtime event received after event sink disposal",
          );
          return;
        }
        throw error;
      }
    },
    onInjectedSkillsChanged: (change) => {
      options.logger.debug(
        {
          changedPaths: change.changedPaths,
          sourceType: change.sourceType,
        },
        "Injected skills changed; future runtime launches will rescan",
      );
    },
    onDataDirSkillsWatchError: ({ error }) => {
      options.logger.warn(
        {
          watchSource: "data-dir-skills",
          rootPath: error.rootPath,
          watchError: error.message,
        },
        "Host filesystem watch error (live updates for this path may be stale until it recovers)",
      );
    },
    onWorkspaceStatusChanged: ({ environmentId, changeKinds }) => {
      for (const change of changeKinds) {
        sendServerMessage({
          type: "environment-change",
          environmentId,
          change,
        });
      }
    },
    onToolCall:
      options.onToolCall ??
      (async (request) => {
        try {
          await flushThreadEventsBeforeToolCall();
          return await runSessionRequest({
            source: "callTool",
            request: () => serverClient.callTool(request),
          });
        } catch (error) {
          options.logger.error(
            {
              tool: request.tool,
              threadId: request.threadId,
              providerThreadId: request.providerThreadId,
              turnId: request.turnId,
              callId: request.callId,
              err: error,
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
        if (
          error instanceof InteractiveRequestRegistryError &&
          error.code === "interactive_request_rejected"
        ) {
          options.logger.warn(
            {
              interactiveRequestErrorCode: error.code,
              ...summarizeError(error),
              threadId: request.threadId,
              providerThreadId: request.providerThreadId,
              turnId: request.turnId,
              providerRequestId: request.providerRequestId,
              kind: request.payload.kind,
            },
            "Interactive provider request rejected by server",
          );
          throw error;
        }
        options.logger.error(
          {
            threadId: request.threadId,
            providerThreadId: request.providerThreadId,
            turnId: request.turnId,
            providerRequestId: request.providerRequestId,
            kind: request.payload.kind,
            err: error,
          },
          "Failed to forward interactive provider request to server",
        );
        throw error;
      }
    },
    onProcessExit: (info) => {
      const threadIds = info.threads.map((thread) => thread.threadId);
      if (!info.expected && info.stderr) {
        options.logger.warn(
          {
            providerId: info.providerId,
            threadIds,
            code: info.code,
            signal: info.signal,
            stderr: info.stderr,
          },
          "Unexpected provider process exited with stderr",
        );
      }
      if (threadIds.length === 0) {
        return;
      }
      const reason = `Provider "${info.providerId}" exited while awaiting user interaction`;
      interactiveRequestRegistry.interruptThreads({
        providerId: info.providerId,
        threadIds,
        reason,
      });

      enqueueInteractiveInterrupt({
        providerId: info.providerId,
        threadIds,
        reason,
      });
    },
    threadStorageRootPath,
  });
  const nowMs = options.nowMs ?? Date.now;
  let runtimeShellEnvRefreshEntry: RuntimeShellEnvRefreshEntry | null =
    options.runtimeShellEnvResolvedAtMs === undefined
      ? null
      : {
          expiresAtMs:
            options.runtimeShellEnvResolvedAtMs +
            RUNTIME_SHELL_ENV_REFRESH_TTL_MS,
          promise: Promise.resolve(runtimeManager.getShellEnv()),
        };
  const refreshRuntimeShellEnv = async () => {
    if (!options.resolveRuntimeShellEnv) {
      return runtimeManager.getShellEnv();
    }
    const now = nowMs();
    if (
      runtimeShellEnvRefreshEntry &&
      runtimeShellEnvRefreshEntry.expiresAtMs > now
    ) {
      return runtimeShellEnvRefreshEntry.promise;
    }

    const promise = (async () => {
      const shellEnv = await options.resolveRuntimeShellEnv?.();
      if (shellEnv === undefined) {
        return runtimeManager.getShellEnv();
      }
      await runtimeManager.replaceBaseShellEnv(shellEnv);
      return runtimeManager.getShellEnv();
    })();
    const entry = {
      expiresAtMs: now + RUNTIME_SHELL_ENV_REFRESH_TTL_MS,
      promise,
    };
    runtimeShellEnvRefreshEntry = entry;
    try {
      return await promise;
    } catch (error) {
      if (runtimeShellEnvRefreshEntry === entry) {
        runtimeShellEnvRefreshEntry = null;
      }
      throw error;
    }
  };
  const idleProviderSessionReaper = startIdleProviderSessionReaper({
    logger: options.logger,
    nowMs: Date.now,
    runtimeManager,
    setIntervalFn: (callback, intervalMs) => {
      const timer = setInterval(callback, intervalMs);
      return {
        clear() {
          clearInterval(timer);
        },
        unref() {
          timer.unref();
        },
      };
    },
  });
  let sendTerminalMessage: TerminalManagerOptions["sendMessage"] = (message) =>
    sendServerMessage(message);
  const terminalManager = new TerminalManager({
    dataDir: options.dataDir,
    logger: options.logger,
    runtimeManager,
    sendMessage: (message) => sendTerminalMessage(message),
  });
  const pluginHostManager = new PluginHostManager({
    dataDir: options.dataDir,
    hostWatcher: options.hostWatcher,
    logger: options.logger,
    shellEnv: () => runtimeManager.getShellEnv(),
    fetchArtifact: (args) =>
      runSessionRequest({
        source: "fetchPluginHostArtifact",
        request: () => serverClient.fetchPluginHostArtifact(args),
      }),
    onWorkerExit: (event) => {
      sendServerMessage({
        type: "plugin-host.worker-exited",
        ...event,
      });
    },
    onSignal: (event) => {
      sendServerMessage({
        type: "plugin-host.signal",
        ...event,
      });
    },
  });

  const desktopBrowserBroker = await startDesktopBrowserBroker({
    dataDir: options.dataDir,
    hostId: options.hostId,
    serverUrl: options.serverUrl,
    onChanged: (event) => sendServerMessage(event),
  });

  const router = new CommandRouter({
    desktopBrowserBroker,
    dataDir: options.dataDir,
    fetchProjectAttachment: (args) =>
      runSessionRequest({
        source: "fetchProjectAttachment",
        request: () => serverClient.fetchProjectAttachment(args),
      }),
    fetchSkillTree: (treeHash) =>
      runSessionRequest({
        source: "fetchSkillTree",
        request: () => serverClient.fetchSkillTree(treeHash),
      }),
    fetchPluginHostArtifact: (args) =>
      runSessionRequest({
        source: "fetchPluginHostArtifact",
        request: () => serverClient.fetchPluginHostArtifact(args),
      }),
    runtimeManager,
    terminalManager,
    listModels: async (args) => {
      await refreshRuntimeShellEnv();
      return runtimeManager.withProviderMaintenanceRuntime(
        { dataDir: options.dataDir },
        (runtime) => runtime.listModels(args),
      );
    },
    providerHealth: async (args) => {
      await refreshRuntimeShellEnv();
      return runtimeManager.withProviderMaintenanceRuntime(
        { dataDir: options.dataDir },
        (runtime) => runtime.providerHealth(args),
      );
    },
    providerUsage: async (args) => {
      await refreshRuntimeShellEnv();
      return runtimeManager.withProviderMaintenanceRuntime(
        { dataDir: options.dataDir },
        (runtime) => runtime.providerUsage(args),
      );
    },
    providerInstallationStatus: async (args) => {
      await refreshRuntimeShellEnv();
      return runtimeManager.withProviderMaintenanceRuntime(
        { dataDir: options.dataDir },
        (runtime) => runtime.providerInstallationStatus(args),
      );
    },
    providerInstallationRun: async (args) => {
      await refreshRuntimeShellEnv();
      return runtimeManager.withProviderMaintenanceRuntime(
        { dataDir: options.dataDir },
        (runtime) => runtime.providerInstallationRun(args),
      );
    },
    refreshShellEnv: async () => {
      await refreshRuntimeShellEnv();
    },
    resolveInteractiveRequest: async (request) => {
      interactiveRequestRegistry.resolve(request);
    },
    ensureConnectTunnelIdentity: () => connectTunnel.ensureTunnelIdentity(),
    pluginHostManager,
    threadStorageRootPath,
    logger: options.logger,
    eventSink: {
      emit: (event) => eventSink.emit(event),
      flush: () => eventSink.flush(),
    },
  });

  let requestDaemonRestart = (): void => undefined;
  const connection = new ServerConnection({
    serverUrl: options.serverUrl,
    hostKey: options.hostKey,
    hostId: options.hostId,
    hostName: options.hostName,
    hostType: options.hostType,
    dataDir: options.dataDir,
    instanceId: options.instanceId,
    localApiPort: options.localApiConfig?.port ?? null,
    logger: options.logger,
    machineCredential: options.machineCredential,
    connectMachineId: options.connectMachineId,
    serverClient,
    protocolSelfUpdater: createProtocolSelfUpdater({
      dataDir: options.dataDir,
      enabled: options.autoUpdate ?? false,
      fetchFn: options.fetchFn,
      logger: options.logger,
      serverUrl: options.serverUrl,
    }),
    onSelfUpdateInstalled: () => requestDaemonRestart(),
    createWebSocket: options.createWebSocket,
    getActiveThreads: () => runtimeManager.listActiveThreads(),
    getLoadedEnvironments: () => runtimeManager.listLoadedEnvironments(),
    onHostRpcRequest: async (message) => {
      if (message.command.type === "environment.destroy") {
        await watchManager.removeEnvironmentWorkspaceWatch(
          message.command.environmentId,
        );
      }
      const response = await router.handleOnlineRpcRequest(message);
      sendServerMessage(response);
    },
    onWatchSetReplace: async (message) => {
      await watchManager.replaceWatchSet({
        generation: message.generation,
        workspaceTargets: message.workspaceTargets,
        threadStorageTargets: message.threadStorageTargets,
      });
    },
    onConnectSharesReplace: (message) => {
      connectTunnel.replaceShareSet({
        generation: message.generation,
        ports: message.ports,
      });
    },
    onTerminalMessage: (message) => terminalManager.handleMessage(message),
    onSessionOpened: async (session) => {
      sessionState.value = session.sessionId;
      connectTunnel.replaceAuthoritativeShareSet(session.connectShares);
      await pluginHostManager.reconcileGenerations(
        session.pluginHostGenerations,
      );
      if (session.retiredEnvironmentIds.length > 0) {
        await Promise.all(
          session.retiredEnvironmentIds.map((environmentId) =>
            runtimeManager.forgetEnvironment(environmentId),
          ),
        );
        options.logger.info(
          {
            environmentIds: session.retiredEnvironmentIds,
            sessionId: session.sessionId,
          },
          "Retired locally loaded environments after session reconciliation",
        );
      }
      await watchManager.replaceAuthoritativeWatchSet(session.watchSet);
      void eventSink.flush().catch((error) => {
        options.logger.warn(
          {
            sessionId: session.sessionId,
            ...runtimeErrorLogFields(error),
          },
          "Failed to flush pending daemon events after session opened",
        );
      });
      void flushPendingInteractiveInterrupts();
    },
    setSession: (session) => {
      sessionState.value = session?.sessionId ?? null;
      desktopBrowserBroker.setConnected(session !== null);
      if (session === null) {
        clearInteractiveInterruptRetry();
      }
    },
  });
  sendServerMessage = (message) => connection.sendMessage(message);
  handleServerSessionInvalidated = (args) =>
    connection.handleSessionInvalidated(args);

  const localApi = options.localApiConfig
    ? await startLocalApiServer({
        dataDir: options.dataDir,
        hostId: options.hostId,
        localApiConfig: options.localApiConfig,
        serverUrl: options.serverUrl,
        serverPort: Number(new URL(options.serverUrl).port) || 0,
        devAppPort: options.devAppPort,
        appUrl: options.appUrl,
        getConnected: () => connection.sessionId != null,
        shellEnv: () => runtimeManager.getShellEnv(),
      })
    : null;
  const eventLoopStallMonitor = startEventLoopStallMonitor({
    logger: options.logger,
  });
  const hostDaemonHealthMonitor = startHostDaemonHealthMonitor({
    logger: options.logger,
    getWatchCounts: () => ({
      workspaceWatches: watchManager.workspaceWatchCount(),
      threadStorageTargets: watchManager.threadStorageWatchTargetCount(),
    }),
  });

  const daemon = createDaemon({
    identity: {
      hostId: options.hostId,
      hostName: options.hostName,
      instanceId: options.instanceId,
    },
    logger: options.logger,
    releaseLock: options.releaseLock,
    ...(options.exitProcess ? { exitProcess: options.exitProcess } : {}),
    flushEvents: async () => {
      await eventSink.flush();
    },
    shutdownRuntimes: async () => {
      await desktopBrowserBroker.close();
      idleProviderSessionReaper.stop();
      eventLoopStallMonitor.stop();
      hostDaemonHealthMonitor.stop();
      await pluginHostManager.shutdown();
      await options.closeMachineAuthProxy?.();
      await localApi?.close();
      connectTunnel.shutdown();
      await watchManager.shutdown();
      disposeParcelWatcherBackend();
      await terminalManager.shutdownAll();
      await runtimeManager.shutdownAll();
      await eventSink.flush();
      await eventSink.dispose();
      await connection.shutdown();
    },
    onStart: async () => {
      options.logger.info(
        { dataDir: options.dataDir, serverUrl: options.serverUrl },
        "Host daemon connecting",
      );
      await connection.start();
    },
  });
  requestDaemonRestart = () => {
    void daemon.shutdown("self-update", 0).catch((error) => {
      options.logger.error({ err: error }, "Self-update shutdown failed");
    });
  };
  connection.setSessionCloseHandler((reason) =>
    daemon.shutdown(`session-close:${reason}`, 0),
  );

  return {
    daemon,
    eventSink,
    localApi,
    runtimeManager,
    watchManager,
    connectTunnel,
    terminalManager,
    router,
    connection,
  };
}
