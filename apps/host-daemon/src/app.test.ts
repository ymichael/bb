import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime, AgentRuntimeOptions } from "@bb/agent-runtime";
import {
  threadScope,
  turnScope,
  type PendingInteractionCreate,
  type ToolCallRequest,
} from "@bb/domain";
import {
  hostDaemonEventBatchRequestSchema,
  hostDaemonInteractiveInterruptRequestSchema,
  type HostDaemonInteractiveRequestResponse,
} from "@bb/host-daemon-contract";
import type { HostWatcher } from "@bb/host-watcher";
import { createDeferredPromise } from "@bb/test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DISPATCH_TEST_BRIDGE_LAUNCH,
  DISPATCH_TEST_ARTIFACT_BYTES,
  dispatchTestRuntimeBridgeLaunch,
} from "../test/command/dispatch-helpers.js";
import {
  createHostDaemonApp,
  startIdleProviderSessionReaper,
  type HostDaemonApp,
} from "./app.js";
import type { HostDaemonLogger } from "./logger.js";
import type {
  RuntimeManagerReapIdleProviderSessionsArgs,
  RuntimeManagerReapIdleProviderSessionsResult,
} from "./runtime-manager.js";
import type { FetchFn } from "./server-client.js";
import type { CreateReconnectingWebSocket } from "./server-connection.js";
import type { ReconnectingWebSocketLike } from "./server-connection-support.js";

interface RecordedFetchRequest {
  body: string | null;
  method: string;
  pathname: string;
}

interface FetchRecorder {
  fetchFn: FetchFn;
  requests: RecordedFetchRequest[];
}

interface CreateFetchRecorderArgs {
  inactiveSessionOnFirstEventPost?: boolean;
  interactiveRequestError?: Error;
  interactiveRequestResponse?: HostDaemonInteractiveRequestResponse;
  retiredEnvironmentIds?: string[];
  sessionIds?: string[];
}

interface RuntimeOptionsRef {
  current: AgentRuntimeOptions | null;
}

interface HostDaemonAppFixture {
  app: HostDaemonApp;
  fetchRecorder: FetchRecorder;
  logger: ReturnType<typeof createLogger>;
  runtimeOptions: RuntimeOptionsRef;
}

type StartIdleProviderSessionReaperArgsForTest = Parameters<
  typeof startIdleProviderSessionReaper
>[0];

const tempDirs: string[] = [];

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies HostDaemonLogger;
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readFetchUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

function readFetchBody(init: RequestInit | undefined): string | null {
  const body = init?.body;
  if (body === undefined || body === null) {
    return null;
  }
  if (typeof body === "string") {
    return body;
  }
  throw new Error("Expected string request body");
}

function createFetchRecorder(
  args: CreateFetchRecorderArgs = {},
): FetchRecorder {
  const requests: RecordedFetchRequest[] = [];
  let eventPostCount = 0;
  let sessionOpenCount = 0;
  const fetchFn: FetchFn = async (input, init) => {
    const url = readFetchUrl(input);
    const request = {
      body: readFetchBody(init),
      method: init?.method ?? "GET",
      pathname: url.pathname,
    };
    requests.push(request);

    if (url.pathname === "/internal/session/open") {
      const sessionId =
        args.sessionIds?.[sessionOpenCount] ??
        args.sessionIds?.at(-1) ??
        "session-app-test";
      sessionOpenCount += 1;
      return Response.json(
        {
          sessionId,
          heartbeatIntervalMs: 30000,
          leaseTimeoutMs: 90000,
          retiredEnvironmentIds: args.retiredEnvironmentIds ?? [],
        },
        { status: 201 },
      );
    }
    if (url.pathname === "/internal/session/events") {
      eventPostCount += 1;
      if (args.inactiveSessionOnFirstEventPost && eventPostCount === 1) {
        return Response.json(
          {
            code: "inactive_session",
            message: "Session is not active",
            retryable: false,
          },
          { status: 401 },
        );
      }
      return Response.json({
        acceptedEvents: [],
        rejectedEvents: [],
      });
    }
    if (url.pathname === "/internal/session/interactive-request") {
      if (args.interactiveRequestError) {
        throw args.interactiveRequestError;
      }
      const response: HostDaemonInteractiveRequestResponse =
        args.interactiveRequestResponse ?? {
          outcome: "created",
          interactionId: "pint_app_test",
          status: "pending",
        };
      return Response.json(response);
    }
    if (url.pathname === "/internal/session/interactive-request/interrupt") {
      return Response.json({
        ok: true,
        interactionIds: ["pint_app_test"],
      });
    }

    if (
      /^\/internal\/plugins\/[^/]+\/host\/[a-f0-9]{64}$/u.test(url.pathname)
    ) {
      return new Response(new Uint8Array(DISPATCH_TEST_ARTIFACT_BYTES), {
        status: 200,
        headers: {
          "content-length": String(DISPATCH_TEST_ARTIFACT_BYTES.byteLength),
        },
      });
    }

    return new Response(`Unhandled test request: ${url.pathname}`, {
      status: 500,
    });
  };

  return {
    fetchFn,
    requests,
  };
}

