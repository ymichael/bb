import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  EnvironmentAgentCommandRepository,
  EnvironmentAgentCursorRepository,
  EnvironmentAgentSessionRepository,
  EnvironmentRepository,
  EventRepository,
  ProjectRepository,
  ThreadEnvironmentAttachmentRepository,
  ThreadRepository,
  createConnection,
  migrate,
} from "@bb/db";
import {
  createCodexProviderAdapter,
  createProviderAdapter,
  type ProviderToolHost,
} from "@bb/provider-adapters";
import { createServer } from "../../server.js";
import {
  createFakeCodexBinDir,
  createFakeCodexScriptFile,
  type FakeCodexOptions,
} from "./fake-codex.js";
import { listManagedHostEnvironmentAgentPids } from "@bb/environment";
import { bbTestTmpPrefix } from "./temp-root.js";
import { installProcessExitSafetyNet, trackPid, untrackPid } from "./process-tracker.js";
import {
  resolveE2eProviderMode,
  type E2eProviderMode,
} from "./provider-mode.js";
import { recoverManagedEnvironmentAgentSessionsOnBoot } from "../../startup-tasks.js";
import { closeHttpServer } from "../../http-server-close.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKSPACE_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");
const CLI_DIST_PATH = resolve(WORKSPACE_ROOT, "apps", "cli", "dist", "index.js");
const CLI_SOURCE_PATH = resolve(WORKSPACE_ROOT, "apps", "cli", "src", "index.ts");
const TSX_CLI_PATH = resolve(
  WORKSPACE_ROOT,
  "apps",
  "daemon",
  "node_modules",
  "tsx",
  "dist",
  "cli.mjs",
);
const PROVISIONING_SETTLE_TIMEOUT_MS = 5_000;
export const FAKE_E2E_ENVIRONMENT_AGENT_SESSION_OPTIONS = {
  leaseTtlMs: 2_000,
  heartbeatIntervalMs: 500,
  commandLongPollTimeoutMs: 1_000,
  commandLongPollIntervalMs: 50,
  leaseSweepIntervalMs: 250,
} as const;

export function withFakeE2eEnvironmentAgentTimingEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...env,
    BB_ENV_DAEMON_LEASE_TTL_MS: String(
      FAKE_E2E_ENVIRONMENT_AGENT_SESSION_OPTIONS.leaseTtlMs,
    ),
    BB_ENV_DAEMON_HEARTBEAT_INTERVAL_MS: String(
      FAKE_E2E_ENVIRONMENT_AGENT_SESSION_OPTIONS.heartbeatIntervalMs,
    ),
    BB_ENV_DAEMON_COMMAND_LONG_POLL_TIMEOUT_MS: String(
      FAKE_E2E_ENVIRONMENT_AGENT_SESSION_OPTIONS.commandLongPollTimeoutMs,
    ),
    BB_ENV_DAEMON_COMMAND_LONG_POLL_INTERVAL_MS: String(
      FAKE_E2E_ENVIRONMENT_AGENT_SESSION_OPTIONS.commandLongPollIntervalMs,
    ),
    BB_ENV_DAEMON_LEASE_SWEEP_INTERVAL_MS: String(
      FAKE_E2E_ENVIRONMENT_AGENT_SESSION_OPTIONS.leaseSweepIntervalMs,
    ),
    BB_ENV_DAEMON_STARTUP_RECOVERY_REQUEST_TIMEOUT_MS: "250",
  };
}
const TEST_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "BB Test",
  GIT_AUTHOR_EMAIL: "bb-test@example.com",
  GIT_COMMITTER_NAME: "BB Test",
  GIT_COMMITTER_EMAIL: "bb-test@example.com",
};

function prependPathEntry(
  pathValue: string | undefined,
  entryToPrepend: string,
): string {
  const entries = (pathValue ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0 && entry !== entryToPrepend);
  return [entryToPrepend, ...entries].join(delimiter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function allocatePort(host: string = "127.0.0.1"): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => rejectPort(new Error("Failed to allocate daemon e2e port")));
        return;
      }
      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

