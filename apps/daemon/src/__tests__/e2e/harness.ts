import { spawn } from "node:child_process";
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
}

export interface DaemonE2eHarness {
  baseUrl: string;
  wsUrl: string;
  tempDir: string;
  dbPath: string;
  projectRoot: string;
  cleanup: () => Promise<void>;
}

export async function startDaemonE2eHarness(
  opts?: StartDaemonE2eHarnessOptions,
): Promise<DaemonE2eHarness> {
  const tempDir = mkdtempSync(join(tmpdir(), "beanbag-daemon-e2e-"));
  const projectRoot = join(tempDir, "project");
  mkdirSync(projectRoot, { recursive: true });

  const dbPath = join(tempDir, "beanbag.db");
  const fakeCodexBinDir = createFakeCodexBinDir(tempDir, opts?.fakeCodex);
  const fakeCodexCommand = join(fakeCodexBinDir, "codex");
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
        processCommand: fakeCodexCommand,
        processArgs: ["app-server"],
      }),
    });

    await threadManager.reconcileActiveThreadsOnBoot();

    const port = await new Promise<number>((resolvePort) => {
      httpServer = serve(
        {
          fetch: app.fetch,
          hostname: "127.0.0.1",
          port: 0,
        },
        (info) => resolvePort(info.port),
      );
      injectWebSocket(httpServer);
    });

    let cleanedUp = false;
    const cleanup = async (): Promise<void> => {
      if (cleanedUp) return;
      cleanedUp = true;

      threadManager.stopAll();
      wsManager.close();
      if (httpServer) {
        await closeHttpServer(httpServer);
      }
      // stopAll sends SIGTERM and clears runtime state synchronously, but child
      // "exit" callbacks can still run on the next ticks and touch repositories.
      await sleep(120);

      sqliteClient?.close?.();
      process.env.PATH = previousPath;
      rmSync(tempDir, { recursive: true, force: true });
    };

    return {
      baseUrl: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      tempDir,
      dbPath,
      projectRoot,
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
    "Unable to launch CLI: missing apps/cli/dist/index.js and tsx fallback.",
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
