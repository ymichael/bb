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
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  EnvironmentAgentCommandRepository,
  EnvironmentAgentCursorRepository,
  EnvironmentAgentSessionRepository,
  EventRepository,
  ProjectRepository,
  ThreadRepository,
  createConnection,
  migrate,
} from "@beanbag/db";
import { createCodexProviderAdapter } from "@beanbag/agent-server";
import { createServer } from "../../server.js";
import {
  createFakeCodexBinDir,
  createFakeCodexScriptFile,
  type FakeCodexOptions,
} from "./fake-codex.js";

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
const TEST_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Beanbag Test",
  GIT_AUTHOR_EMAIL: "beanbag-test@example.com",
  GIT_COMMITTER_NAME: "Beanbag Test",
  GIT_COMMITTER_EMAIL: "beanbag-test@example.com",
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

function closeHttpServer(server: ReturnType<typeof serve>): Promise<void> {
  return new Promise((resolveClose) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolveClose();
    };

    try {
      server.close(settle);
      setTimeout(settle, 250).unref();
    } catch {
      settle();
    }
  });
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
  fakeCodex?: FakeCodexOptions;
  useWorkspaceFakeCodex?: boolean;
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

function stopThreadManagerAndWait(
  threadManager: unknown,
  opts?: { preserveEnvironments?: boolean },
): Promise<void> {
  const rawThreadManager = threadManager as {
    stopAll?: (options?: { preserveEnvironments?: boolean }) => void;
  };
  rawThreadManager.stopAll?.(opts);
  return Promise.resolve();
}

export async function startDaemonE2eHarness(
  opts?: StartDaemonE2eHarnessOptions,
): Promise<DaemonE2eHarness> {
  const daemonPort = opts?.port ?? await allocatePort();
  const tempDir = opts?.tempDir ?? mkdtempSync(join(tmpdir(), "beanbag-daemon-e2e-"));
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

  const dbPath = join(tempDir, "beanbag.db");
  const fakeCodexBinDir = createFakeCodexBinDir(tempDir, opts?.fakeCodex);
  const fakeCodexCommand = join(fakeCodexBinDir, "codex");
  const fakeCodexControlFilePath = join(tempDir, "fake-codex-control", "events.log");
  const workspaceFakeCodexPath = opts?.useWorkspaceFakeCodex
    ? createFakeCodexScriptFile(projectRoot, opts.fakeCodex)
    : undefined;
  if (workspaceFakeCodexPath && opts?.initGitRepo) {
    execFileSync("git", ["add", ".beanbag-test/fake-codex.cjs"], {
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
    PATH: prependPathEntry(process.env.PATH, fakeCodexBinDir),
  };

  const db = createConnection(dbPath);
  const sqliteClient = (db as { $client?: { close?: () => void } }).$client;

  let httpServer: ReturnType<typeof serve> | undefined;

  try {
    migrate(db);

    const projectRepo = new ProjectRepository(db);
    const threadRepo = new ThreadRepository(db);
    const eventRepo = new EventRepository(db);
    const environmentAgentSessionRepo = new EnvironmentAgentSessionRepository(db);
    const environmentAgentCursorRepo = new EnvironmentAgentCursorRepository(db);
    const environmentAgentCommandRepo = new EnvironmentAgentCommandRepository(db);

    const { app, injectWebSocket, wsManager, threadManager, close: closeServer } =
      createServer({
        projectRepo,
        threadRepo,
        eventRepo,
        environmentAgentSessionRepo,
        environmentAgentCursorRepo,
        environmentAgentCommandRepo,
        runtimeEnv: daemonRuntimeEnv,
        dbPath,
        daemonLogFilePath: join(tempDir, "daemon.log"),
        daemonBaseUrl: `http://127.0.0.1:${daemonPort}/api/v1`,
        provider: createCodexProviderAdapter({
          processCommand: workspaceFakeCodexPath ? "node" : fakeCodexCommand,
          processArgs: workspaceFakeCodexPath
            ? ["/workspace/.beanbag-test/fake-codex.cjs", "app-server"]
            : ["app-server"],
          launchEnv: {
            BEANBAG_FAKE_CODEX_CONTROL_FILE: fakeCodexControlFilePath,
          },
        }),
      });

    await threadManager.reconcileActiveThreadsOnBoot();

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

    const cleanup = async (): Promise<void> => {
      if (!stopped) {
        stopped = true;
        const pendingProvisioningTasks = listPendingProvisioningTasks(threadManager);
        stopThreadManagerAndWait(threadManager);
        await Promise.race([
          Promise.allSettled(pendingProvisioningTasks),
          sleep(PROVISIONING_SETTLE_TIMEOUT_MS),
        ]);
      }
      await closeDaemon();
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
      rawThreadManager.agentServer?.stopAllSessions?.("Beanbag daemon restart");
      stopThreadManagerAndWait(threadManager, {
        preserveEnvironments: true,
      });
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
      getEnvironmentAgentAuthorization: (threadId: string) =>
        (
          threadManager as unknown as {
            _resolveEnvironmentAgentAuthorization: (threadId: string) => string | undefined;
          }
        )._resolveEnvironmentAgentAuthorization(threadId),
      getEnvironmentAgentCursor: (threadId: string) =>
        environmentAgentCursorRepo.getByThreadId(threadId)?.sequence ?? 0,
      emitFakeCodexControlEvent: () => {
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
  const distModifiedAtMs = statSync(CLI_DIST_PATH).mtimeMs;
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