export interface StartDaemonE2eHarnessOptions {
  providerMode?: E2eProviderMode;
  providerToolHost?: ProviderToolHost;
  fakeCodex?: FakeCodexOptions;
  useWorkspaceFakeCodex?: boolean;
  environmentAgentSessionOptions?: {
    leaseTtlMs?: number;
    heartbeatIntervalMs?: number;
    commandLongPollTimeoutMs?: number;
    commandLongPollIntervalMs?: number;
    leaseSweepIntervalMs?: number;
  };
  initGitRepo?: boolean;
  tempDir?: string;
  preserveTempDirOnCleanup?: boolean;
  port?: number;
}

export interface DaemonE2eHarness {
  baseUrl: string;
  wsUrl: string;
  tempDir: string;
  dbPath: string;
  projectRoot: string;
  providerMode: E2eProviderMode;
  getEnvironmentAgentAuthorization: (threadId: string) => string | undefined;
  getEnvironmentAgentCursor: (threadId: string) => number;
  emitFakeCodexControlEvent: () => void;
  shutdownForRestart: () => Promise<void>;
  cleanup: () => Promise<void>;
}

function listPendingProvisioningTasks(
  threadManager: unknown,
): Promise<void>[] {
  const rawThreadManager = threadManager as {
    provisioningTasks?: Map<string, Promise<void>>;
  };
  return Array.from(rawThreadManager.provisioningTasks?.values() ?? []);
}

function teardownThreadManager(threadManager: unknown): Promise<void> {
  const rawThreadManager = threadManager as {
    teardownAllForTestsOnly?: () => Promise<void>;
  };
  return rawThreadManager.teardownAllForTestsOnly?.() ?? Promise.resolve();
}

function detachThreadManager(threadManager: unknown): void {
  const rawThreadManager = threadManager as {
    detachAll?: () => void;
  };
  rawThreadManager.detachAll?.();
}

