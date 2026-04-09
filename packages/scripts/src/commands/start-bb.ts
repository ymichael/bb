import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PortableChildProcess } from "@bb/process-utils";
import {
  bold, cyan, dim, green, red, yellow,
  log, beginStep, endStep,
  waitForHealth, build, createOutputBuffer,
} from "../lib/script-helpers.js";
import type { OutputBuffer } from "../lib/script-helpers.js";
import { commonConfig } from "@bb/config/common";
import { serverConfig } from "@bb/config/server";
import {
  installTerminationSignalForwarding,
  killProcessIfRunning,
  spawnScriptProcess,
  toExitCode,
  waitForProcessExit,
} from "../lib/process-helpers.js";
import { resolveNodeEnvironment, resolveScriptMode } from "../lib/script-config.js";

interface StartBbContext {
  daemonLockDir: string;
  daemonLockFile: string;
  daemonPort: number;
  dataDir: string;
  dbPath: string;
  logDir: string;
  serverUrl: string;
  sharedEnv: NodeJS.ProcessEnv;
}

interface ManagedSpawnArgs {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv;
  outputBuffer: OutputBuffer;
}

const commandDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(commandDir, "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");
const runHostDaemonCommandPath = fileURLToPath(new URL("./run-host-daemon.js", import.meta.url));

export function resolveStartBbContext(): StartBbContext {
  const mode = resolveScriptMode();
  const dataDir = commonConfig.BB_DATA_DIR;
  const serverPort = serverConfig.BB_SERVER_PORT;
  const daemonPort = serverConfig.BB_HOST_DAEMON_PORT;
  const serverUrl = `http://127.0.0.1:${serverPort}`;

  return {
    daemonLockDir: `${join(dataDir, "daemon.lock")}.lock`,
    daemonLockFile: join(dataDir, "daemon.lock"),
    daemonPort,
    dataDir,
    dbPath: join(dataDir, "bb.db"),
    logDir: join(dataDir, "logs"),
    serverUrl,
    sharedEnv: {
      ...process.env,
      NODE_ENV: resolveNodeEnvironment(mode),
    },
  };
}

function spawnManagedProcess(args: ManagedSpawnArgs): PortableChildProcess {
  const child = spawnScriptProcess({
    args: args.args,
    command: args.command,
    cwd: repoRoot,
    env: args.env,
    stdio: ["ignore", "pipe", "inherit"],
  });

  if (child.stdout == null) {
    throw new Error("Expected managed process stdout to be piped");
  }

  child.stdout.on("data", args.outputBuffer.handler);
  return child;
}

export async function main(): Promise<void> {
  const context = resolveStartBbContext();
  const outputBuffer = createOutputBuffer();

  process.stdout.write(`\n  ${bold("bb")}\n\n`);

  if (!(await build({
    dataDir: context.dataDir,
    repoRoot,
    turboFilters: ["@bb/app", "@bb/server", "@bb/host-daemon", "@bb/cli"],
  }))) {
    return;
  }

  if (existsSync(context.daemonLockDir)) {
    log(yellow("!"), "Daemon lock is held — another instance may be running");
    log(" ", dim(`lock: ${context.daemonLockDir}`));
    log(" ", dim("Remove it manually if the previous process exited uncleanly."));
    process.stdout.write("\n");
  }

  beginStep("Starting server");

  const serverProcess = spawnManagedProcess({
    args: ["apps/server/dist/index.js"],
    command: process.execPath,
    env: context.sharedEnv,
    outputBuffer,
  });

  let shuttingDown = false;
  let daemonProcess: ChildProcess | null = null;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdout.write("\n");
    log(dim("●"), "Shutting down");
    if (daemonProcess) {
      killProcessIfRunning(daemonProcess, signal);
    }
    killProcessIfRunning(serverProcess, signal);
  };

  const removeSignalForwarding = installTerminationSignalForwarding(shutdown);

  try {
    try {
      await waitForHealth(`${context.serverUrl}/health`, serverProcess);
    } catch {
      endStep(red("✗"), "Server failed to start (health check timed out)");
      log(" ", dim(`Check logs: ${context.logDir}/`));
      outputBuffer.flush();
      shutdown("SIGTERM");
      return;
    }

    endStep(green("✓"), `Server listening on ${cyan(context.serverUrl)}`);

    beginStep("Starting host daemon");

    daemonProcess = spawnManagedProcess({
      args: [runHostDaemonCommandPath, "--auto-join"],
      command: process.execPath,
      env: {
        ...context.sharedEnv,
        BB_SERVER_URL: context.serverUrl,
      },
      outputBuffer,
    });

    try {
      await waitForHealth(`http://localhost:${context.daemonPort}/health`, daemonProcess);
    } catch {
      endStep(red("✗"), "Host daemon failed to start");
      log(" ", dim(`lock: ${context.daemonLockDir}`));
      log(" ", dim(`logs: ${context.logDir}/`));
      outputBuffer.flush();
      shutdown("SIGTERM");
      return;
    }

    endStep(green("✓"), "Host daemon running");

    process.stdout.write("\n");
    log(green("●"), bold("bb is ready"));
    process.stdout.write("\n");
    log(" ", `${dim("app")}     ${cyan(context.serverUrl)}`);
    log(" ", `${dim("data")}    ${context.dataDir}`);
    log(" ", `${dim("db")}      ${context.dbPath}`);
    log(" ", `${dim("logs")}    ${context.logDir}/`);
    log(" ", `${dim("lock")}    ${context.daemonLockFile}`);
    process.stdout.write("\n");
    log(" ", dim("Press Ctrl+C to stop"));

    outputBuffer.flush();
    const firstExit = await Promise.race([
      waitForProcessExit(serverProcess).then((result) => ({
        process: "server" as const,
        result,
      })),
      waitForProcessExit(daemonProcess).then((result) => ({
        process: "daemon" as const,
        result,
      })),
    ]);

    if (firstExit.process === "server") {
      killProcessIfRunning(daemonProcess, firstExit.result.signal ?? "SIGTERM");
    } else {
      killProcessIfRunning(serverProcess, firstExit.result.signal ?? "SIGTERM");
    }

    process.exitCode = toExitCode(firstExit.result);
  } finally {
    removeSignalForwarding();
  }
}

if (
  process.argv[1] != null &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
