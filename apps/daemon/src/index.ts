import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { serve } from "@hono/node-server";
import {
  createConnection,
  migrate,
  ProjectRepository,
  ThreadRepository,
  EventRepository,
  TaskRepository,
} from "@beanbag/db";
import { createServer } from "./server.js";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { port: number; dbPath: string } {
  const args = process.argv.slice(2);
  let port = 3333;
  let dbPath = resolve(homedir(), ".beanbag", "beanbag.db");

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
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Beanbag Daemon

Usage: beanbag-daemon [options]

Options:
  --port, -p <number>   Port to listen on (default: 3333)
  --db, -d <path>       Path to SQLite database (default: ~/.beanbag/beanbag.db)
  --help, -h            Show this help message
`);
      process.exit(0);
    }
  }

  return { port, dbPath };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { port, dbPath } = parseArgs();

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
  const threadRepo = new ThreadRepository(db);
  const eventRepo = new EventRepository(db);
  const taskRepo = new TaskRepository(db);

  // Create server
  const { app, injectWebSocket, wsManager, threadManager } =
    createServer({
      projectRepo,
      taskRepo,
      threadRepo,
      eventRepo,
    });

  console.log("Reconciling active threads with provider...");
  await threadManager.reconcileActiveThreadsOnBoot();
  console.log("Startup reconciliation complete.");

  // Graceful shutdown handler
  let httpServer: ReturnType<typeof serve>;

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);

    // Stop all active thread processes
    threadManager.stopAll();

    // Close WebSocket connections
    wsManager.close();

    // Close HTTP server
    try {
      httpServer.close();
    } catch {
      // Ignore close errors
    }

    console.log("Shutdown complete.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

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
      console.log(`\nPress Ctrl+C to stop.\n`);
    },
  );

  // Inject WebSocket support into the Node HTTP server
  injectWebSocket(httpServer);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
