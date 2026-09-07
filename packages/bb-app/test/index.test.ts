import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resolvePortFromEnv } from "@bb/config/runtime";
import {
  assertBbAppArtifacts,
  assertBbHostArtifacts,
  completeFullStackSupervision,
  createDaemonEnv,
  createHostEnrollKeyRequestBody,
  createServerEnv,
  createHostDaemonJoinEnv,
  parseLauncherArgs,
  readBbAppPackageVersion,
  resolveBbAppRuntimeState,
  resolveDataDir,
  resolveBbAppStartContext,
  resolveBbAppCommand,
  resolveServerListenerUrl,
  resolveWorktreeRuntimePolicy,
  runBbApp,
  runBundledCliCommand,
  superviseFullStackProcesses,
  terminateManagedFullStackProcesses,
  waitForHostDaemonStatus,
  waitForProcessExit,
} from "../src/launcher.js";
import type {
  BbAppStartContext,
  DelayMillisecondsArgs,
  DelayMillisecondsFn,
  FullStackSupervisionResult,
  ManagedFullStackProcesses,
  ManagedProcessName,
  ManagedProcessRun,
  NamedProcessExitResult,
  ProcessExitResult,
} from "../src/launcher.js";

interface DelayArgs {
  ms: number;
}

interface ControlledDelayCall {
  ms: number;
  resolve(): void;
}

interface ConfigReloadTestServer {
  close(): Promise<void>;
  port: number;
  reloadCount(): number;
  reloadRequests(): ConfigReloadRequest[];
  url: string;
}

interface HostListTestServer {
  close(): Promise<void>;
  requests(): string[];
  url: string;
}

interface ConfigReloadRequest {
  host: string | undefined;
  method: string | undefined;
  url: string | undefined;
}

interface InvalidConfigCommandCase {
  expectedError: RegExp;
  key: string;
  value: string;
}

interface StartupOnlyManagedEnvCase {
  key: string;
  value: string;
}

type DelayResult = "timeout";
type ResolveFakeManagedProcessExit = (result: NamedProcessExitResult) => void;
type StartFakeManagedProcess = () => Promise<ManagedProcessRun>;

interface FakeManagedProcessRunArgs {
  id: string;
  processName: ManagedProcessName;
}

interface WaitForProcessReplacementArgs {
  currentRun: () => ManagedProcessRun | null;
  previousRun: ManagedProcessRun;
}

interface WaitForDelayCallArgs {
  delay: ControlledDelay;
  index: number;
}

interface FakeSupervisor {
  daemonRuns: FakeManagedProcessRun[];
  daemonStart: StartFakeManagedProcess;
  processes: ManagedFullStackProcesses;
  serverRuns: FakeManagedProcessRun[];
  serverStart: StartFakeManagedProcess;
  setShutdownRequested(value: boolean): void;
  shutdownRequested(): boolean;
}

const invalidConfigCommandCases: InvalidConfigCommandCase[] = [
  {
    expectedError: /BB_INFERENCE must use provider\/model format/u,
    key: "BB_INFERENCE",
    value: "gpt-4o-mini",
  },
  {
    expectedError: /BB_INFERENCE_FALLBACK must use provider\/model format/u,
    key: "BB_INFERENCE_FALLBACK",
    value: "gpt-5.4-mini",
  },
  {
    expectedError: /BB_TRANSCRIPTION must use provider\/model format/u,
    key: "BB_TRANSCRIPTION",
    value: "gpt-4o-mini-transcribe",
  },
  {
    expectedError: /BB_APP_URL must be a valid URL/u,
    key: "BB_APP_URL",
    value: "not-a-url",
  },
  {
    expectedError: /BB_SERVER_URL must be a valid URL/u,
    key: "BB_SERVER_URL",
    value: "not-a-url",
  },
  {
    expectedError: /BB_LOG_LEVEL must be one of/u,
    key: "BB_LOG_LEVEL",
    value: "bogus",
  },
];

const startupOnlyManagedEnvCases: StartupOnlyManagedEnvCase[] = [
  { key: "BB_APP_SURFACE", value: "desktop" },
  { key: "BB_APP_URL", value: "https://app.example.test" },
  { key: "BB_DATA_DIR", value: "/tmp/bb-managed-data" },
  { key: "BB_DEV_APP_PORT", value: "4173" },
  { key: "BB_EXTERNAL_URL", value: "https://external.example.test" },
  { key: "BB_FF_PLACEHOLDER", value: "true" },
  { key: "BB_FF_TIMELINE_WINDOW_EVENT_BUDGET", value: "2000" },
  { key: "BB_HOST_DAEMON_PORT", value: "48887" },
  { key: "BB_INFERENCE", value: "codex/test-inference" },
  {
    key: "BB_INFERENCE_FALLBACK",
    value: "codex/test-inference-fallback",
  },
  { key: "BB_INHERITED_SKILLS_ROOTS", value: "/tmp/bb-skills" },
  { key: "BB_LOG_LEVEL", value: "debug" },
  { key: "BB_MANAGED_DEV_BUILTIN_PLUGIN_HOT_RELOAD", value: "1" },
  { key: "BB_POSTHOG_API_KEY", value: "test-posthog-key" },
  { key: "BB_SERVER_BIND_HOST", value: "127.0.0.1" },
  { key: "BB_SERVER_PORT", value: "48886" },
  { key: "BB_TELEMETRY", value: "false" },
  { key: "BB_TRANSCRIPTION", value: "codex/test-transcription" },
];

const packageMetadataSchema = z.object({
  engines: z.object({
    node: z.string(),
  }),
  files: z.array(z.string()),
  os: z.array(z.string()),
});

type PackageMetadata = z.infer<typeof packageMetadataSchema>;

class FakeManagedProcessRun implements ManagedProcessRun {
  readonly exit: Promise<NamedProcessExitResult>;
  readonly id: string;
  readonly processName: ManagedProcessName;
  readonly terminationSignals: NodeJS.Signals[] = [];
  running = true;
  private resolveExit: ResolveFakeManagedProcessExit = () => undefined;

  constructor(args: FakeManagedProcessRunArgs) {
    this.id = args.id;
    this.processName = args.processName;
    this.exit = new Promise<NamedProcessExitResult>((resolvePromise) => {
      this.resolveExit = resolvePromise;
    });
  }

  exitWith(result: ProcessExitResult): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.resolveExit({ processName: this.processName, result });
  }

  async terminate(signal: NodeJS.Signals): Promise<void> {
    this.terminationSignals.push(signal);
    this.exitWith({ code: null, signal });
  }
}

class ControlledDelay {
  readonly calls: ControlledDelayCall[] = [];

  async delayMilliseconds(args: DelayMillisecondsArgs): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      this.calls.push({
        ms: args.ms,
        resolve: resolvePromise,
      });
    });
  }
}

function delay(args: DelayArgs): Promise<DelayResult> {
  return new Promise((resolvePromise) => {
    setTimeout(() => {
      resolvePromise("timeout");
    }, args.ms);
  });
}

const immediateDelay: DelayMillisecondsFn = () => {
  return Promise.resolve();
};