export async function startDaemonE2eHarness(
  opts?: StartDaemonE2eHarnessOptions,
): Promise<DaemonE2eHarness> {
  // Install process-exit safety net once so orphaned child processes are
  // killed even when vitest terminates the worker on timeout.
  installProcessExitSafetyNet();

  const providerMode = opts?.providerMode ?? resolveE2eProviderMode();
  const environmentAgentSessionOptions = {
    ...(providerMode === "fake"
      ? FAKE_E2E_ENVIRONMENT_AGENT_SESSION_OPTIONS
      : {}),
    ...(opts?.environmentAgentSessionOptions ?? {}),
  };
  const daemonPort = opts?.port ?? await allocatePort();
  const tempDir = opts?.tempDir ?? mkdtempSync(bbTestTmpPrefix("bb-daemon-e2e-"));
  const projectRoot = join(tempDir, "project");
  mkdirSync(projectRoot, { recursive: true });
  if (opts?.initGitRepo && !existsSync(join(projectRoot, ".git"))) {
    execFileSync("git", ["init", "-b", "main"], {
      cwd: projectRoot,
      env: TEST_GIT_ENV,
      stdio: "pipe",
    });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
      cwd: projectRoot,
      env: TEST_GIT_ENV,
      stdio: "pipe",
    });
  }

  const dbPath = join(tempDir, "bb.db");
  const fakeCodexControlFilePath = join(tempDir, "fake-codex-control", "events.log");
  if (providerMode === "fake") {
    mkdirSync(dirname(fakeCodexControlFilePath), { recursive: true });
    appendFileSync(fakeCodexControlFilePath, "", "utf8");
  }
  const fakeCodexBinDir =
    providerMode === "fake" ? createFakeCodexBinDir(tempDir, opts?.fakeCodex) : undefined;
  const fakeCodexCommand = fakeCodexBinDir ? join(fakeCodexBinDir, "codex") : undefined;
  const workspaceFakeCodexPath =
    providerMode === "fake" && opts?.useWorkspaceFakeCodex
      ? createFakeCodexScriptFile(projectRoot, opts.fakeCodex)
      : undefined;
  if (workspaceFakeCodexPath && opts?.initGitRepo) {
    execFileSync("git", ["add", ".bb-test/fake-codex.cjs"], {
      cwd: projectRoot,
      env: TEST_GIT_ENV,
      stdio: "pipe",
    });
    execFileSync("git", ["commit", "-m", "add fake codex"], {
      cwd: projectRoot,
      env: TEST_GIT_ENV,
      stdio: "pipe",
    });
  }
  const daemonRuntimeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(fakeCodexBinDir
      ? { PATH: prependPathEntry(process.env.PATH, fakeCodexBinDir) }
      : {}),
  };

  const db = createConnection(dbPath);
  const sqliteClient = (db as { $client?: { close?: () => void } }).$client;

  let httpServer: ReturnType<typeof serve> | undefined;

  try {
    migrate(db);

    const projectRepo = new ProjectRepository(db);
    const threadRepo = new ThreadRepository(db);
    const eventRepo = new EventRepository(db);
    const environmentRepo = new EnvironmentRepository(db);
    const threadEnvironmentAttachmentRepo = new ThreadEnvironmentAttachmentRepository(db);
    const environmentAgentSessionRepo = new EnvironmentAgentSessionRepository(db);
    const environmentAgentCursorRepo = new EnvironmentAgentCursorRepository(db);
    const environmentAgentCommandRepo = new EnvironmentAgentCommandRepository(db);

    const { app, injectWebSocket, wsManager, threadManager, close: closeServer } =
      createServer({
        projectRepo,
        threadRepo,
        eventRepo,
        environmentRepo,
        threadEnvironmentAttachmentRepo,
        environmentAgentSessionRepo,
        environmentAgentCursorRepo,
        environmentAgentCommandRepo,
        environmentAgentSessionOptions,
        ...(opts?.providerToolHost ? { providerToolHost: opts.providerToolHost } : {}),
        runtimeEnv: daemonRuntimeEnv,
        dbPath,
        daemonLogFilePath: join(tempDir, "daemon.log"),
        daemonBaseUrl: `http://127.0.0.1:${daemonPort}/api/v1`,
        provider:
          providerMode === "fake"
            ? createCodexProviderAdapter({
                processCommand: workspaceFakeCodexPath ? "node" : fakeCodexCommand,
                processArgs: workspaceFakeCodexPath
                  ? ["/workspace/.bb-test/fake-codex.cjs", "app-server"]
                  : ["app-server"],
                launchEnv: {
                  BB_FAKE_CODEX_CONTROL_FILE: fakeCodexControlFilePath,
                },
              })
            : createProviderAdapter(),
      });

    await threadManager.cleanupArchivedEnvironmentsOnBoot();
    await threadManager.failInterruptedProvisioningOnBoot();

    const listeningPort = await new Promise<number>((resolvePort) => {
      httpServer = serve(
        {
          fetch: app.fetch,
          hostname: "127.0.0.1",
          port: daemonPort,
        },
        (info) => resolvePort(info.port),
      );
      injectWebSocket(httpServer);
    });
    await recoverManagedEnvironmentAgentSessionsOnBoot({
      sessionRepo: environmentAgentSessionRepo,
      requestTimeoutMs:
        environmentAgentSessionOptions.heartbeatIntervalMs
          ?? FAKE_E2E_ENVIRONMENT_AGENT_SESSION_OPTIONS.heartbeatIntervalMs,
    });
    let closed = false;
    let stopped = false;

    const closeDaemon = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      closeServer();
      wsManager.close();
      if (httpServer) {
        await closeHttpServer(httpServer);
      }
      sqliteClient?.close?.();
    };

    // Snapshot environment-agent PIDs before teardown so the safety net
    // can kill them if the normal teardown path is interrupted.
    const refreshTrackedAgentPids = (): void => {
      for (const pid of listManagedHostEnvironmentAgentPids()) {
        trackPid(pid);
      }
    };

    const cleanup = async (): Promise<void> => {
      if (!stopped) {
        stopped = true;
        refreshTrackedAgentPids();
        const pendingProvisioningTasks = listPendingProvisioningTasks(threadManager);
        const teardownTask = teardownThreadManager(threadManager);
        await Promise.race([
          Promise.allSettled([...pendingProvisioningTasks, teardownTask]),
          sleep(PROVISIONING_SETTLE_TIMEOUT_MS),
        ]);
      }
      await closeDaemon();
      // After successful teardown, untrack all agent PIDs (they should be
      // dead now) so the exit handler does not try to kill recycled PIDs.
      for (const pid of listManagedHostEnvironmentAgentPids()) {
        untrackPid(pid);
      }
      if (!opts?.preserveTempDirOnCleanup) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    };

    const shutdownForRestart = async (): Promise<void> => {
      const rawThreadManager = threadManager as unknown as {
        agentServer?: {
          stopAllSessions?: (reason?: string) => void;
        };
      };
      const pendingProvisioningTasks = listPendingProvisioningTasks(threadManager);
      rawThreadManager.agentServer?.stopAllSessions?.("BB server restart");
      // Restart recovery expects managed environments to remain resumable after
      // daemon shutdown, so detach without destroying — mirrors production shutdown.
      detachThreadManager(threadManager);
      await Promise.race([
        Promise.allSettled(pendingProvisioningTasks),
        sleep(PROVISIONING_SETTLE_TIMEOUT_MS),
      ]);
      await closeDaemon();
    };

    return {
      baseUrl: `http://127.0.0.1:${listeningPort}`,
      wsUrl: `ws://127.0.0.1:${listeningPort}/ws`,
      tempDir,
      dbPath,
      projectRoot,
      providerMode,
      getEnvironmentAgentAuthorization: (threadId: string) =>
        (
          threadManager as unknown as {
            _resolveEnvironmentAgentAuthorization: (threadId: string) => string | undefined;
          }
        )._resolveEnvironmentAgentAuthorization(threadId),
      getEnvironmentAgentCursor: (threadId: string) =>
        environmentAgentCursorRepo.getByThreadId(threadId)?.sequence ?? 0,
      emitFakeCodexControlEvent: () => {
        if (providerMode !== "fake") {
          throw new Error("emitFakeCodexControlEvent is only available in fake e2e provider mode.");
        }
        appendFileSync(fakeCodexControlFilePath, "emit-next-event\n", "utf8");
      },
      shutdownForRestart,
      cleanup,
    };
  } catch (err) {
    if (httpServer) {
      await closeHttpServer(httpServer);
    }
    sqliteClient?.close?.();
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

interface CliLaunchTarget {
  command: string;
  args: string[];
}

function latestModifiedAtMs(rootPath: string): number {
  const stat = statSync(rootPath);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let latest = stat.mtimeMs;
  for (const entry of readdirSync(rootPath)) {
    latest = Math.max(latest, latestModifiedAtMs(join(rootPath, entry)));
  }
  return latest;
}

function isCurrentCliDistAvailable(): boolean {
  if (!existsSync(CLI_DIST_PATH)) {
    return false;
  }

  const cliRoot = resolve(WORKSPACE_ROOT, "apps", "cli");
  const distModifiedAtMs = latestModifiedAtMs(resolve(cliRoot, "dist"));
  const sourceLatestMs = Math.max(
    latestModifiedAtMs(resolve(cliRoot, "src")),
    latestModifiedAtMs(resolve(cliRoot, "package.json")),
    latestModifiedAtMs(resolve(cliRoot, "tsconfig.json")),
  );
  return distModifiedAtMs >= sourceLatestMs;
}

function resolveCliLaunchTarget(): CliLaunchTarget {
  if (isCurrentCliDistAvailable()) {
    return {
      command: process.execPath,
      args: [CLI_DIST_PATH],
    };
  }

  if (existsSync(TSX_CLI_PATH) && existsSync(CLI_SOURCE_PATH)) {
    return {
      command: process.execPath,
      args: [TSX_CLI_PATH, CLI_SOURCE_PATH],
    };
  }

  throw new Error(
    "Unable to launch CLI: missing tsx source runner and apps/cli/dist/index.js fallback.",
  );
}

export interface RunCliCommandOptions {
  baseUrl: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface CliRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function runCliCommand(opts: RunCliCommandOptions): Promise<CliRunResult> {
  const launchTarget = resolveCliLaunchTarget();
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      launchTarget.command,
      [...launchTarget.args, ...opts.args],
      {
        cwd: opts.cwd ?? WORKSPACE_ROOT,
        env: {
          ...process.env,
          ...opts.env,
          BB_DAEMON_URL: opts.baseUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore timeout kill errors
      }
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once("error", (err) => {
      clearTimeout(timeout);
      rejectRun(err);
    });

    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolveRun({
        exitCode,
        signal,
        stdout,
        stderr,
      });
    });
  });
}
