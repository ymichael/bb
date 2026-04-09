import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bold, cyan, dim, green, red, yellow,
  log, beginStep, endStep,
  waitForHealth, build, createOutputBuffer,
} from "../lib/script-helpers.js";
import { commonConfig } from "@bb/config/common";
import { hostDaemonConfig } from "@bb/config/host-daemon";
import { resolveNodeEnvironment, resolveScriptMode } from "../lib/script-config.js";

interface StartHostDaemonContext {
  authFile: string;
  daemonLockDir: string;
  daemonLockFile: string;
  daemonPort: number;
  dataDir: string;
  logDir: string;
  serverUrl: string;
}

interface EnrollmentRequirements {
  enrollKey?: string;
  enrolled: boolean;
}

const commandDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(commandDir, "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");
const runHostDaemonCommandPath = fileURLToPath(new URL("./run-host-daemon.js", import.meta.url));

export function resolveStartHostDaemonContext(): StartHostDaemonContext {
  const dataDir = commonConfig.BB_DATA_DIR;

  return {
    authFile: join(dataDir, "auth.json"),
    daemonLockDir: `${join(dataDir, "daemon.lock")}.lock`,
    daemonLockFile: join(dataDir, "daemon.lock"),
    daemonPort: hostDaemonConfig.BB_HOST_DAEMON_PORT,
    dataDir,
    logDir: join(dataDir, "logs"),
    serverUrl: hostDaemonConfig.BB_SERVER_URL,
  };
}

export function resolveEnrollmentRequirements(
  context: StartHostDaemonContext,
): EnrollmentRequirements {
  const enrollKey = process.env.BB_HOST_ENROLL_KEY?.trim();
  return {
    enrollKey: enrollKey && enrollKey.length > 0 ? enrollKey : undefined,
    enrolled: existsSync(context.authFile),
  };
}

export async function main(): Promise<void> {
  const mode = resolveScriptMode();
  const context = resolveStartHostDaemonContext();
  const enrollment = resolveEnrollmentRequirements(context);

  process.stdout.write(`\n  ${bold("bb host-daemon")}\n\n`);

  if (!build({
    dataDir: context.dataDir,
    repoRoot,
    turboFilter: "--filter=@bb/host-daemon --filter=@bb/cli",
  })) {
    return;
  }

  if (existsSync(context.daemonLockDir)) {
    log(yellow("!"), "Daemon lock is held — another instance may be running");
    log(" ", dim(`lock: ${context.daemonLockDir}`));
    log(" ", dim("Remove it manually if the previous process exited uncleanly."));
    process.stdout.write("\n");
  }

  if (!enrollment.enrolled && !enrollment.enrollKey) {
    endStep(red("✗"), `Not enrolled — set BB_HOST_ENROLL_KEY to join ${context.serverUrl}`);
    process.stdout.write("\n");
    log(" ", dim("Required env vars for first-time enrollment:"));
    log(" ", dim("  BB_SERVER_URL          (optional) Override the default bb server URL"));
    log(" ", dim("  BB_HOST_ENROLL_KEY     Enroll key from the server"));
    log(" ", dim("  BB_HOST_ID             (optional) Preferred host ID"));
    process.stdout.write("\n");
    process.exitCode = 1;
    return;
  }

  beginStep(enrollment.enrolled ? "Starting daemon" : "Enrolling and starting daemon");

  const outputBuffer = createOutputBuffer();
  const daemonProcess = spawn(process.execPath, [runHostDaemonCommandPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BB_LOG_FORMAT: "pretty",
      NODE_ENV: resolveNodeEnvironment(mode),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });

  if (daemonProcess.stdout == null) {
    throw new Error("Expected host-daemon stdout to be piped");
  }

  daemonProcess.stdout.on("data", outputBuffer.handler);

  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
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

  try {
    await waitForHealth(`http://localhost:${context.daemonPort}/health`, daemonProcess);
  } catch {
    endStep(red("✗"), "Host daemon failed to start");
    log(" ", dim(`lock: ${context.daemonLockDir}`));
    log(" ", dim(`logs: ${context.logDir}/`));
    outputBuffer.flush();
    process.exitCode = daemonProcess.exitCode ?? 1;
    return;
  }

  endStep(green("✓"), "Host daemon running");

  process.stdout.write("\n");
  log(green("●"), bold("bb host-daemon is ready"));
  process.stdout.write("\n");
  log(" ", `${dim("server")}  ${cyan(context.serverUrl)}`);
  log(" ", `${dim("port")}    ${context.daemonPort}`);
  log(" ", `${dim("data")}    ${context.dataDir}`);
  log(" ", `${dim("logs")}    ${context.logDir}/`);
  log(" ", `${dim("lock")}    ${context.daemonLockFile}`);
  log(" ", `${dim("auth")}    ${context.authFile}`);
  process.stdout.write("\n");
  log(" ", dim("Press Ctrl+C to stop"));

  outputBuffer.flush();

  const exitCode = await new Promise<number>((resolvePromise) => {
    daemonProcess.once("exit", (code) => {
      resolvePromise(code ?? 1);
    });
  });

  process.exitCode = exitCode;
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
