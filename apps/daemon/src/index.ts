import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { resolveBeanbagPath } from "@beanbag/agent-core/storage-paths";
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
} from "@beanbag/db";
import { createServer } from "./server.js";
import { installConsoleFileLogger } from "./file-logger.js";
import { closeHttpServer } from "./http-server-close.js";
import {
  scheduleManagedEnvironmentAgentSessionRecoveryOnBoot,
  scheduleManagedArtifactReconciliation,
} from "./startup-tasks.js";
import { resolveEnvironmentAgentStartupRecoveryRequestTimeoutMs } from "./environment-agent-timing.js";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { port: number; dbPath: string; logFilePath: string } {
  const args = process.argv.slice(2);
  let port = 3333;
  let dbPath = resolveBeanbagPath(process.env, "beanbag.db");
  let logFilePath = resolveBeanbagPath(process.env, "logs", "daemon.log");

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      if (isNaN(port)) {
        console.error(`Invalid port: ${args[i + 1]}`);
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
Beanbag Daemon

Usage: beanbag-daemon [options]

Options:
  --port, -p <number>   Port to listen on (default: 3333)
  --db, -d <path>       Path to SQLite database (default: <beanbag-root>/beanbag.db)
  --log-file, -l <path> Path to daemon log file (default: <beanbag-root>/logs/daemon.log)
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

const SUPERVISED_RESTART_ENV = "BEANBAG_SUPERVISED_RESTART";
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

    threadManagerRef?.stopAll({ preserveEnvironments: true });
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

  let listeningResolve: (() => void) | undefined;
  const listening = new Promise<void>((resolvePromise) => {
    listeningResolve = resolvePromise;
  });

  // Start listening
  httpServer = serve(
    {
      fetch: app.fetch,
      port,
      hostname: "127.0.0.1",
    },
    (info) => {
      console.log(`\nBeanbag daemon listening on http://localhost:${info.port}`);
      console.log(`  REST API: http://localhost:${info.port}/api/v1/`);
      console.log(`  WebSocket: ws://localhost:${info.port}/ws`);
      console.log(`  Database: ${dbPath}`);
      console.log(`  Log file: ${logFilePath}`);
      console.log(`\nPress Ctrl+C to stop.\n`);
      console.log("Managed artifact reconciliation scheduled in background.");
      scheduleManagedArtifactReconciliation(threadManager);
      listeningResolve?.();
    },
  );

  // Inject WebSocket support into the Node HTTP server
  injectWebSocket(httpServer);

  await listening;
  scheduleManagedEnvironmentAgentSessionRecoveryOnBoot({
    sessionRepo: environmentAgentSessionRepo,
    requestTimeoutMs: resolveEnvironmentAgentStartupRecoveryRequestTimeoutMs(process.env),
  });
  console.log("Reconciling startup environment state...");
  await threadManager.reconcileActiveThreadsOnBoot();
  console.log("Startup reconciliation complete.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
