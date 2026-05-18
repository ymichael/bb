import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime, AgentRuntimeOptions } from "@bb/agent-runtime";
import type { PendingInteractionCreate } from "@bb/domain";
import {
  hostDaemonInteractiveInterruptRequestSchema,
  type HostDaemonInteractiveRequestResponse,
} from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommandFetchLoop,
  createHostDaemonApp,
  type HostDaemonApp,
} from "./app.js";
import type { HostDaemonLogger } from "./logger.js";
import type { CreateReconnectingWebSocket } from "./server-connection.js";
import type { ReconnectingWebSocketLike } from "./server-connection-support.js";

interface Deferred<TValue> {
  promise: Promise<TValue>;
  resolve: (value: TValue | PromiseLike<TValue>) => void;
  reject: (reason?: Error) => void;
}

interface TestCommand {
  id: string;
}

interface RecordedFetchRequest {
  body: string | null;
  method: string;
  pathname: string;
}

interface FetchRecorder {
  fetchFn: typeof fetch;
  requests: RecordedFetchRequest[];
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

type HandleCommands = (commands: TestCommand[]) => Promise<void>;

const tempDirs: string[] = [];

function createDeferred<TValue>(): Deferred<TValue> {
  let resolve!: Deferred<TValue>["resolve"];
  let reject!: Deferred<TValue>["reject"];
  const promise = new Promise<TValue>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies HostDaemonLogger;
}

function handledCommandIds(
  handleCommands: ReturnType<typeof vi.fn<HandleCommands>>,
): string[] {
  return handleCommands.mock.calls.flatMap(([commands]) =>
    commands.map((command) => command.id),
  );
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

function createFetchRecorder(): FetchRecorder {
  const requests: RecordedFetchRequest[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = readFetchUrl(input);
    const request = {
      body: readFetchBody(init),
      method: init?.method ?? "GET",
      pathname: url.pathname,
    };
    requests.push(request);

    if (url.pathname === "/internal/session/open") {
      return Response.json(
        {
          sessionId: "session-app-test",
          heartbeatIntervalMs: 30000,
          leaseTimeoutMs: 90000,
          trackedThreadTargets: [],
        },
        { status: 201 },
      );
    }
    if (url.pathname === "/internal/session/commands") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/internal/session/events") {
      return Response.json({
        acceptedEvents: [],
        rejectedEvents: [],
      });
    }
    if (url.pathname === "/internal/session/interactive-request") {
      const response: HostDaemonInteractiveRequestResponse = {
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
    void urlProvider().then(() => {
      queueMicrotask(() => {
        readyState = 1;
        socket.onopen?.({ type: "open" });
      });
    });
    return socket;
  };
}

function createFakeRuntime(): AgentRuntime {
  return {
    async ensureProvider() {},
    async startThread() {
      return { providerThreadId: "provider-thread-app-test" };
    },
    async resumeThread() {
      return { providerThreadId: "provider-thread-app-test" };
    },
    async runTurn() {},
    async steerTurn() {
      return { status: "steered" };
    },
    async stopThread() {},
    async renameThread() {},
    async archiveThread() {},
    async unarchiveThread() {},
    async listModels() {
      return {
        models: [],
        selectedOnlyModels: [],
      };
    },
    listRunningProviders() {
      return [];
    },
    async shutdown() {},
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

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createAppFixture(): Promise<HostDaemonAppFixture> {
  const dataDir = await makeTempDir("bb-host-daemon-app-test-");
  const fetchRecorder = createFetchRecorder();
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
  });

  return {
    app,
    fetchRecorder,
    logger,
    runtimeOptions,
  };
}

describe("createCommandFetchLoop", () => {
  it("retries fetching commands with exponential backoff after transient failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const logger = createLogger();
    const fetchCommands = vi
      .fn<() => Promise<TestCommand[]>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("still down"))
      .mockResolvedValueOnce([]);
    const handleCommands = vi.fn(async () => undefined);
    const loop = createCommandFetchLoop({
      logger,
      fetchCommands,
      handleCommands,
    });

    await loop.request();

    expect(fetchCommands).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchCommands).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchCommands).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3_999);
    expect(fetchCommands).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchCommands).toHaveBeenCalledTimes(3);
    expect(handleCommands).not.toHaveBeenCalled();
  });

  it("jitters command fetch retry timing", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const logger = createLogger();
    const fetchCommands = vi
      .fn<() => Promise<TestCommand[]>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([]);
    const handleCommands = vi.fn(async () => undefined);
    const loop = createCommandFetchLoop({
      logger,
      fetchCommands,
      handleCommands,
    });

    await loop.request();

    await vi.advanceTimersByTimeAsync(1_499);
    expect(fetchCommands).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchCommands).toHaveBeenCalledTimes(2);
  });

  it("fetches newly requested commands while a previous batch is still running", async () => {
    const firstBatchDone = createDeferred<void>();
    const logger = createLogger();
    const firstBatch = [{ id: "slow-command" }];
    const secondBatch = [{ id: "later-thread" }];
    let nextBatch: TestCommand[] = firstBatch;
    let firstHandlerCompleted = false;
    const fetchCommands = vi.fn(async () => {
      const batch = nextBatch;
      nextBatch = [];
      return batch;
    });
    const handleCommands = vi.fn(async (commands: TestCommand[]) => {
      if (commands[0] === firstBatch[0]) {
        await firstBatchDone.promise;
        firstHandlerCompleted = true;
      }
    });
    const loop = createCommandFetchLoop({
      logger,
      fetchCommands,
      handleCommands,
    });

    const firstRequest = loop.request();
    await vi.waitFor(() => {
      expect(handleCommands).toHaveBeenCalledWith(firstBatch);
    });

    nextBatch = secondBatch;
    const secondRequest = loop.request();
    await vi.waitFor(() => {
      expect(handleCommands).toHaveBeenCalledWith(secondBatch);
    });
    expect(firstHandlerCompleted).toBe(false);

    firstBatchDone.resolve();
    await Promise.all([firstRequest, secondRequest]);

    expect(handleCommands).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid in-flight command limits", () => {
    const logger = createLogger();
    const fetchCommands = vi.fn(async () => []);
    const handleCommands = vi.fn(async () => undefined);

    expect(() =>
      createCommandFetchLoop({
        logger,
        fetchCommands,
        handleCommands,
        maxInFlightCommands: 0,
      }),
    ).toThrow("maxInFlightCommands must be a finite number >= 1");
  });

  it("limits concurrently handled commands", async () => {
    const firstCommandDone = createDeferred<void>();
    const secondCommandDone = createDeferred<void>();
    const logger = createLogger();
    const commands = [{ id: "one" }, { id: "two" }, { id: "three" }];
    const fetchCommands = vi
      .fn<() => Promise<TestCommand[]>>()
      .mockResolvedValueOnce(commands)
      .mockResolvedValue([]);
    const handleCommands = vi.fn(async (batch: TestCommand[]) => {
      const command = batch[0];
      if (command?.id === "one") {
        await firstCommandDone.promise;
      }
      if (command?.id === "two") {
        await secondCommandDone.promise;
      }
    });
    const loop = createCommandFetchLoop({
      logger,
      fetchCommands,
      handleCommands,
      maxInFlightCommands: 2,
    });

    await loop.request();
    await vi.waitFor(() => {
      expect(handledCommandIds(handleCommands)).toEqual(["one", "two"]);
    });

    firstCommandDone.resolve();
    await vi.waitFor(() => {
      expect(handledCommandIds(handleCommands)).toEqual([
        "one",
        "two",
        "three",
      ]);
    });
    secondCommandDone.resolve();
    await loop.stopAndDrain();
  });

  it("retries fetching commands after handler failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const logger = createLogger();
    const fetchCommands = vi
      .fn<() => Promise<TestCommand[]>>()
      .mockResolvedValueOnce([{ id: "bad-command" }])
      .mockResolvedValueOnce([]);
    const handleCommands = vi.fn(async () => {
      throw new Error("handler boom");
    });
    const loop = createCommandFetchLoop({
      logger,
      fetchCommands,
      handleCommands,
      maxInFlightCommands: 1,
      retryDelayMs: 2_000,
    });

    await loop.request();
    await Promise.resolve();
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "Failed to handle host-daemon commands",
    );
    expect(fetchCommands).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchCommands).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(fetchCommands).toHaveBeenCalledTimes(2);
    });
  });

  it("waits for active and queued handlers before shutdown drain completes", async () => {
    const firstCommandDone = createDeferred<void>();
    const logger = createLogger();
    const commands = [{ id: "one" }, { id: "two" }];
    const fetchCommands = vi
      .fn<() => Promise<TestCommand[]>>()
      .mockResolvedValueOnce(commands)
      .mockResolvedValue([]);
    const handleCommands = vi.fn(async (batch: TestCommand[]) => {
      if (batch[0]?.id === "one") {
        await firstCommandDone.promise;
      }
    });
    const loop = createCommandFetchLoop({
      logger,
      fetchCommands,
      handleCommands,
      maxInFlightCommands: 1,
    });

    await loop.request();
    await vi.waitFor(() => {
      expect(handledCommandIds(handleCommands)).toEqual(["one"]);
    });

    let drainCompleted = false;
    const drainPromise = loop.stopAndDrain().then(() => {
      drainCompleted = true;
    });
    await Promise.resolve();
    expect(drainCompleted).toBe(false);

    firstCommandDone.resolve();
    await drainPromise;
    expect(handledCommandIds(handleCommands)).toEqual(["one", "two"]);
  });
});

describe("createHostDaemonApp", () => {
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
        threadIds: ["thr_provider_exit_log"],
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
      await app.daemon.shutdown("test");
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
        threadIds: [request.threadId],
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
      await app.daemon.shutdown("test");
    }
  });
});
