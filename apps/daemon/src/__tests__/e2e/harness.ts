import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
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
  shutdownForRestart: () => Promise<void>;
  cleanup: () => Promise<void>;
}

export async function startDaemonE2eHarness(
  opts?: StartDaemonE2eHarnessOptions,
): Promise<DaemonE2eHarness> {
  const tempDir = opts?.tempDir ?? mkdtempSync(join(tmpdir(), "beanbag-daemon-e2e-"));
  const projectRoot = join(tempDir, "project");
  mkdirSync(projectRoot, { recursive: true });
  if (opts?.initGitRepo && !existsSync(join(projectRoot, ".git"))) {
    execFileSync("git", ["init", "-b", "main"], {
      cwd: projectRoot,
      stdio: "pipe",
    });
    execFileSync("git", ["config", "user.name", "Beanbag Test"], {
      cwd: projectRoot,
      stdio: "pipe",
    });
    execFileSync("git", ["config", "user.email", "beanbag-test@example.com"], {
      cwd: projectRoot,
      stdio: "pipe",
    });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
      cwd: projectRoot,
      stdio: "pipe",
    });
  }

  const dbPath = join(tempDir, "beanbag.db");
  const fakeCodexBinDir = createFakeCodexBinDir(tempDir, opts?.fakeCodex);
  const fakeCodexCommand = join(fakeCodexBinDir, "codex");
  const workspaceFakeCodexPath = opts?.useWorkspaceFakeCodex
    ? createFakeCodexScriptFile(projectRoot, opts.fakeCodex)
    : undefined;
  if (workspaceFakeCodexPath && opts?.initGitRepo) {
    execFileSync("git", ["add", ".beanbag-test/fake-codex.cjs"], {
      cwd: projectRoot,
      stdio: "pipe",
    });
    execFileSync("git", ["commit", "-m", "add fake codex"], {
      cwd: projectRoot,
      stdio: "pipe",
    });
  }
  const previousPath = process.env.PATH;
  process.env.PATH = prependPathEntry(previousPath, fakeCodexBinDir);

  const db = createConnection(dbPath);
  const sqliteClient = (db as { $client?: { close?: () => void } }).$client;

  let httpServer: ReturnType<typeof serve> | undefined;

  try {
    migrate(db);

    const projectRepo = new ProjectRepository(db);
    const threadRepo = new ThreadRepository(db);
    const eventRepo = new EventRepository(db);

    const { app, injectWebSocket, wsManager, threadManager } = createServer({
      projectRepo,
      threadRepo,
      eventRepo,
      provider: createCodexProviderAdapter({
        processCommand: workspaceFakeCodexPath ? "node" : fakeCodexCommand,
        processArgs: workspaceFakeCodexPath
          ? ["/workspace/.beanbag-test/fake-codex.cjs", "app-server"]
          : ["app-server"],
      }),
    });

    await threadManager.reconcileActiveThreadsOnBoot();

    const port = await new Promise<number>((resolvePort) => {
      httpServer = serve(
        {
          fetch: app.fetch,
          hostname: "127.0.0.1",
          port: opts?.port ?? 0,
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
      wsManager.close();
      if (httpServer) {
        await closeHttpServer(httpServer);
      }
      sqliteClient?.close?.();
      process.env.PATH = previousPath;
    };

    const cleanup = async (): Promise<void> => {
      if (!stopped) {
        stopped = true;
        threadManager.stopAll();
        // stopAll sends SIGTERM and clears runtime state synchronously, but child
        // "exit" callbacks can still run on the next ticks and touch repositories.
        await sleep(120);
      }
      await closeDaemon();
      if (!opts?.preserveTempDirOnCleanup) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    };

    const shutdownForRestart = async (): Promise<void> => {
      const rawThreadManager = threadManager as unknown as {
        agentServer?: {
          opts?: { onSessionExit?: (threadId: string, event: unknown) => void };
          stopAllSessions?: (reason?: string) => void;
        };
      };
      if (rawThreadManager.agentServer?.opts) {
        rawThreadManager.agentServer.opts.onSessionExit = undefined;
      }
      rawThreadManager.agentServer?.stopAllSessions?.("Beanbag daemon restart");
      await sleep(120);
      await closeDaemon();
    };

    return {
      baseUrl: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}/ws`,
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
        (
          threadRepo.getById(threadId) as
            | ({ environmentAgentCursor?: number } & Record<string, unknown>)
            | undefined
        )?.environmentAgentCursor ?? 0,
      shutdownForRestart,
      cleanup,
    };
  } catch (err) {
    if (httpServer) {
      await closeHttpServer(httpServer);
    }
    sqliteClient?.close?.();
    process.env.PATH = previousPath;
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

interface CliLaunchTarget {
  command: string;
  args: string[];
}

function resolveCliLaunchTarget(): CliLaunchTarget {
  if (existsSync(TSX_CLI_PATH) && existsSync(CLI_SOURCE_PATH)) {
    return {
      command: process.execPath,
      args: [TSX_CLI_PATH, CLI_SOURCE_PATH],
    };
  }

  if (existsSync(CLI_DIST_PATH)) {
    return {
      command: process.execPath,
      args: [CLI_DIST_PATH],
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
