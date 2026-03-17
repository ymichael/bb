import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { serve } from "@hono/node-server";
import { resolveBbPath } from "@bb/core/storage-paths";

// Load .env from the workspace root. Never overwrites existing env vars.
// Works for `pnpm dev`, standalone QA, and production runs from the repo.
const __daemon_dirname = dirname(fileURLToPath(import.meta.url));
const workspaceEnvPath = resolve(__daemon_dirname, "..", "..", "..", ".env");
dotenv.config({ path: workspaceEnvPath });
import {
  createConnection,
  migrate,
  EnvironmentAgentCommandRepository,
  EnvironmentAgentCursorRepository,
  EnvironmentAgentSessionRepository,
  EnvironmentRepository,
  ProjectRepository,
  ThreadEnvironmentAttachmentRepository,
  ThreadRepository,
  EventRepository,
} from "@bb/db";
import { createServer } from "./server.js";
import { installConsoleFileLogger } from "./file-logger.js";
import { closeHttpServer } from "./http-server-close.js";
import {
  scheduleManagedEnvironmentAgentSessionRecoveryOnBoot,
  scheduleManagedArtifactReconciliation,
} from "./startup-tasks.js";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { port: number; dbPath: string; logFilePath: string } {
  const args = process.argv.slice(2);
  let port = 3333;
  let dbPath = resolveBbPath(process.env, "bb.db");
  let logFilePath = resolveBbPath(process.env, "logs", "daemon.log");

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      if (isNaN(port) || port <= 0) {
        console.error(`Invalid port: ${args[i + 1]}. Port must be a positive integer.`);
        process.exit(1);
      }
      i++;
    } else if ((args[i] === "--db" || args[i] === "-d") && args[i + 1]) {
      dbPath = resolve(args[i + 1]);
      i++;
    } else if ((args[i] === "--log-file" || args[i] === "-l") && args[i + 1]) {
      logFilePath = resolve(args[i + 1]);
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
BB Server

Usage: bb-server [options]

Options:
  --port, -p <number>   Port to listen on (default: 3333)
  --db, -d <path>       Path to SQLite database (default: <bb-root>/bb.db)
  --log-file, -l <path> Path to daemon log file (default: <bb-root>/logs/daemon.log)
  --help, -h            Show this help message
`);
      process.exit(0);
    }
  }

  return { port, dbPath, logFilePath };
}

function relaunchCurrentProcess(): boolean {
  const relaunchArgv = [...process.execArgv, ...process.argv.slice(1)];
  if (relaunchArgv.length === 0) {
    return false;
  }

  try {
    const child = spawn(process.execPath, relaunchArgv, {
      detached: true,
      stdio: "ignore",
      env: process.env,
      cwd: process.cwd(),
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const SUPERVISED_RESTART_ENV = "BB_SUPERVISED_RESTART";
const SUPERVISED_RESTART_EXIT_CODE = 75;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { port, dbPath, logFilePath } = parseArgs();
  installConsoleFileLogger(logFilePath);

  // Ensure the data directory exists
  const dataDir = resolve(dbPath, "..");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    console.log(`Created data directory: ${dataDir}`);
  }

  // Initialize database
  console.log(`Opening database at: ${dbPath}`);
  const db = createConnection(dbPath);

  // Run migrations
  console.log("Running migrations...");
  migrate(db);
  console.log("Migrations complete.");

  // Create repositories
  const projectRepo = new ProjectRepository(db);
  const environmentRepo = new EnvironmentRepository(db);
  const threadEnvironmentAttachmentRepo = new ThreadEnvironmentAttachmentRepository(db);
  const threadRepo = new ThreadRepository(db);
  const eventRepo = new EventRepository(db);
  const environmentAgentSessionRepo = new EnvironmentAgentSessionRepository(db);
  const environmentAgentCursorRepo = new EnvironmentAgentCursorRepository(db);
  const environmentAgentCommandRepo = new EnvironmentAgentCommandRepository(db);

  try {
    const storageReclaim = eventRepo.reclaimStorageIfNeeded({
      ensureIncrementalAutoVacuum: true,
      minFreelistPages: 2_048,
      maxIncrementalPages: 8_192,
      minIntervalMs: 0,
    });
    if (storageReclaim.fullVacuum) {
      console.log("Enabled incremental auto-vacuum and compacted database.");
    } else if (storageReclaim.incrementalPages > 0) {
      console.log(
        `Reclaimed SQLite free pages: ${storageReclaim.incrementalPages} (remaining freelist ${storageReclaim.freelistPages}).`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Database storage maintenance skipped: ${message}`);
  }

  let httpServer: ReturnType<typeof serve> | undefined;
  let shutdownStarted = false;
  let restartRequested = false;
  let threadManagerRef: ReturnType<typeof createServer>["threadManager"] | undefined;
  let wsManagerRef: ReturnType<typeof createServer>["wsManager"] | undefined;
  let restartRecommendationMonitorRef:
    | ReturnType<typeof createServer>["restartRecommendationMonitor"]
    | undefined;
  let serverCloseRef: ReturnType<typeof createServer>["close"] | undefined;

  const shutdown = async (
    signal: string,
    opts?: { restart?: boolean; exitCode?: number },
  ): Promise<void> => {
    const exitCode = opts?.exitCode ?? 0;
    if (opts?.restart) {
      restartRequested = true;
    }
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log(
      `\nReceived ${signal}. ${restartRequested ? "Restarting" : "Shutting down"} gracefully...`,
    );

    threadManagerRef?.detachAll();
    serverCloseRef?.();
    wsManagerRef?.close();
    await closeHttpServer(httpServer);

    if (restartRequested) {
      if (process.env[SUPERVISED_RESTART_ENV] === "1") {
        console.log("Shutdown complete. Restart requested (supervised).");
        process.exit(SUPERVISED_RESTART_EXIT_CODE);
      }
      const relaunched = relaunchCurrentProcess();
      if (!relaunched) {
        console.error("Failed to relaunch daemon process.");
      }
    }

    console.log(
      restartRequested
        ? "Shutdown complete. Relaunch requested."
        : "Shutdown complete.",
    );
    process.exit(exitCode);
  };

  // Create server
  const { app, injectWebSocket, wsManager, threadManager, restartRecommendationMonitor, close } =
    createServer({
      projectRepo,
      environmentRepo,
      threadEnvironmentAttachmentRepo,
      threadRepo,
      eventRepo,
      environmentAgentSessionRepo,
      environmentAgentCursorRepo,
      environmentAgentCommandRepo,
      daemonBaseUrl: `http://127.0.0.1:${port}/api/v1`,
      dbPath,
      daemonLogFilePath: logFilePath,
      requestShutdown: (reason) => {
        void shutdown(reason);
      },
      requestRestart: (reason) => {
        void shutdown(reason, { restart: true });
      },
    });
  threadManagerRef = threadManager;
  wsManagerRef = wsManager;
  restartRecommendationMonitorRef = restartRecommendationMonitor;
  serverCloseRef = close;

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    void shutdown("uncaughtException", { exitCode: 1 });
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
    void shutdown("unhandledRejection", { exitCode: 1 });
  });

  await threadManager.cleanupArchivedEnvironmentsOnBoot();
  await threadManager.failInterruptedProvisioningOnBoot();

  let listeningResolve: (() => void) | undefined;
  const listening = new Promise<void>((resolvePromise) => {
    listeningResolve = resolvePromise;
  });

  httpServer = serve(
    {
      fetch: app.fetch,
      port,
      hostname: "127.0.0.1",
    },
    (info) => {
      console.log(`\nBB server listening on http://localhost:${info.port}`);
      console.log(`  REST API: http://localhost:${info.port}/api/v1/`);
      console.log(`  WebSocket: ws://localhost:${info.port}/ws`);
      console.log(`  Database: ${dbPath}`);
      console.log(`  Log file: ${logFilePath}`);
      console.log(`\nPress Ctrl+C to stop.\n`);
      console.log("Managed artifact reconciliation scheduled in background.");
      scheduleManagedArtifactReconciliation(threadManager);
      console.log("Managed environment-agent session recovery scheduled in background.");
      scheduleManagedEnvironmentAgentSessionRecoveryOnBoot({
        sessionRepo: environmentAgentSessionRepo,
      });
      listeningResolve?.();
    },
  );

  // Inject WebSocket support into the Node HTTP server
  injectWebSocket(httpServer);

  await listening;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