function createOpeningWebSocket(): CreateReconnectingWebSocket {
  return (urlProvider) => {
    let readyState = 0;
    const socket: ReconnectingWebSocketLike = {
      get readyState() {
        return readyState;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: vi.fn(),
      close: vi.fn(() => {
        readyState = 3;
      }),
      reconnect: vi.fn(),
    };
    const openSocket = async () => {
      await urlProvider();
      queueMicrotask(() => {
        readyState = 1;
        socket.onopen?.({ type: "open" });
      });
    };
    socket.reconnect = vi.fn(() => {
      readyState = 3;
      socket.onclose?.({ code: 1000, reason: "test-reconnect" });
      void openSocket();
    });
    void openSocket();
    return socket;
  };
}

function createFakeRuntime(): AgentRuntime {
  return {
    async ensureProvider() {},
    async startThread() {
      return { providerThreadId: "provider-thread-app-test" };
    },
    async prepareThreadRewind() {
      return { providerThreadId: "provider-thread-rewind-app-test" };
    },
    async discardThreadRewind() {},
    async resumeThread() {
      return { providerThreadId: "provider-thread-app-test" };
    },
    async runTurn() {},
    async steerTurn() {
      return { status: "steered" };
    },
    async stopThread() {
      return { providerCheckpointId: null };
    },
    async clearThreadGoal() {
      return { cleared: true };
    },
    async renameThread() {},
    async archiveThread() {},
    async unarchiveThread() {},
    async listModels() {
      return {
        models: [],
        selectedOnlyModels: [],
      };
    },
    async providerHealth() {
      return { supported: false as const };
    },
    async providerUsage() {
      return { supported: false as const };
    },
    async providerInstallationStatus() {
      throw new Error("Unexpected provider installation status call");
    },
    async providerInstallationRun() {
      throw new Error("Unexpected provider installation run call");
    },
    listRunningProviders() {
      return [];
    },
    getActiveTurnId() {
      return null;
    },
    async waitForActiveTurn() {
      return null;
    },
    getProviderSession() {
      return null;
    },
    async reapIdleProviderSessions() {
      return { reapedSessions: [] };
    },
    hasThread() {
      return false;
    },
    getLiveThreadIds() {
      return [];
    },
    hasOpenBackgroundWork() {
      return false;
    },
    async shutdown() {},
  };
}

function createFakeRuntimeWithModelList(
  listModels: AgentRuntime["listModels"],
): AgentRuntime {
  return {
    ...createFakeRuntime(),
    listModels,
  };
}

function createCommandApprovalRequest(): PendingInteractionCreate {
  return {
    threadId: "thr_app_interactive",
    turnId: "turn_app_interactive",
    providerId: "codex",
    providerThreadId: "provider-thread-app-interactive",
    providerRequestId: "provider-request-app-interactive",
    payload: {
      kind: "approval",
      subject: {
        kind: "command",
        itemId: "item-app-interactive",
        command: "git status",
        cwd: "/tmp/project",
        actions: [],
        sessionGrant: null,
      },
      reason: "Needs approval",
      availableDecisions: ["allow_once", "deny"],
    },
  };
}

function createToolCallRequest(): ToolCallRequest {
  return {
    requestId: "provider-tool-request-app-test",
    threadId: "thr_app_tool",
    providerThreadId: "provider-thread-app-tool",
    turnId: "turn_app_tool",
    callId: "call-app-tool",
    tool: "message_user",
    arguments: {
      text: "hello",
    },
  };
}

async function settleReaperPromiseChain(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createAppFixture(
  args: CreateFetchRecorderArgs = {},
  options: { closeMachineAuthProxy?: () => Promise<void> } = {},
): Promise<HostDaemonAppFixture> {
  const dataDir = await makeTempDir("bb-host-daemon-app-test-");
  const fetchRecorder = createFetchRecorder(args);
  const logger = createLogger();
  const runtimeOptions: RuntimeOptionsRef = { current: null };
  const app = await createHostDaemonApp({
    dataDir,
    serverUrl: "http://127.0.0.1:3334",
    hostKey: "host-key-app-test",
    hostType: "persistent",
    hostId: "host-app-test",
    hostName: "App Test Host",
    instanceId: "instance-app-test",
    logger,
    releaseLock: async () => undefined,
    localApiConfig: null,
    createRuntime: (options) => {
      runtimeOptions.current = options;
      return createFakeRuntime();
    },
    fetchFn: fetchRecorder.fetchFn,
    createWebSocket: createOpeningWebSocket(),
    ...(options.closeMachineAuthProxy
      ? { closeMachineAuthProxy: options.closeMachineAuthProxy }
      : {}),
  });

  return {
    app,
    fetchRecorder,
    logger,
    runtimeOptions,
  };
}

describe("createHostDaemonApp", () => {
  it("closes the machine authentication proxy during daemon shutdown", async () => {
    const closeMachineAuthProxy = vi.fn(async () => undefined);
    const { app } = await createAppFixture({}, { closeMachineAuthProxy });

    await app.daemon.shutdown("test", 0);

    expect(closeMachineAuthProxy).toHaveBeenCalledTimes(1);
  });

  it("refreshes runtime shell env before provider model listing", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-app-models-");
    const fetchRecorder = createFetchRecorder();
    const logger = createLogger();
    const runtimeOptions: RuntimeOptionsRef = { current: null };
    const model = {
      id: "cursor-model",
      model: "cursor-model",
      displayName: "Cursor Model",
      description: "Test model",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "medium" as const,
      isDefault: true,
    };
    const listModels = vi.fn<AgentRuntime["listModels"]>(async () => ({
      models: [model],
      selectedOnlyModels: [],
    }));
    const resolveRuntimeShellEnv = vi.fn(async () => ({
      PATH: "/shell/bin:/usr/bin",
      BB_SERVER_URL: "http://127.0.0.1:3334",
    }));
    const app = await createHostDaemonApp({
      dataDir,
      serverUrl: "http://127.0.0.1:3334",
      hostKey: "host-key-app-test",
      hostType: "persistent",
      hostId: "host-app-test",
      hostName: "App Test Host",
      instanceId: "instance-app-test",
      logger,
      releaseLock: async () => undefined,
      localApiConfig: null,
      runtimeShellEnv: {
        PATH: "/old/bin:/usr/bin",
      },
      resolveRuntimeShellEnv,
      createRuntime: (options) => {
        runtimeOptions.current = options;
        return createFakeRuntimeWithModelList(listModels);
      },
      fetchFn: fetchRecorder.fetchFn,
      createWebSocket: createOpeningWebSocket(),
    });

    try {
      const response = await app.router.handleOnlineRpcRequest({
        type: "host-rpc.request",
        requestId: "provider-models-app-test",
        command: {
          type: "provider.list_models",
          providerId: "cursor",
          bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
        },
      });

      expect(response).toMatchObject({
        ok: true,
        result: {
          models: [model],
          selectedOnlyModels: [],
        },
      });
      expect(resolveRuntimeShellEnv).toHaveBeenCalledTimes(1);
      expect(runtimeOptions.current).toEqual(
        expect.objectContaining({
          env: {
            PATH: "/shell/bin:/usr/bin",
          },
          shellEnv: {
            PATH: "/shell/bin:/usr/bin",
            BB_SERVER_URL: "http://127.0.0.1:3334",
          },
        }),
      );
      expect(listModels).toHaveBeenCalledWith({
        providerId: "cursor",
        bridgeLaunch: {
          ...dispatchTestRuntimeBridgeLaunch(dataDir),
        },
      });

      await expect(
        app.router.handleOnlineRpcRequest({
          type: "host-rpc.request",
          requestId: "provider-models-app-test-again",
          command: {
            type: "provider.list_models",
            providerId: "cursor",
            bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
      });
      expect(resolveRuntimeShellEnv).toHaveBeenCalledTimes(1);
      expect(listModels).toHaveBeenCalledTimes(2);
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("reuses freshly resolved startup shell env for immediate model listing", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-app-startup-env-");
    const fetchRecorder = createFetchRecorder();
    const logger = createLogger();
    const runtimeOptions: RuntimeOptionsRef = { current: null };
    const model = {
      id: "codex-model",
      model: "codex-model",
      displayName: "Codex Model",
      description: "Test model",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "medium" as const,
      isDefault: true,
    };
    const listModels = vi.fn<AgentRuntime["listModels"]>(async () => ({
      models: [model],
      selectedOnlyModels: [],
    }));
    const resolveRuntimeShellEnv = vi.fn(async () => ({
      PATH: "/slow-shell/bin:/usr/bin",
      BB_SERVER_URL: "http://127.0.0.1:3334",
    }));
    const app = await createHostDaemonApp({
      dataDir,
      serverUrl: "http://127.0.0.1:3334",
      hostKey: "host-key-app-test",
      hostType: "persistent",
      hostId: "host-app-test",
      hostName: "App Test Host",
      instanceId: "instance-app-test",
      logger,
      releaseLock: async () => undefined,
      localApiConfig: null,
      runtimeShellEnv: {
        PATH: "/startup/bin:/usr/bin",
        BB_SERVER_URL: "http://127.0.0.1:3334",
      },
      runtimeShellEnvResolvedAtMs: 1_000,
      resolveRuntimeShellEnv,
      nowMs: () => 1_500,
      createRuntime: (options) => {
        runtimeOptions.current = options;
        return createFakeRuntimeWithModelList(listModels);
      },
      fetchFn: fetchRecorder.fetchFn,
      createWebSocket: createOpeningWebSocket(),
    });

    try {
      await expect(
        app.router.handleOnlineRpcRequest({
          type: "host-rpc.request",
          requestId: "provider-models-startup-env-test",
          command: {
            type: "provider.list_models",
            providerId: "codex",
            bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
      });

      expect(resolveRuntimeShellEnv).not.toHaveBeenCalled();
      expect(runtimeOptions.current).toEqual(
        expect.objectContaining({
          env: {
            PATH: "/startup/bin:/usr/bin",
          },
        }),
      );
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("runs the idle provider session reaper on a non-overlapping interval", async () => {
    const logger = createLogger();
    const firstReap =
      createDeferredPromise<RuntimeManagerReapIdleProviderSessionsResult>();
    const failure = new Error("reaper failed");
    const queuedReaps: Array<
      () => Promise<RuntimeManagerReapIdleProviderSessionsResult>
    > = [
      () => firstReap.promise,
      async () => {
        throw failure;
      },
    ];
    const reapIdleProviderSessions = vi.fn(
      (
        _args: RuntimeManagerReapIdleProviderSessionsArgs,
      ): Promise<RuntimeManagerReapIdleProviderSessionsResult> => {
        const next = queuedReaps.shift();
        return next
          ? next()
          : Promise.resolve({
              reapedSessions: [],
            });
      },
    );
    let nowMs = 1_000;
    let intervalCallback: (() => void) | null = null;
    let cleared = false;
    const timer: ReturnType<
      StartIdleProviderSessionReaperArgsForTest["setIntervalFn"]
    > = {
      clear: vi.fn(() => {
        cleared = true;
      }),
      unref: vi.fn(),
    };
    const setIntervalFn = vi.fn<
      StartIdleProviderSessionReaperArgsForTest["setIntervalFn"]
    >((callback, _intervalMs) => {
      intervalCallback = callback;
      return timer;
    });
    const triggerTick = (): void => {
      if (!intervalCallback || cleared) {
        return;
      }
      intervalCallback();
    };

    const reaper = startIdleProviderSessionReaper({
      logger,
      nowMs: () => nowMs,
      runtimeManager: {
        reapIdleProviderSessions,
      },
      setIntervalFn,
    });

    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 300_000);
    expect(timer.unref).toHaveBeenCalledTimes(1);

    triggerTick();
    await settleReaperPromiseChain();
    expect(reapIdleProviderSessions).toHaveBeenCalledTimes(1);
    expect(reapIdleProviderSessions).toHaveBeenNthCalledWith(1, {
      idleForMs: 1_800_000,
      nowMs: 1_000,
    });

    nowMs = 2_000;
    triggerTick();
    expect(reapIdleProviderSessions).toHaveBeenCalledTimes(1);

    firstReap.resolve({
      reapedSessions: [
        {
          environmentId: "env-reaped",
          idleForMs: 1_900_000,
          providerId: "codex",
          providerThreadId: "provider-thread-reaped",
          threadId: "thread-reaped",
        },
      ],
    });
    await settleReaperPromiseChain();
    expect(logger.info).toHaveBeenCalledWith(
      {
        count: 1,
        sessions: [
          {
            environmentId: "env-reaped",
            idleForMs: 1_900_000,
            providerId: "codex",
            threadId: "thread-reaped",
          },
        ],
      },
      "Reaped idle provider sessions",
    );

    triggerTick();
    await settleReaperPromiseChain();
    expect(reapIdleProviderSessions).toHaveBeenCalledTimes(2);
    expect(reapIdleProviderSessions).toHaveBeenNthCalledWith(2, {
      idleForMs: 1_800_000,
      nowMs: 2_000,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      {
        err: failure,
      },
      "Idle provider session reaper failed",
    );

    reaper.stop();
    expect(timer.clear).toHaveBeenCalledTimes(1);
    triggerTick();
    expect(reapIdleProviderSessions).toHaveBeenCalledTimes(2);
  });

  it("reconnects through the server connection when event posting sees an inactive session", async () => {
    const { app, fetchRecorder, logger } = await createAppFixture({
      inactiveSessionOnFirstEventPost: true,
      sessionIds: ["session-app-test-1", "session-app-test-2"],
    });
    try {
      await app.connection.start();

      app.eventSink.emit({
        threadId: "thr_app_inactive_session",
        event: {
          type: "turn/started",
          threadId: "thr_app_inactive_session",
          providerThreadId: "provider-thread-app-inactive-session",
          scope: turnScope("turn-app-inactive-session"),
        },
      });

      await vi.waitFor(() => {
        expect(
          fetchRecorder.requests.filter(
            (request) => request.pathname === "/internal/session/open",
          ),
        ).toHaveLength(2);
      });
      expect(logger.info).toHaveBeenCalledWith(
        {
          code: "inactive_session",
          sessionId: "session-app-test-1",
          source: "postEvents",
        },
        "Server reported inactive daemon session; reconnecting",
      );
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("forgets server-retired loaded environments when opening a session", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-app-retired-");
    const workspacePath = await makeTempDir(
      "bb-host-daemon-retired-workspace-",
    );
    const logger = createLogger();
    const fetchRecorder = createFetchRecorder({
      retiredEnvironmentIds: ["env-app-retired"],
    });
    const stopWatchingStatus = vi.fn(async () => undefined);
    const runtime = {
      ...createFakeRuntime(),
      shutdown: vi.fn(async () => undefined),
    } satisfies AgentRuntime;
    const hostWatcher = {
      watchWorkspace: vi.fn(() => stopWatchingStatus),
      watchThreadStorageRoot: vi.fn(() => () => undefined),
    } satisfies HostWatcher;
    const app = await createHostDaemonApp({
      dataDir,
      serverUrl: "http://127.0.0.1:3334",
      hostKey: "host-key-retired-env",
      hostType: "persistent",
      hostId: "host-retired-env",
      hostName: "Retired Environment Host",
      instanceId: "instance-retired-env",
      logger,
      releaseLock: async () => undefined,
      localApiConfig: null,
      createRuntime: () => runtime,
      fetchFn: fetchRecorder.fetchFn,
      hostWatcher,
      createWebSocket: createOpeningWebSocket(),
    });

    try {
      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-retired",
        workspacePath,
      });
      expect(app.runtimeManager.get("env-app-retired")).toBeDefined();

      await app.connection.start();

      expect(app.runtimeManager.get("env-app-retired")).toBeUndefined();
      expect(stopWatchingStatus).not.toHaveBeenCalled();
      expect(runtime.shutdown).toHaveBeenCalledTimes(1);
      const openSessionBody = fetchRecorder.requests
        .filter((request) => request.pathname === "/internal/session/open")
        .map((request) => JSON.parse(request.body ?? "{}"));
      expect(openSessionBody[0]).toMatchObject({
        localApiPort: null,
        loadedEnvironments: [{ environmentId: "env-app-retired" }],
      });
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("logs raw stderr for unexpected provider process exits", async () => {
    const { app, logger, runtimeOptions } = await createAppFixture();
    try {
      const workspacePath = await makeTempDir(
        "bb-host-daemon-app-log-workspace-",
      );
      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-provider-exit-log",
        workspacePath,
      });
      const options = runtimeOptions.current;
      if (!options?.onProcessExit) {
        throw new Error("Expected process exit callback to be captured");
      }

      options.onProcessExit({
        providerId: "codex",
        threads: [
          {
            threadId: "thr_provider_exit_log",
            activeTurnId: null,
            pendingTurnStart: false,
            providerThreadId: null,
          },
        ],
        code: 1,
        expected: false,
        signal: null,
        stderr: "OPENAI_API_KEY=sk-test-secret\nUsage limit reached.",
      });

      expect(logger.warn).toHaveBeenCalledWith(
        {
          providerId: "codex",
          threadIds: ["thr_provider_exit_log"],
          code: 1,
          signal: null,
          stderr: "OPENAI_API_KEY=sk-test-secret\nUsage limit reached.",
        },
        "Unexpected provider process exited with stderr",
      );
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("posts a failure event when a provider exits before turn/started", async () => {
    const { app, fetchRecorder, runtimeOptions } = await createAppFixture();
    try {
      const workspacePath = await makeTempDir(
        "bb-host-daemon-app-pending-turn-exit-",
      );
      await app.connection.start();
      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-pending-turn-exit",
        workspacePath,
      });
      const options = runtimeOptions.current;
      if (!options?.onProcessExit) {
        throw new Error("Expected process exit callback to be captured");
      }

      options.onProcessExit({
        providerId: "claude-code",
        threads: [
          {
            threadId: "thr_pending_turn_exit",
            activeTurnId: null,
            pendingTurnStart: true,
            providerThreadId: "provider-pending-turn-exit",
          },
        ],
        code: 1,
        expected: false,
        signal: null,
        stderr: null,
      });

      await vi.waitFor(() => {
        expect(
          fetchRecorder.requests.filter(
            (request) => request.pathname === "/internal/session/events",
          ),
        ).toHaveLength(1);
      });
      const eventRequest = fetchRecorder.requests.find(
        (request) => request.pathname === "/internal/session/events",
      );
      const payload = hostDaemonEventBatchRequestSchema.parse(
        JSON.parse(eventRequest?.body ?? "{}"),
      );
      expect(payload).toEqual({
        sessionId: "session-app-test",
        eventGroups: [
          {
            threadId: "thr_pending_turn_exit",
            events: [
              {
                type: "system/error",
                threadId: "thr_pending_turn_exit",
                scope: threadScope(),
                code: "provider_process_exited",
                message:
                  'Provider "claude-code" exited unexpectedly with code 1',
              },
            ],
          },
        ],
      });
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("interrupts pending interactive requests when an expected provider exit affects their threads", async () => {
    const { app, fetchRecorder, runtimeOptions } = await createAppFixture();
    try {
      const workspacePath = await makeTempDir("bb-host-daemon-app-workspace-");
      await app.connection.start();
      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-interactive",
        workspacePath,
      });
      const options = runtimeOptions.current;
      if (!options?.onInteractiveRequest || !options.onProcessExit) {
        throw new Error("Expected runtime callbacks to be captured");
      }

      const request = createCommandApprovalRequest();
      const pending = options.onInteractiveRequest(request);
      await vi.waitFor(() => {
        expect(
          fetchRecorder.requests.filter(
            (record) =>
              record.pathname === "/internal/session/interactive-request",
          ),
        ).toHaveLength(1);
      });

      const pendingRejection = expect(pending).rejects.toThrow(
        'Provider "codex" exited while awaiting user interaction',
      );
      options.onProcessExit({
        providerId: "codex",
        threads: [
          {
            threadId: request.threadId,
            activeTurnId: request.turnId,
            pendingTurnStart: false,
            providerThreadId: request.providerThreadId,
          },
        ],
        code: null,
        expected: true,
        signal: "SIGTERM",
        stderr: null,
      });

      await pendingRejection;
      await vi.waitFor(() => {
        expect(
          fetchRecorder.requests.filter(
            (record) =>
              record.pathname ===
              "/internal/session/interactive-request/interrupt",
          ),
        ).toHaveLength(1);
      });
      const interruptRequest = fetchRecorder.requests.find(
        (record) =>
          record.pathname === "/internal/session/interactive-request/interrupt",
      );
      if (!interruptRequest?.body) {
        throw new Error("Expected interactive interrupt request body");
      }
      const payload = hostDaemonInteractiveInterruptRequestSchema.parse(
        JSON.parse(interruptRequest.body),
      );
      expect(payload).toEqual({
        sessionId: "session-app-test",
        providerId: "codex",
        threadIds: [request.threadId],
        reason: 'Provider "codex" exited while awaiting user interaction',
      });
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("logs stack-bearing fields for dynamic tool forwarding failures", async () => {
    const { app, logger, runtimeOptions } = await createAppFixture();
    try {
      const workspacePath = await makeTempDir("bb-host-daemon-app-tool-");
      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-tool",
        workspacePath,
      });
      await app.connection.start();
      const options = runtimeOptions.current;
      if (!options?.onToolCall) {
        throw new Error("Expected tool call callback to be captured");
      }

      const request = createToolCallRequest();
      await expect(options.onToolCall(request)).rejects.toThrow(
        "Failed to call tool",
      );

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          callId: request.callId,
          err: expect.any(Error),
          providerThreadId: request.providerThreadId,
          threadId: request.threadId,
          tool: request.tool,
          turnId: request.turnId,
        }),
        "Failed to forward dynamic tool call to server",
      );
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("logs stack-bearing fields for unexpected interactive forwarding failures", async () => {
    const registrationError = new Error("registration transport failed");
    const { app, logger, runtimeOptions } = await createAppFixture({
      interactiveRequestError: registrationError,
    });
    try {
      const workspacePath = await makeTempDir(
        "bb-host-daemon-app-interactive-error-",
      );
      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-interactive-error",
        workspacePath,
      });
      await app.connection.start();
      const options = runtimeOptions.current;
      if (!options?.onInteractiveRequest) {
        throw new Error("Expected interactive request callback to be captured");
      }

      const request = createCommandApprovalRequest();
      await expect(options.onInteractiveRequest(request)).rejects.toThrow(
        "registration transport failed",
      );

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: registrationError,
          kind: request.payload.kind,
          providerRequestId: request.providerRequestId,
          providerThreadId: request.providerThreadId,
          threadId: request.threadId,
          turnId: request.turnId,
        }),
        "Failed to forward interactive provider request to server",
      );
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("logs rejected interactive request registrations with a structured code", async () => {
    const { app, logger, runtimeOptions } = await createAppFixture({
      interactiveRequestResponse: {
        outcome: "rejected",
        reason: "Ask User Question feature is disabled",
      },
    });
    try {
      const workspacePath = await makeTempDir(
        "bb-host-daemon-app-rejected-interactive-",
      );
      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-rejected-interactive",
        workspacePath,
      });
      await app.connection.start();
      const options = runtimeOptions.current;
      if (!options?.onInteractiveRequest) {
        throw new Error("Expected interactive request callback to be captured");
      }

      const request = createCommandApprovalRequest();
      await expect(options.onInteractiveRequest(request)).rejects.toThrow(
        "Ask User Question feature is disabled",
      );

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          errorMessage: "Ask User Question feature is disabled",
          errorName: "InteractiveRequestRegistryError",
          interactiveRequestErrorCode: "interactive_request_rejected",
          kind: request.payload.kind,
          providerRequestId: request.providerRequestId,
          providerThreadId: request.providerThreadId,
          threadId: request.threadId,
          turnId: request.turnId,
        }),
        "Interactive provider request rejected by server",
      );
      expect(logger.error).not.toHaveBeenCalledWith(
        expect.anything(),
        "Failed to forward interactive provider request to server",
      );
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });
});