function createTestStartContext(): BbAppStartContext {
  return {
    appDistDir: "/tmp/bb-app-test/app/dist",
    appVersion: "0.0.0-test",
    configFile: "/tmp/bb-app-test/config.json",
    daemonBundleDir: "/tmp/bb-app-test/host-daemon/dist",
    daemonEntry: "/tmp/bb-app-test/host-daemon/dist/daemon-bundle.mjs",
    daemonLockDir: "/tmp/bb-app-test/daemon.lock.lock",
    daemonLockFile: "/tmp/bb-app-test/daemon.lock",
    daemonPort: 38887,
    dataDir: "/tmp/bb-app-test",
    dbPath: "/tmp/bb-app-test/bb.db",
    envFile: "/tmp/bb-app-test/env.json",
    logDir: "/tmp/bb-app-test/logs",
    packageRoot: "/tmp/bb-app-test/package",
    serverEntry: "/tmp/bb-app-test/server/dist/index.js",
    serverPort: 38886,
    serverUrl: "http://127.0.0.1:38886",
  };
}

function createFakeSupervisor(): FakeSupervisor {
  let shutdownRequested = false;
  const serverRuns = [
    new FakeManagedProcessRun({ id: "server-1", processName: "server" }),
  ];
  const daemonRuns = [
    new FakeManagedProcessRun({ id: "daemon-1", processName: "daemon" }),
  ];
  const processes: ManagedFullStackProcesses = {
    daemonRun: daemonRuns[0],
    serverRun: serverRuns[0],
  };
  const serverStart = async (): Promise<ManagedProcessRun> => {
    const run = new FakeManagedProcessRun({
      id: `server-${serverRuns.length + 1}`,
      processName: "server",
    });
    serverRuns.push(run);
    processes.serverRun = run;
    return run;
  };
  const daemonStart = async (): Promise<ManagedProcessRun> => {
    const run = new FakeManagedProcessRun({
      id: `daemon-${daemonRuns.length + 1}`,
      processName: "daemon",
    });
    daemonRuns.push(run);
    processes.daemonRun = run;
    return run;
  };
  return {
    daemonRuns,
    daemonStart,
    processes,
    serverRuns,
    serverStart,
    setShutdownRequested(value) {
      shutdownRequested = value;
    },
    shutdownRequested() {
      return shutdownRequested;
    },
  };
}

async function waitForProcessReplacement(
  args: WaitForProcessReplacementArgs,
): Promise<ManagedProcessRun> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const currentRun = args.currentRun();
    if (currentRun !== null && currentRun !== args.previousRun) {
      return currentRun;
    }
    await delay({ ms: 1 });
  }
  throw new Error("Timed out waiting for process replacement");
}

async function waitForDelayCall(
  args: WaitForDelayCallArgs,
): Promise<ControlledDelayCall> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const call = args.delay.calls[args.index];
    if (call !== undefined) {
      return call;
    }
    await delay({ ms: 1 });
  }
  throw new Error("Timed out waiting for restart throttle delay");
}

async function stopFakeSupervisor(
  supervisor: FakeSupervisor,
  supervision: Promise<FullStackSupervisionResult>,
): Promise<FullStackSupervisionResult> {
  supervisor.setShutdownRequested(true);
  await terminateManagedFullStackProcesses({
    processes: supervisor.processes,
    signal: "SIGTERM",
  });
  return supervision;
}

async function startConfigReloadTestServer(): Promise<ConfigReloadTestServer> {
  const reloadRequests: ConfigReloadRequest[] = [];
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      if (
        request.method === "POST" &&
        request.url === "/api/v1/system/config/reload"
      ) {
        reloadRequests.push({
          host: request.headers.host,
          method: request.method,
          url: request.url,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "not_found", message: "Not found" }));
    },
  );

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolvePromise();
    });
  });

  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Expected test server to listen on a TCP port");
  }
  const addressInfo: AddressInfo = address;

  return {
    async close(): Promise<void> {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolvePromise();
        });
      });
    },
    port: addressInfo.port,
    reloadCount(): number {
      return reloadRequests.length;
    },
    reloadRequests(): ConfigReloadRequest[] {
      return [...reloadRequests];
    },
    url: `http://127.0.0.1:${addressInfo.port}`,
  };
}

async function startHostListTestServer(
  hosts: unknown[],
): Promise<HostListTestServer> {
  const requests: string[] = [];
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      if (request.method === "GET" && request.url === "/api/v1/hosts") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(hosts));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "not_found", message: "Not found" }));
    },
  );

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolvePromise();
    });
  });

  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Expected test server to listen on a TCP port");
  }
  const addressInfo: AddressInfo = address;

  return {
    async close(): Promise<void> {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolvePromise();
        });
      });
    },
    requests(): string[] {
      return [...requests];
    },
    url: `http://127.0.0.1:${addressInfo.port}`,
  };
}

function readPackageMetadata(): PackageMetadata {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return packageMetadataSchema.parse(
    JSON.parse(readFileSync(resolve(testDir, "..", "package.json"), "utf8")),
  );
}

function expectedConfigReloadRequest(
  server: ConfigReloadTestServer,
): ConfigReloadRequest {
  return {
    host: `127.0.0.1:${server.port}`,
    method: "POST",
    url: "/api/v1/system/config/reload",
  };
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  try {
    await run();
  } finally {
    write.mockRestore();
  }
  return chunks.join("");
}

