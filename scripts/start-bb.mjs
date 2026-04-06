import "../packages/config/dist/dotenv.js";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serverConfig } from "../packages/config/dist/server.js";
import { waitForServerHealth } from "./lib/wait-for-server-health.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function buildLocalServerUrl() {
  return `http://127.0.0.1:${serverConfig.BB_SERVER_PORT}`;
}

function spawnManagedProcess(args) {
  return spawn(args.command, args.args, {
    cwd: repoRoot,
    env: args.env,
    stdio: "inherit",
  });
}

async function main() {
  const serverUrl = buildLocalServerUrl();
  const sharedEnv = {
    ...process.env,
    NODE_ENV: "production",
  };
  let daemonProcess = null;

  const serverProcess = spawnManagedProcess({
    command: process.execPath,
    args: ["apps/server/dist/index.js"],
    env: sharedEnv,
  });

  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (daemonProcess && !daemonProcess.killed) {
      daemonProcess.kill(signal);
    }
    serverProcess.kill(signal);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await waitForServerHealth(serverUrl);
  } catch (error) {
    shutdown("SIGTERM");
    throw error;
  }

  daemonProcess = spawnManagedProcess({
    command: process.execPath,
    args: ["scripts/run-host-daemon.mjs", "--mode", "prod", "--auto-join"],
    env: {
      ...sharedEnv,
      BB_SERVER_URL: serverUrl,
    },
  });

  const exitCode = await new Promise((resolvePromise) => {
    serverProcess.once("exit", (code, signal) => {
      if (!daemonProcess.killed) {
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
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
