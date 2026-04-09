import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bold, cyan, dim, green, red, yellow,
  log, beginStep, endStep,
  waitForHealth, build, createOutputBuffer,
} from "./lib/script-helpers.mjs";
import {
  DEFAULTS,
  resolveDataDir,
  resolveHostDaemonPort,
  resolveNodeEnvironment,
  resolveServerPort,
} from "./lib/runtime-config.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const dataDir = resolveDataDir({ defaultDirName: DEFAULTS.dataDir.prod });
const serverPort = resolveServerPort({ mode: "prod" });
const daemonPort = resolveHostDaemonPort({ mode: "prod" });
const daemonLockFile = join(dataDir, "daemon.lock");
const daemonLockDir = `${daemonLockFile}.lock`;
const logDir = join(dataDir, "logs");
const dbPath = join(dataDir, "bb.db");

const outputBuffer = createOutputBuffer();

function spawnManagedProcess(args) {
  const child = spawn(args.command, args.args, {
    cwd: repoRoot,
    env: args.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout.on("data", outputBuffer.handler);
  return child;
}

async function main() {
  process.stdout.write(`\n  ${bold("bb")}\n\n`);

  // ---- Build --------------------------------------------------------------
  if (!build({
    repoRoot,
    dataDir,
    turboFilter: "--filter=@bb/app --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/cli",
  })) {
    return;
  }

  // ---- Pre-flight checks --------------------------------------------------
  if (existsSync(daemonLockDir)) {
    log(
      yellow("!"),
      `Daemon lock is held — another instance may be running`,
    );
    log(" ", dim(`lock: ${daemonLockDir}`));
    log(" ", dim(`Remove it manually if the previous process exited uncleanly.`));
    process.stdout.write("\n");
  }

  // ---- Server -------------------------------------------------------------
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const sharedEnv = {
    ...process.env,
    NODE_ENV: resolveNodeEnvironment({ mode: "prod" }),
    BB_LOG_FORMAT: "pretty",
  };

  beginStep("Starting server");

  const serverProcess = spawnManagedProcess({
    command: process.execPath,
    args: ["apps/server/dist/index.js"],
    env: sharedEnv,
  });

  let shuttingDown = false;
  let daemonProcess = null;

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdout.write("\n");
    log(dim("●"), "Shutting down");
    if (daemonProcess && !daemonProcess.killed) {
      daemonProcess.kill(signal);
    }
    serverProcess.kill(signal);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await waitForHealth(`${serverUrl}/health`, serverProcess);
  } catch {
    endStep(red("✗"), "Server failed to start (health check timed out)");
    log(" ", dim(`Check logs: ${logDir}/`));
    outputBuffer.flush();
    shutdown("SIGTERM");
    return;
  }

  endStep(green("✓"), `Server listening on ${cyan(serverUrl)}`);

  // ---- Host daemon --------------------------------------------------------
  beginStep("Starting host daemon");

  daemonProcess = spawnManagedProcess({
    command: process.execPath,
    args: ["scripts/run-host-daemon.mjs", "--mode", "prod", "--auto-join"],
    env: {
      ...sharedEnv,
      BB_SERVER_URL: serverUrl,
    },
  });

  const daemonUrl = `http://localhost:${daemonPort}`;

  try {
    await waitForHealth(`${daemonUrl}/health`, daemonProcess);
  } catch {
    endStep(red("✗"), "Host daemon failed to start");
    log(" ", dim(`lock: ${daemonLockDir}`));
    log(" ", dim(`logs: ${logDir}/`));
    outputBuffer.flush();
    shutdown("SIGTERM");
    return;
  }

  endStep(green("✓"), "Host daemon running");

  // ---- Ready --------------------------------------------------------------
  process.stdout.write("\n");
  log(green("●"), bold(`bb is ready`));
  process.stdout.write("\n");
  log(" ", `${dim("app")}     ${cyan(serverUrl)}`);
  log(" ", `${dim("data")}    ${dataDir}`);
  log(" ", `${dim("db")}      ${dbPath}`);
  log(" ", `${dim("logs")}    ${logDir}/`);
  log(" ", `${dim("lock")}    ${daemonLockFile}`);
  process.stdout.write("\n");
  log(" ", dim("Press Ctrl+C to stop"));

  outputBuffer.flush();

  // ---- Wait for exit ------------------------------------------------------
  const exitCode = await new Promise((resolvePromise) => {
    serverProcess.once("exit", (code, signal) => {
      if (daemonProcess && !daemonProcess.killed) {
        daemonProcess.kill(signal ?? "SIGTERM");
      }
      resolvePromise(code ?? 1);
    });
    daemonProcess.once("exit", (code, signal) => {
      if (!serverProcess.killed) {
        serverProcess.kill(signal ?? "SIGTERM");
      }
      resolvePromise(code ?? 1);
    });
  });

  process.exitCode = exitCode;
}

void main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