describe("bb-app launcher", () => {
  it("waits for the expected host daemon identity and connection", async () => {
    let statusRequests = 0;
    const server = createServer((request, response) => {
      if (request.url !== "/status") {
        response.writeHead(404).end();
        return;
      }
      statusRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          connected: statusRequests >= 2,
          hostId: "host-expected",
          serverUrl: "http://127.0.0.1:38886/",
        }),
      );
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected status test server to have a TCP address");
    }

    try {
      await waitForHostDaemonStatus({
        childProcess: null,
        expectedHostId: "host-expected",
        expectedServerUrl: "http://localhost:38886",
        port: address.port,
        timeoutMs: 1_000,
      });
      expect(statusRequests).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
    }
  });

  it("does not accept another daemon's successful health response", async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        request.url === "/health"
          ? JSON.stringify({ ok: true })
          : JSON.stringify({
              connected: true,
              hostId: "host-other",
              serverUrl: "https://other.example.test",
            }),
      );
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected status test server to have a TCP address");
    }

    try {
      await expect(
        waitForHostDaemonStatus({
          childProcess: null,
          expectedHostId: "host-expected",
          expectedServerUrl: "https://bb.example.test",
          port: address.port,
          timeoutMs: 25,
        }),
      ).rejects.toThrow("Timed out waiting for host daemon host-expected");
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
    }
  });

  it("resolves production defaults for npx startup", () => {
    const context = resolveBbAppStartContext({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: {},
      homeDir: "/home/tester",
    });

    expect(context.dataDir).toBe("/home/tester/.bb");
    expect(context.configFile).toBe("/home/tester/.bb/config.json");
    expect(context.envFile).toBe("/home/tester/.bb/env.json");
    expect(context.serverPort).toBe(38886);
    expect(context.daemonPort).toBe(38887);
    expect(context.serverUrl).toBe("http://127.0.0.1:38886");
    expect(context.serverEntry).toBe(
      "/repo/packages/bb-app/server/dist/index.js",
    );
    expect(context.daemonEntry).toBe(
      "/repo/packages/bb-app/host-daemon/dist/daemon-bundle.mjs",
    );
    expect(context.appVersion).toBe("0.0.0-dev");
  });

  it("uses workspace build outputs when run from a source checkout", () => {
    const context = resolveBbAppStartContext({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/src/launcher.ts")
        .href,
      env: {},
      homeDir: "/home/tester",
    });

    expect(context.packageRoot).toBe("/repo/packages/bb-app");
    expect(context.appDistDir).toBe("/repo/apps/app/dist");
    expect(context.serverEntry).toBe("/repo/apps/server/dist/index.js");
    expect(context.daemonBundleDir).toBe("/repo/apps/host-daemon/dist");
    expect(context.daemonEntry).toBe(
      "/repo/apps/host-daemon/dist/daemon-bundle.mjs",
    );
  });

  it("reads appVersion from the package.json next to the resolved package root", () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const expectedVersion = z
      .object({ version: z.string() })
      .parse(
        JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")),
      ).version;
    expect(readBbAppPackageVersion(packageRoot)).toBe(expectedVersion);
  });

  it("falls back to the dev sentinel when package.json is missing", () => {
    expect(readBbAppPackageVersion("/nonexistent/bb-app/path")).toBe(
      "0.0.0-dev",
    );
  });

  it("honors explicit production ports and data directory", () => {
    const env = {
      BB_DATA_DIR: "~/custom-bb",
      BB_HOST_DAEMON_PORT: "48887",
      BB_SERVER_PORT: "48886",
    };

    expect(resolveDataDir({ env, homeDir: "/home/tester" })).toBe(
      "/home/tester/custom-bb",
    );
    expect(
      resolvePortFromEnv({ defaultPort: 1, env, name: "BB_SERVER_PORT" }),
    ).toBe(48886);
    expect(
      resolvePortFromEnv({ defaultPort: 1, env, name: "BB_HOST_DAEMON_PORT" }),
    ).toBe(48887);
  });

  it("creates host enroll-key request bodies", () => {
    expect(createHostEnrollKeyRequestBody({ requestedHostId: null })).toEqual(
      {},
    );
    expect(
      createHostEnrollKeyRequestBody({
        requestedHostId: "host_local",
      }),
    ).toEqual({
      hostId: "host_local",
    });
  });

  it("starts bb when no command or the explicit start command is provided", () => {
    expect(resolveBbAppCommand([])).toEqual({ kind: "start" });
    expect(resolveBbAppCommand(["start"])).toEqual({ kind: "start" });
  });

  it("stops bb on the explicit stop command only", () => {
    expect(resolveBbAppCommand(["stop"])).toEqual({ kind: "stop" });
    expect(resolveBbAppCommand(["stop", "now"])).toEqual({
      command: "stop",
      kind: "invalid",
    });
  });

  it("keeps CLI commands on the bb binary", () => {
    expect(resolveBbAppCommand(["status"])).toEqual({
      command: "status",
      kind: "invalid",
    });
    expect(resolveBbAppCommand(["thread", "list"])).toEqual({
      command: "thread",
      kind: "invalid",
    });
  });

  it("starts only the host daemon for the explicit host-daemon start command", () => {
    expect(resolveBbAppCommand(["host-daemon"])).toEqual({
      args: [],
      kind: "host-daemon",
    });
    expect(resolveBbAppCommand(["host-daemon", "join"])).toEqual({
      args: ["join"],
      kind: "host-daemon",
    });
  });

  it("resolves config commands", () => {
    expect(
      resolveBbAppCommand(["config", "set", "BB_APP_URL", "https://bb.test"]),
    ).toEqual({
      args: ["set", "BB_APP_URL", "https://bb.test"],
      kind: "config",
    });
  });

  it("resolves env commands", () => {
    expect(
      resolveBbAppCommand(["env", "set", "OPENAI_API_KEY", "test-key"]),
    ).toEqual({
      args: ["set", "OPENAI_API_KEY", "test-key"],
      kind: "env",
    });
  });

  it("resolves client commands", () => {
    expect(
      resolveBbAppCommand([
        "client",
        "ssh-target",
        "set",
        "https://bb.example.test",
        "devbox",
      ]),
    ).toEqual({
      args: ["ssh-target", "set", "https://bb.example.test", "devbox"],
      kind: "client",
    });
  });

  it("prints help for help requests", () => {
    expect(resolveBbAppCommand(["--help"])).toEqual({ kind: "help" });
    expect(resolveBbAppCommand(["help"])).toEqual({ kind: "help" });
  });

  it("parses launcher flags separately from commands", () => {
    expect(
      parseLauncherArgs([
        "host-daemon",
        "join",
        "--data-dir",
        "~/bb-data",
        "--server-url",
        "https://bb.example.test",
        "--join-code",
        "bbde_supplied",
        "--host-id",
        "host_remote",
        "--host-daemon-port",
        "48887",
        "--host-type",
        "persistent",
        "--auto-update",
      ]),
    ).toEqual({
      options: {
        autoUpdate: true,
        dataDir: "~/bb-data",
        help: false,
        hostDaemonPort: "48887",
        hostId: "host_remote",
        hostType: "persistent",
        joinCode: "bbde_supplied",
        json: false,
        serverUrl: "https://bb.example.test",
      },
      positionals: ["host-daemon", "join"],
    });
  });

  it("reports the server bind host separately from the loopback connection URL", async () => {
    const parsedArgs = parseLauncherArgs(["--server-bind-host", "0.0.0.0"]);
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-bind-host-"));
    const runtime = await resolveBbAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: { BB_DATA_DIR: dataDir },
      homeDir: "/home/tester",
      options: parsedArgs.options,
      serverUrlMode: "local",
    });

    expect(parsedArgs.options.serverBindHost).toBe("0.0.0.0");
    expect(runtime.serverEnv.BB_SERVER_BIND_HOST).toBe("0.0.0.0");
    expect(
      resolveServerListenerUrl({
        bindHost: runtime.serverEnv.BB_SERVER_BIND_HOST,
        port: runtime.context.serverPort,
      }),
    ).toBe("http://0.0.0.0:38886");
    expect(runtime.context.serverUrl).toBe("http://127.0.0.1:38886");
  });

  it("strips parent thread context from the production server without stripping the CLI", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-thread-context-"));
    const runtime = await resolveBbAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: {
        BB_DATA_DIR: dataDir,
        BB_ENVIRONMENT_ID: "env_parent",
        BB_PROJECT_ID: "proj_parent",
        BB_THREAD_ID: "thr_parent",
        BB_THREAD_STORAGE: "/home/tester/.bb/thread-storage/thr_parent",
      },
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "local",
    });

    expect(runtime.serverEnv.BB_ENVIRONMENT_ID).toBeUndefined();
    expect(runtime.serverEnv.BB_THREAD_ID).toBeUndefined();
    expect(runtime.serverEnv.BB_THREAD_STORAGE).toBeUndefined();
    expect(runtime.serverEnv.BB_PROJECT_ID).toBe("proj_parent");

    const daemonEnv = createDaemonEnv(runtime.context, runtime.env);
    expect(daemonEnv.BB_ENVIRONMENT_ID).toBeUndefined();
    expect(daemonEnv.BB_THREAD_ID).toBeUndefined();
    expect(daemonEnv.BB_THREAD_STORAGE).toBeUndefined();
    expect(daemonEnv.BB_PROJECT_ID).toBe("proj_parent");

    expect(runtime.env.BB_ENVIRONMENT_ID).toBe("env_parent");
    expect(runtime.env.BB_THREAD_ID).toBe("thr_parent");
    expect(runtime.env.BB_THREAD_STORAGE).toBe(
      "/home/tester/.bb/thread-storage/thr_parent",
    );

    const cliThreadIdPath = join(dataDir, "cli-thread-id.txt");
    const exitCode = await runBundledCliCommand({
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], process.env.BB_THREAD_ID ?? 'missing')",
        cliThreadIdPath,
      ],
      context: runtime.context,
      env: { ...runtime.env, BB_CLI: process.execPath },
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(cliThreadIdPath, "utf8")).toBe("thr_parent");
  });

  it("rejects an invalid server bind host before launcher startup", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-invalid-bind-host-"));

    await expect(
      runBbApp(["--data-dir", dataDir, "--server-bind-host", "localhost"]),
    ).rejects.toThrow('BB_SERVER_BIND_HOST must be "127.0.0.1" or "0.0.0.0"');
  });

  it("uses a supplied join code without requesting a loopback enroll key", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-remote-join-"));
    const context = { ...createTestStartContext(), dataDir };

    const env = await createHostDaemonJoinEnv({
      context,
      env: {
        BB_HOST_ENROLL_KEY: "bbde_supplied",
        BB_HOST_ID: "host_remote",
        BB_CONNECT_MACHINE_CREDENTIAL: "bbcm_machine",
        BB_CONNECT_MACHINE_ID: "machine-1",
      },
      serverUrl: "https://bb.example.test",
    });

    expect(env).toMatchObject({
      BB_HOST_ENROLL_KEY: "bbde_supplied",
      BB_HOST_ID: "host_remote",
    });
    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toMatchObject({
      machineCredential: "bbcm_machine",
      connectMachineId: "machine-1",
      serverUrl: "https://bb.example.test",
    });
  });

  it("requires the join-code host ID on a fresh machine", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-remote-join-"));

    await expect(
      createHostDaemonJoinEnv({
        context: { ...createTestStartContext(), dataDir },
        env: { BB_HOST_ENROLL_KEY: "bbde_supplied" },
        serverUrl: "https://bb.example.test",
      }),
    ).rejects.toThrow("--host-id is required when --join-code is supplied");
  });

  it("parses the json launcher flag", () => {
    expect(
      parseLauncherArgs(["client", "ssh-target", "list", "--json"]),
    ).toEqual({
      options: {
        help: false,
        json: true,
      },
      positionals: ["client", "ssh-target", "list"],
    });
  });

  it("uses managed config server URL when env and flags omit it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://bb.example.test" }),
      "utf8",
    );

    const context = (
      await resolveBbAppRuntimeState({
        entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js")
          .href,
        env: { BB_DATA_DIR: dataDir },
        homeDir: "/home/tester",
        options: { help: false },
        serverUrlMode: "managed",
      })
    ).context;

    expect(context.serverUrl).toBe("https://bb.example.test");
  });

  it("uses managed config server URL over ambient env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-server-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://stored.example.test" }),
      "utf8",
    );

    const runtime = await resolveBbAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: {
        BB_DATA_DIR: dataDir,
        BB_SERVER_URL: "https://ambient.example.test",
      },
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "managed",
    });

    expect(runtime.context.serverUrl).toBe("https://stored.example.test");
    expect(runtime.env.BB_SERVER_URL).toBe("https://stored.example.test");
  });

  it("keeps full-stack startup local even when managed config has a server URL", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-local-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://bb.example.test" }),
      "utf8",
    );

    const context = (
      await resolveBbAppRuntimeState({
        entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js")
          .href,
        env: { BB_DATA_DIR: dataDir },
        homeDir: "/home/tester",
        options: { help: false },
        serverUrlMode: "local",
      })
    ).context;

    expect(context.serverUrl).toBe("http://127.0.0.1:38886");
  });

  it("applies managed config environment values over ambient env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-env-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({
        config: {
          BB_APP_URL: "https://bb.example.test",
          BB_LOG_LEVEL: "debug",
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({
        env: {
          OPENAI_API_KEY: "stored-openai-key",
        },
      }),
      "utf8",
    );

    const runtime = await resolveBbAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: { BB_DATA_DIR: dataDir, OPENAI_API_KEY: "ambient-openai-key" },
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "local",
    });

    expect(runtime.env.BB_APP_URL).toBe("https://bb.example.test");
    expect(runtime.env.BB_LOG_LEVEL).toBe("debug");
    expect(runtime.env.OPENAI_API_KEY).toBe("stored-openai-key");
    expect(runtime.serverEnv.BB_LOG_LEVEL).toBe("debug");
    expect(runtime.serverEnv.OPENAI_API_KEY).toBe("stored-openai-key");
  });

  it("applies the worktree policy after conflicting saved environment values", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-worktree-policy-"));
    const storedDataDir = join(dataDir, "stored-data");
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({
        env: {
          BB_DATA_DIR: storedDataDir,
          BB_DEV_APP_PORT: "4173",
          BB_HOST_DAEMON_PORT: "48887",
          BB_INHERITED_SKILLS_ROOTS: "/stored/skills",
          BB_SERVER_BIND_HOST: "0.0.0.0",
          BB_SERVER_PORT: "48886",
          BB_TELEMETRY: "true",
          OPENAI_API_KEY: "stored-openai-key",
        },
      }),
      "utf8",
    );
    const worktreeEnv: NodeJS.ProcessEnv = {
      BB_DATA_DIR: dataDir,
      BB_HOST_DAEMON_PORT: "47887",
      BB_INHERITED_SKILLS_ROOTS: "/worktree/skills",
      BB_SERVER_PORT: "47886",
    };

    const runtime = await resolveBbAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: worktreeEnv,
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "local",
      worktreePolicy: resolveWorktreeRuntimePolicy({
        env: worktreeEnv,
        homeDir: "/home/tester",
      }),
    });

    expect(runtime.context).toMatchObject({
      daemonPort: 47887,
      dataDir,
      serverPort: 47886,
      serverUrl: "http://127.0.0.1:47886",
    });
    for (const env of [runtime.env, runtime.serverEnv]) {
      expect(env).toMatchObject({
        BB_DATA_DIR: dataDir,
        BB_HOST_DAEMON_PORT: "47887",
        BB_INHERITED_SKILLS_ROOTS: "/worktree/skills",
        BB_SERVER_BIND_HOST: "127.0.0.1",
        BB_SERVER_PORT: "47886",
        BB_TELEMETRY: "false",
        OPENAI_API_KEY: "stored-openai-key",
      });
      expect(env.BB_DEV_APP_PORT).toBeUndefined();
    }
  });

  it("uses launcher flags over managed config and ambient server URL", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-flag-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://stored.example.test" }),
      "utf8",
    );

    const runtime = await resolveBbAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: {
        BB_DATA_DIR: dataDir,
        BB_SERVER_URL: "https://ambient.example.test",
      },
      homeDir: "/home/tester",
      options: {
        help: false,
        serverUrl: "https://flag.example.test",
      },
      serverUrlMode: "managed",
    });

    expect(runtime.context.serverUrl).toBe("https://flag.example.test");
    expect(runtime.env.BB_SERVER_URL).toBe("https://flag.example.test");
  });

  it("stores managed config values from the config command", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-command-"));

    await runBbApp([
      "--data-dir",
      dataDir,
      "config",
      "set",
      "BB_APP_URL",
      "https://bb.example.test",
    ]);
    await runBbApp([
      "--data-dir",
      dataDir,
      "config",
      "set",
      "BB_INFERENCE",
      "anthropic/claude-sonnet-4-5",
    ]);
    await runBbApp([
      "--data-dir",
      dataDir,
      "config",
      "set",
      "BB_INFERENCE_FALLBACK",
      "codex/gpt-5.4-mini",
    ]);
    await runBbApp([
      "--data-dir",
      dataDir,
      "env",
      "set",
      "OPENAI_API_KEY",
      "test-openai-key",
    ]);

    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toEqual({
      config: {
        BB_APP_URL: "https://bb.example.test",
        BB_INFERENCE: "anthropic/claude-sonnet-4-5",
        BB_INFERENCE_FALLBACK: "codex/gpt-5.4-mini",
      },
    });
    expect(JSON.parse(readFileSync(join(dataDir, "env.json"), "utf8"))).toEqual(
      {
        env: {
          OPENAI_API_KEY: "test-openai-key",
        },
      },
    );
    expect(statSync(join(dataDir, "config.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, "env.json")).mode & 0o777).toBe(0o600);
  });

  it("stores client SSH targets from the client command", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-client-command-"));
    const server = await startHostListTestServer([
      {
        id: "host_1",
        name: "mbp-intel",
        status: "connected",
      },
    ]);

    try {
      await runBbApp([
        "--data-dir",
        dataDir,
        "client",
        "ssh-target",
        "set",
        `${server.url}/projects/proj_1`,
        "mbp-intel",
      ]);

      expect(server.requests()).toContain("GET /api/v1/hosts");
      expect(
        JSON.parse(readFileSync(join(dataDir, "client.json"), "utf8")),
      ).toEqual({
        servers: {
          [server.url]: {
            hosts: {
              host_1: {
                sshAuthority: "mbp-intel",
              },
            },
          },
        },
      });
      expect(statSync(join(dataDir, "client.json")).mode & 0o777).toBe(0o600);

      await runBbApp([
        "--data-dir",
        dataDir,
        "client",
        "ssh-target",
        "set",
        server.url,
        "buildbox",
        "--host-id",
        "host_2",
      ]);
      expect(
        server.requests().filter((request) => request.includes("/hosts")),
      ).toHaveLength(1);
      expect(
        JSON.parse(readFileSync(join(dataDir, "client.json"), "utf8")),
      ).toMatchObject({
        servers: {
          [server.url]: {
            hosts: {
              host_1: { sshAuthority: "mbp-intel" },
              host_2: { sshAuthority: "buildbox" },
            },
          },
        },
      });

      await runBbApp([
        "--data-dir",
        dataDir,
        "client",
        "ssh-target",
        "remove",
        server.url,
        "--host-id",
        "host_2",
      ]);
      expect(
        JSON.parse(readFileSync(join(dataDir, "client.json"), "utf8")),
      ).toEqual({
        servers: {
          [server.url]: {
            hosts: {
              host_1: { sshAuthority: "mbp-intel" },
            },
          },
        },
      });

      await runBbApp([
        "--data-dir",
        dataDir,
        "client",
        "ssh-target",
        "remove",
        server.url,
      ]);

      expect(
        JSON.parse(readFileSync(join(dataDir, "client.json"), "utf8")),
      ).toEqual({
        servers: {},
      });
    } finally {
      await server.close();
    }
  });

  it("preserves customModels across managed config writes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-custom-"));
    const customModels = [
      {
        providerId: "claude-code",
        model: "claude-example-preview[1m]",
        displayName: "Example Preview (1M)",
      },
    ];
    writeFileSync(
      join(dataDir, "config.json"),
      `${JSON.stringify({ customModels })}\n`,
      "utf8",
    );

    await runBbApp([
      "--data-dir",
      dataDir,
      "config",
      "set",
      "BB_APP_URL",
      "https://bb.example.test",
    ]);

    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toEqual({
      config: {
        BB_APP_URL: "https://bb.example.test",
      },
      customModels,
    });
  });

  it("preserves invalid customModels across managed config set writes", async () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), "bb-app-config-invalid-custom-models-set-"),
    );
    const customModels = [
      { providerId: "acp-opencode", model: "my-proxy/custom-model" },
      { providerId: "not-a-provider", model: "typo-model" },
    ];
    writeFileSync(
      join(dataDir, "config.json"),
      `${JSON.stringify({ customModels })}\n`,
      "utf8",
    );

    await runBbApp([
      "--data-dir",
      dataDir,
      "config",
      "set",
      "BB_APP_URL",
      "https://bb.example.test",
    ]);

    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toEqual({
      config: {
        BB_APP_URL: "https://bb.example.test",
      },
      customModels,
    });
  });

  it("preserves customAcpAgents across managed config writes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-custom-acp-"));
    const customAcpAgents = [
      {
        id: "my-agent",
        displayName: "My Agent",
        command: "my-agent",
        args: ["acp"],
        env: { MY_AGENT_HOME: "/tmp/my-agent" },
      },
    ];
    writeFileSync(
      join(dataDir, "config.json"),
      `${JSON.stringify({ customAcpAgents })}\n`,
      "utf8",
    );

    await runBbApp([
      "--data-dir",
      dataDir,
      "config",
      "set",
      "BB_APP_URL",
      "https://bb.example.test",
    ]);

    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toEqual({
      config: {
        BB_APP_URL: "https://bb.example.test",
      },
      customAcpAgents,
    });
  });

  it("preserves invalid customAcpAgents across managed config set writes", async () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), "bb-app-config-invalid-custom-acp-set-"),
    );
    const customAcpAgents = [
      {
        id: "bad agent",
        displayName: "Bad Agent",
        command: "bad-agent",
      },
    ];
    writeFileSync(
      join(dataDir, "config.json"),
      `${JSON.stringify({ customAcpAgents })}\n`,
      "utf8",
    );

    await runBbApp([
      "--data-dir",
      dataDir,
      "config",
      "set",
      "BB_APP_URL",
      "https://bb.example.test",
    ]);

    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toEqual({
      config: {
        BB_APP_URL: "https://bb.example.test",
      },
      customAcpAgents,
    });
  });

  it("preserves invalid customAcpAgents across managed config unset writes", async () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), "bb-app-config-invalid-custom-acp-unset-"),
    );
    const customAcpAgents = [
      {
        id: "bad agent",
        displayName: "Bad Agent",
        command: "bad-agent",
      },
    ];
    writeFileSync(
      join(dataDir, "config.json"),
      `${JSON.stringify({
        config: { BB_APP_URL: "https://bb.example.test" },
        customAcpAgents,
      })}\n`,
      "utf8",
    );

    await runBbApp(["--data-dir", dataDir, "config", "unset", "BB_APP_URL"]);

    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toEqual({
      customAcpAgents,
    });
  });

  it("keeps secrets out of the config command", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-secret-config-"));

    await expect(
      runBbApp([
        "--data-dir",
        dataDir,
        "config",
        "set",
        "OPENAI_API_KEY",
        "test-openai-key",
      ]),
    ).rejects.toThrow(/bb-app env set OPENAI_API_KEY/u);
  });

  it("stores managed env values from the env command", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-env-command-"));

    await runBbApp([
      "--data-dir",
      dataDir,
      "env",
      "set",
      "ANTHROPIC_API_KEY",
      "test-anthropic-key",
    ]);

    expect(JSON.parse(readFileSync(join(dataDir, "env.json"), "utf8"))).toEqual(
      {
        env: {
          ANTHROPIC_API_KEY: "test-anthropic-key",
        },
      },
    );
    expect(statSync(join(dataDir, "env.json")).mode & 0o777).toBe(0o600);
  });

  it("rejects invalid server bind hosts before writing managed env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-invalid-bind-env-"));
    const envPath = join(dataDir, "env.json");
    const initialEnvFile = {
      env: { ANTHROPIC_API_KEY: "test-anthropic-key" },
    };
    writeFileSync(envPath, JSON.stringify(initialEnvFile), "utf8");

    await expect(
      runBbApp([
        "--data-dir",
        dataDir,
        "env",
        "set",
        "BB_SERVER_BIND_HOST",
        "localhost",
      ]),
    ).rejects.toThrow('BB_SERVER_BIND_HOST must be "127.0.0.1" or "0.0.0.0"');

    expect(JSON.parse(readFileSync(envPath, "utf8"))).toEqual(initialEnvFile);
  });

  it("unsets an invalid server bind host already in managed env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-recover-bind-env-"));
    const envPath = join(dataDir, "env.json");
    writeFileSync(
      envPath,
      JSON.stringify({ env: { BB_SERVER_BIND_HOST: "localhost" } }),
      "utf8",
    );

    await runBbApp([
      "--data-dir",
      dataDir,
      "env",
      "unset",
      "BB_SERVER_BIND_HOST",
    ]);

    expect(JSON.parse(readFileSync(envPath, "utf8"))).toEqual({});
  });

  it("names the env file when a persisted server bind host is invalid", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-bad-bind-env-"));
    const envPath = join(dataDir, "env.json");
    writeFileSync(
      envPath,
      JSON.stringify({ env: { BB_SERVER_BIND_HOST: "localhost" } }),
      "utf8",
    );

    await expect(runBbApp(["--data-dir", dataDir])).rejects.toThrow(envPath);
  });

  it("blames the flag, not the env file, for an invalid flag value", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-bad-bind-flag-"));
    const envPath = join(dataDir, "env.json");
    writeFileSync(
      envPath,
      JSON.stringify({ env: { BB_SERVER_BIND_HOST: "localhost" } }),
      "utf8",
    );

    const failure = await runBbApp([
      "--data-dir",
      dataDir,
      "--server-bind-host",
      "0.0.0.0.0",
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("BB_SERVER_BIND_HOST");
    expect((failure as Error).message).not.toContain(envPath);
  });

  it("rejects invalid env key names", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-invalid-env-"));

    await expect(
      runBbApp(["--data-dir", dataDir, "env", "set", "1BAD", "value"]),
    ).rejects.toThrow(/Invalid env key/u);
  });

  it("uses the explicit server bind host flag over managed env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-bind-host-env-"));
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({ env: { BB_SERVER_BIND_HOST: "0.0.0.0" } }),
      "utf8",
    );
    const parsedArgs = parseLauncherArgs(["--server-bind-host", "127.0.0.1"]);

    const runtime = await resolveBbAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: { BB_DATA_DIR: dataDir },
      homeDir: "/home/tester",
      options: parsedArgs.options,
      serverUrlMode: "local",
    });

    expect(runtime.serverEnv.BB_SERVER_BIND_HOST).toBe("127.0.0.1");
  });

  it("unsets managed env values", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-env-unset-"));
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({
        env: {
          OPENAI_API_KEY: "test-openai-key",
        },
      }),
      "utf8",
    );

    await runBbApp(["--data-dir", dataDir, "env", "unset", "OPENAI_API_KEY"]);

    expect(JSON.parse(readFileSync(join(dataDir, "env.json"), "utf8"))).toEqual(
      {},
    );
  });

  it("rejects invalid managed config values before writing or reloading", async () => {
    const server = await startConfigReloadTestServer();
    try {
      for (const testCase of invalidConfigCommandCases) {
        const dataDir = mkdtempSync(join(tmpdir(), "bb-app-invalid-config-"));
        const configPath = join(dataDir, "config.json");
        const initialConfig = {
          config: {
            BB_APP_URL: "https://existing.example.test",
          },
        };
        writeFileSync(
          configPath,
          `${JSON.stringify(initialConfig, null, 2)}\n`,
          "utf8",
        );

        await expect(
          runBbApp([
            "--data-dir",
            dataDir,
            "--server-port",
            String(server.port),
            "config",
            "set",
            testCase.key,
            testCase.value,
          ]),
        ).rejects.toThrow(testCase.expectedError);

        expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(
          initialConfig,
        );
      }

      expect(server.reloadCount()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("prints a restart notice when setting a startup-only config key", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-startup-config-set-"));
    const server = await startConfigReloadTestServer();

    try {
      const output = await captureStdout(() =>
        runBbApp([
          "--data-dir",
          dataDir,
          "--server-port",
          String(server.port),
          "config",
          "set",
          "BB_LOG_LEVEL",
          "debug",
        ]),
      );

      expect(output).toContain(
        "BB_LOG_LEVEL is startup-only. The running process keeps its current value; a full bb-app restart is required to apply this change. Run `bb-app stop && bb-app start`, or restart the desktop app.",
      );
      expect(output).not.toContain("Reloaded running bb server config.");
      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      await server.close();
    }
  });

  it("prints restart notices for every server startup-only managed env key", async () => {
    const server = await startConfigReloadTestServer();

    try {
      for (const testCase of startupOnlyManagedEnvCases) {
        const dataDir = mkdtempSync(join(tmpdir(), "bb-app-startup-env-set-"));
        const output = await captureStdout(() =>
          runBbApp([
            "--data-dir",
            dataDir,
            "--server-port",
            String(server.port),
            "env",
            "set",
            testCase.key,
            testCase.value,
          ]),
        );

        expect(output).toContain(
          `${testCase.key} is startup-only. The running process keeps its current value; a full bb-app restart is required to apply this change.`,
        );
        expect(output).not.toContain("Reloaded running bb server config.");
      }
      expect(server.reloadCount()).toBe(startupOnlyManagedEnvCases.length);
    } finally {
      await server.close();
    }
  });

  it("warns that wildcard exposure remains after unsetting the server bind host", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-startup-bind-unset-"));
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({ env: { BB_SERVER_BIND_HOST: "0.0.0.0" } }),
      "utf8",
    );
    const server = await startConfigReloadTestServer();

    try {
      const output = await captureStdout(() =>
        runBbApp([
          "--data-dir",
          dataDir,
          "--server-port",
          String(server.port),
          "env",
          "unset",
          "BB_SERVER_BIND_HOST",
        ]),
      );

      expect(output).toContain(
        "BB_SERVER_BIND_HOST is startup-only. The running process keeps its current value; a full bb-app restart is required to apply this change. Run `bb-app stop && bb-app start`, or restart the desktop app.",
      );
      expect(output).toContain(
        "Until then, the server keeps its previous bind address. If it was bound to 0.0.0.0, that network exposure remains open.",
      );
      expect(output).not.toContain("Reloaded running bb server config.");
      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      await server.close();
    }
  });

  it("keeps the reload confirmation for reloadable keys", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-reloadable-env-set-"));
    const server = await startConfigReloadTestServer();

    try {
      const output = await captureStdout(() =>
        runBbApp([
          "--data-dir",
          dataDir,
          "--server-port",
          String(server.port),
          "env",
          "set",
          "OPENAI_API_KEY",
          "test-openai-key",
        ]),
      );

      expect(output).toContain("Reloaded running bb server config.");
      expect(output).not.toContain("is startup-only");
    } finally {
      await server.close();
    }
  });

  it("reports that startup-only config will apply on next start without a running server", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-startup-next-start-"));
    const unavailableServer = await startConfigReloadTestServer();
    const unavailablePort = unavailableServer.port;
    await unavailableServer.close();

    const output = await captureStdout(() =>
      runBbApp([
        "--data-dir",
        dataDir,
        "--server-port",
        String(unavailablePort),
        "env",
        "set",
        "BB_SERVER_BIND_HOST",
        "0.0.0.0",
      ]),
    );

    expect(output).toContain("config will apply on next start.");
    expect(output).not.toContain("is startup-only");
  });

  it("notes configured startup-only keys after explicit refresh", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-startup-refresh-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ config: { BB_LOG_LEVEL: "debug" } }),
      "utf8",
    );
    writeFileSync(
      join(dataDir, "env.json"),
      JSON.stringify({
        env: {
          BB_FF_PLACEHOLDER: "true",
          BB_SERVER_BIND_HOST: "0.0.0.0",
          BB_SERVER_PORT: "48886",
          BB_TELEMETRY: "false",
        },
      }),
      "utf8",
    );
    const server = await startConfigReloadTestServer();

    try {
      const output = await captureStdout(() =>
        runBbApp([
          "--data-dir",
          dataDir,
          "--server-port",
          String(server.port),
          "config",
          "refresh",
        ]),
      );

      expect(output).toContain("Reloaded running bb server config.");
      expect(output).toContain(
        "Startup-only settings currently configured (BB_FF_PLACEHOLDER, BB_LOG_LEVEL, BB_SERVER_BIND_HOST, BB_SERVER_PORT, BB_TELEMETRY) apply on the next full bb-app restart.",
      );
    } finally {
      await server.close();
    }
  });

  it("asks a running local server to reload after config writes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-reload-"));
    const server = await startConfigReloadTestServer();

    try {
      await runBbApp([
        "--data-dir",
        dataDir,
        "--server-port",
        String(server.port),
        "config",
        "set",
        "BB_APP_URL",
        "https://bb.example.test",
      ]);

      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      await server.close();
    }
  });

  it("supports explicitly refreshing running server config", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-refresh-"));
    const server = await startConfigReloadTestServer();

    try {
      await runBbApp([
        "--data-dir",
        dataDir,
        "--server-port",
        String(server.port),
        "config",
        "refresh",
      ]);

      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      await server.close();
    }
  });

  it("uses BB_SERVER_URL for config refresh when set", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-env-refresh-"));
    const server = await startConfigReloadTestServer();
    const previousServerUrl = process.env.BB_SERVER_URL;

    try {
      process.env.BB_SERVER_URL = server.url;

      await runBbApp(["--data-dir", dataDir, "config", "refresh"]);

      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      if (previousServerUrl === undefined) {
        delete process.env.BB_SERVER_URL;
      } else {
        process.env.BB_SERVER_URL = previousServerUrl;
      }
      await server.close();
    }
  });

  it("uses persisted BB_SERVER_URL for config refresh without env or flags", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-persisted-url-"));
    const server = await startConfigReloadTestServer();

    try {
      await runBbApp([
        "--data-dir",
        dataDir,
        "config",
        "set",
        "BB_SERVER_URL",
        server.url,
      ]);

      expect(
        JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
      ).toEqual({
        serverUrl: server.url,
      });
      expect(server.reloadRequests()).toEqual([]);

      await runBbApp(["--data-dir", dataDir, "config", "refresh"]);

      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      await server.close();
    }
  });

  it("uses --server-url over env and persisted config for config refresh", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-flag-url-"));
    const configServer = await startConfigReloadTestServer();
    const envServer = await startConfigReloadTestServer();
    const flagServer = await startConfigReloadTestServer();
    const previousServerUrl = process.env.BB_SERVER_URL;

    try {
      await runBbApp([
        "--data-dir",
        dataDir,
        "config",
        "set",
        "BB_SERVER_URL",
        configServer.url,
      ]);

      process.env.BB_SERVER_URL = envServer.url;
      await runBbApp([
        "--data-dir",
        dataDir,
        "--server-url",
        flagServer.url,
        "config",
        "refresh",
      ]);

      expect(configServer.reloadRequests()).toEqual([]);
      expect(envServer.reloadRequests()).toEqual([]);
      expect(flagServer.reloadRequests()).toEqual([
        expectedConfigReloadRequest(flagServer),
      ]);
    } finally {
      if (previousServerUrl === undefined) {
        delete process.env.BB_SERVER_URL;
      } else {
        process.env.BB_SERVER_URL = previousServerUrl;
      }
      await flagServer.close();
      await envServer.close();
      await configServer.close();
    }
  });

  it("observes child processes that exited before wait registration", async () => {
    const childProcess = spawn(process.execPath, ["-e", "process.exit(7)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolvePromise, reject) => {
      childProcess.once("error", reject);
      childProcess.once("exit", () => {
        resolvePromise();
      });
    });

    await expect(
      Promise.race([waitForProcessExit(childProcess), delay({ ms: 100 })]),
    ).resolves.toEqual({ code: 7, signal: null });
  });

  it("keeps daemon running and starts only a new server after server exit", async () => {
    const supervisor = createFakeSupervisor();
    const initialServerRun = supervisor.serverRuns[0];
    const initialDaemonRun = supervisor.daemonRuns[0];
    const supervision = superviseFullStackProcesses({
      context: createTestStartContext(),
      delayMilliseconds: immediateDelay,
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: supervisor.shutdownRequested,
      processes: supervisor.processes,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    initialServerRun.exitWith({ code: 1, signal: null });
    const nextServerRun = await waitForProcessReplacement({
      currentRun: () => supervisor.processes.serverRun,
      previousRun: initialServerRun,
    });

    expect(initialServerRun.running).toBe(false);
    expect(initialDaemonRun.running).toBe(true);
    expect(supervisor.processes.daemonRun).toBe(initialDaemonRun);
    expect(supervisor.daemonRuns).toHaveLength(1);
    expect(supervisor.serverRuns).toHaveLength(2);
    expect(nextServerRun).toBe(supervisor.serverRuns[1]);
    expect(supervisor.serverRuns[1]?.running).toBe(true);

    await expect(stopFakeSupervisor(supervisor, supervision)).resolves.toBe(
      "shutdown",
    );
  });

  it("keeps server running and starts only a new daemon after daemon exit", async () => {
    const supervisor = createFakeSupervisor();
    const initialServerRun = supervisor.serverRuns[0];
    const initialDaemonRun = supervisor.daemonRuns[0];
    const supervision = superviseFullStackProcesses({
      context: createTestStartContext(),
      delayMilliseconds: immediateDelay,
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: supervisor.shutdownRequested,
      processes: supervisor.processes,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    initialDaemonRun.exitWith({ code: 1, signal: null });
    const nextDaemonRun = await waitForProcessReplacement({
      currentRun: () => supervisor.processes.daemonRun,
      previousRun: initialDaemonRun,
    });

    expect(initialDaemonRun.running).toBe(false);
    expect(initialServerRun.running).toBe(true);
    expect(supervisor.processes.serverRun).toBe(initialServerRun);
    expect(supervisor.serverRuns).toHaveLength(1);
    expect(supervisor.daemonRuns).toHaveLength(2);
    expect(nextDaemonRun).toBe(supervisor.daemonRuns[1]);
    expect(supervisor.daemonRuns[1]?.running).toBe(true);

    await expect(stopFakeSupervisor(supervisor, supervision)).resolves.toBe(
      "shutdown",
    );
  });

  it("terminates both children without restarting during shutdown", async () => {
    const supervisor = createFakeSupervisor();
    const initialServerRun = supervisor.serverRuns[0];
    const initialDaemonRun = supervisor.daemonRuns[0];
    const supervision = superviseFullStackProcesses({
      context: createTestStartContext(),
      delayMilliseconds: immediateDelay,
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: supervisor.shutdownRequested,
      processes: supervisor.processes,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    supervisor.setShutdownRequested(true);
    await terminateManagedFullStackProcesses({
      processes: supervisor.processes,
      signal: "SIGINT",
    });

    await expect(supervision).resolves.toBe("shutdown");
    expect(initialServerRun.running).toBe(false);
    expect(initialDaemonRun.running).toBe(false);
    expect(initialServerRun.terminationSignals).toEqual(["SIGINT"]);
    expect(initialDaemonRun.terminationSignals).toEqual(["SIGINT"]);
    expect(supervisor.serverRuns).toHaveLength(1);
    expect(supervisor.daemonRuns).toHaveLength(1);
  });

  it("sets exit code to 0 after clean full-stack shutdown", async () => {
    const previousExitCode = process.exitCode;
    const supervisor = createFakeSupervisor();
    const supervision = superviseFullStackProcesses({
      context: createTestStartContext(),
      delayMilliseconds: immediateDelay,
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: supervisor.shutdownRequested,
      processes: supervisor.processes,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    try {
      process.exitCode = 1;
      supervisor.setShutdownRequested(true);
      const shutdownPromise = terminateManagedFullStackProcesses({
        processes: supervisor.processes,
        signal: "SIGINT",
      });
      const supervisionResult = await supervision;

      await completeFullStackSupervision({
        shutdownPromise,
        supervisionResult,
      });

      expect(process.exitCode).toBe(0);
      expect(supervisor.serverRuns).toHaveLength(1);
      expect(supervisor.daemonRuns).toHaveLength(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("throttles repeated healthy child exits before restarting", async () => {
    const restartThrottle = new ControlledDelay();
    const supervisor = createFakeSupervisor();
    const firstServerRun = supervisor.serverRuns[0];
    const supervision = superviseFullStackProcesses({
      context: createTestStartContext(),
      delayMilliseconds: (args) => restartThrottle.delayMilliseconds(args),
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: supervisor.shutdownRequested,
      processes: supervisor.processes,
      startDaemon: supervisor.daemonStart,
      startServer: supervisor.serverStart,
    });

    firstServerRun.exitWith({ code: 1, signal: null });
    const firstDelay = await waitForDelayCall({
      delay: restartThrottle,
      index: 0,
    });
    expect(firstDelay.ms).toBe(1_000);
    expect(supervisor.serverRuns).toHaveLength(1);
    expect(supervisor.processes.serverRun).toBeNull();
    firstDelay.resolve();

    const secondServerRun = await waitForProcessReplacement({
      currentRun: () => supervisor.processes.serverRun,
      previousRun: firstServerRun,
    });
    expect(supervisor.serverRuns).toHaveLength(2);

    supervisor.serverRuns[1]?.exitWith({ code: 1, signal: null });
    const secondDelay = await waitForDelayCall({
      delay: restartThrottle,
      index: 1,
    });
    expect(secondDelay.ms).toBe(1_000);
    expect(supervisor.serverRuns).toHaveLength(2);
    expect(supervisor.processes.serverRun).toBeNull();
    secondDelay.resolve();

    const thirdServerRun = await waitForProcessReplacement({
      currentRun: () => supervisor.processes.serverRun,
      previousRun: secondServerRun,
    });
    expect(thirdServerRun).toBe(supervisor.serverRuns[2]);
    expect(supervisor.serverRuns).toHaveLength(3);

    await expect(stopFakeSupervisor(supervisor, supervision)).resolves.toBe(
      "shutdown",
    );
  });

  it("limits npm package metadata to documented runtimes", () => {
    const metadata = readPackageMetadata();

    expect(metadata.engines.node).toBe("^22.19.0 || ^24.0.0 || ^26.0.0");
    expect(metadata.files).toContain(
      "host-daemon/dist/bb-plugin-host-worker.mjs",
    );
    expect(metadata.files).toContain("host-daemon/dist/bb");
    expect(metadata.files).toContain("host-daemon/dist/bb-chunks");
    expect(metadata.os).toEqual(["darwin", "linux"]);
  });

  it("requires the bundled CLI's chunk directory next to host-daemon/dist/bb", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "bb-app-artifacts-"));
    try {
      const context = resolveBbAppStartContext({
        entrypointUrl: pathToFileURL(join(packageRoot, "dist", "bb.js")).href,
        env: {},
        homeDir: join(packageRoot, "home"),
      });
      for (const artifact of [
        context.serverEntry,
        context.daemonEntry,
        join(context.daemonBundleDir, "bb"),
        join(context.daemonBundleDir, "bb-provider-bridge-worker.mjs"),
        join(context.daemonBundleDir, "bb-parcel-watcher-child.mjs"),
        join(context.daemonBundleDir, "bb-plugin-host-worker.mjs"),
        join(context.appDistDir, "index.html"),
      ]) {
        mkdirSync(dirname(artifact), { recursive: true });
        writeFileSync(artifact, "");
      }

      const missingChunks =
        /^Missing bundled bb CLI chunks at .*\/host-daemon\/dist\/bb-chunks\. Rebuild bb-app/;
      expect(() => assertBbAppArtifacts(context)).toThrow(missingChunks);

      const chunkDir = join(context.daemonBundleDir, "bb-chunks");
      mkdirSync(chunkDir);
      expect(() => assertBbAppArtifacts(context)).toThrow(missingChunks);

      writeFileSync(join(chunkDir, "chunk-AAAAAAAA.js"), "");
      expect(() => assertBbAppArtifacts(context)).not.toThrow();

      rmSync(context.serverEntry);
      rmSync(join(context.appDistDir, "index.html"));
      expect(() => assertBbHostArtifacts(context)).not.toThrow();
      expect(() => assertBbAppArtifacts(context)).toThrow(
        /^Missing server entry/u,
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("prunes stale bb CLI chunks from package build output", () => {
    const pruneScript = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "prune-bb-chunks.mjs",
    );
    const packageRoot = mkdtempSync(join(tmpdir(), "bb-app-prune-"));
    try {
      const chunkDir = join(packageRoot, "host-daemon", "dist", "bb-chunks");
      mkdirSync(chunkDir, { recursive: true });
      writeFileSync(
        join(packageRoot, "host-daemon", "dist", "bb"),
        'import"./bb-chunks/chunk-LIVE.js";\n',
      );
      writeFileSync(join(chunkDir, "chunk-LIVE.js"), "export var a=1;\n");
      writeFileSync(join(chunkDir, "chunk-STALE.js"), "export var s=1;\n");
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "bb-app-prune-fixture",
          version: "0.0.1",
          files: ["host-daemon/dist/bb", "host-daemon/dist/bb-chunks"],
        }),
      );

      execFileSync("node", [pruneScript], { cwd: packageRoot });
      expect(readdirSync(chunkDir)).toEqual(["chunk-LIVE.js"]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("keeps the desktop app surface the desktop shell passes to the server", () => {
    const context = createTestStartContext();

    const desktopServerEnv = createServerEnv({
      context,
      env: { BB_APP_SURFACE: "desktop" },
    });
    const webServerEnv = createServerEnv({ context, env: {} });
    const invalidSurfaceServerEnv = createServerEnv({
      context,
      env: { BB_APP_SURFACE: "bogus" },
    });

    expect(desktopServerEnv.BB_APP_SURFACE).toBe("desktop");
    expect(webServerEnv.BB_APP_SURFACE).toBe("web");
    expect(invalidSurfaceServerEnv.BB_APP_SURFACE).toBe("web");
  });
});
