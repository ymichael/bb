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
  resolveServerUrl,
} from "./lib/runtime-config.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const dataDir = resolveDataDir({ defaultDirName: DEFAULTS.dataDir.prod });
const serverUrl = resolveServerUrl({ mode: "prod" });
const daemonPort = resolveHostDaemonPort({ mode: "prod" });
const daemonLockFile = join(dataDir, "daemon.lock");
const daemonLockDir = `${daemonLockFile}.lock`;
const logDir = join(dataDir, "logs");
const authFile = join(dataDir, "auth.json");

async function main() {
  process.stdout.write(`\n  ${bold("bb host-daemon")}\n\n`);

  // ---- Build --------------------------------------------------------------
  if (!build({
    repoRoot,
    dataDir,
    turboFilter: "--filter=@bb/host-daemon --filter=@bb/cli",
  })) {
    return;
  }

  // ---- Pre-flight checks --------------------------------------------------
  if (existsSync(daemonLockDir)) {
    log(
      yellow("!"),
      "Daemon lock is held — another instance may be running",
    );
    log(" ", dim(`lock: ${daemonLockDir}`));
    log(
      " ",
      dim("Remove it manually if the previous process exited uncleanly."),
    );
    process.stdout.write("\n");
  }

  const enrolled = existsSync(authFile);
  if (!enrolled && !process.env.BB_SERVER_URL) {
    endStep(
      red("✗"),
      "BB_SERVER_URL is required — set it to the URL of the bb server",
    );
    process.stdout.write("\n");
    log(" ", dim("Required env vars for first-time enrollment:"));
    log(" ", dim("  BB_SERVER_URL          URL of the bb server"));
    log(" ", dim("  BB_HOST_ENROLL_KEY     Enroll key from the server"));
    log(" ", dim("  BB_HOST_ID             (optional) Preferred host ID"));
    process.stdout.write("\n");
    process.exitCode = 1;
    return;
  }
  if (!enrolled && !process.env.BB_HOST_ENROLL_KEY) {
    endStep(
      red("✗"),
      "Not enrolled — set BB_HOST_ENROLL_KEY to join a server",
    );
    process.stdout.write("\n");
    log(" ", dim("Required env vars for first-time enrollment:"));
    log(" ", dim("  BB_SERVER_URL          URL of the bb server"));
    log(" ", dim("  BB_HOST_ENROLL_KEY     Enroll key from the server"));
    log(" ", dim("  BB_HOST_ID             (optional) Preferred host ID"));
    process.stdout.write("\n");
    process.exitCode = 1;
    return;
  }

  // ---- Start daemon -------------------------------------------------------
  beginStep(enrolled ? "Starting daemon" : "Enrolling and starting daemon");

  const outputBuffer = createOutputBuffer();

  const daemonProcess = spawn(
    process.execPath,
    ["scripts/run-host-daemon.mjs", "--mode", "prod"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        BB_LOG_FORMAT: "pretty",
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  daemonProcess.stdout.on("data", outputBuffer.handler);

  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdout.write("\n");
    log(dim("●"), "Shutting down");
    daemonProcess.kill(signal);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const daemonHealthUrl = `http://localhost:${daemonPort}/health`;

  try {
    await waitForHealth(daemonHealthUrl, daemonProcess);
  } catch {
    endStep(red("✗"), "Host daemon failed to start");
    log(" ", dim(`lock: ${daemonLockDir}`));
    log(" ", dim(`logs: ${logDir}/`));
    outputBuffer.flush();
    process.exitCode = daemonProcess.exitCode ?? 1;
    return;
  }

  endStep(green("✓"), "Host daemon running");

  // ---- Ready --------------------------------------------------------------
  process.stdout.write("\n");
  log(green("●"), bold("bb host-daemon is ready"));
  process.stdout.write("\n");
  log(" ", `${dim("server")}  ${cyan(serverUrl)}`);
  log(" ", `${dim("port")}    ${daemonPort}`);
  log(" ", `${dim("data")}    ${dataDir}`);
  log(" ", `${dim("logs")}    ${logDir}/`);
  log(" ", `${dim("lock")}    ${daemonLockFile}`);
  log(" ", `${dim("auth")}    ${authFile}`);
  process.stdout.write("\n");
  log(" ", dim("Press Ctrl+C to stop"));

  outputBuffer.flush();

  // ---- Wait for exit ------------------------------------------------------
  const exitCode = await new Promise((resolvePromise) => {
    daemonProcess.once("exit", (code) => {
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
