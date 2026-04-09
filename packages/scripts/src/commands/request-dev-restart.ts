import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTurboBuildCommand,
  resolveSupervisorPidPath,
} from "../lib/dev-restart-utils.js";

type RestartTarget = "both" | "host-daemon" | "server";

interface RestartTargetConfig {
  filters: string[];
  label: string;
  services: string[];
}

const restartTargets: Record<RestartTarget, RestartTargetConfig> = {
  both: {
    filters: ["@bb/server", "@bb/host-daemon"],
    label: "server and host-daemon",
    services: ["server", "host-daemon"],
  },
  "host-daemon": {
    filters: ["@bb/host-daemon"],
    label: "host-daemon",
    services: ["host-daemon"],
  },
  server: {
    filters: ["@bb/server"],
    label: "server",
    services: ["server"],
  },
};

export function parseTarget(value: string): RestartTarget {
  if (value === "both" || value === "host-daemon" || value === "server") {
    return value;
  }

  throw new Error('Expected one of: "both", "server", "host-daemon"');
}

export async function readRunningSupervisorPid(serviceName: string): Promise<number> {
  const pidPath = resolveSupervisorPidPath(serviceName);
  let pidText: string;

  try {
    pidText = await readFile(pidPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`No running ${serviceName} dev supervisor found at ${pidPath}`);
    }

    throw error;
  }

  const pid = Number.parseInt(pidText.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    await rm(pidPath, { force: true });
    throw new Error(`Invalid PID file for ${serviceName}: ${pidPath}`);
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      await rm(pidPath, { force: true });
      throw new Error(`Stale PID file for ${serviceName}: ${pidPath}`);
    }

    throw error;
  }

  return pid;
}

async function runBuild(filters: string[]): Promise<boolean> {
  const buildCommand = createTurboBuildCommand(filters);
  const child = spawn(buildCommand.command, buildCommand.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });

  const exitCode = await new Promise<number>((resolvePromise) => {
    child.once("error", () => {
      resolvePromise(1);
    });

    child.once("exit", (code, signal) => {
      if (signal) {
        resolvePromise(1);
        return;
      }

      resolvePromise(code ?? 1);
    });
  });

  return exitCode === 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const target = parseTarget(argv[0] ?? "both");
  const targetConfig = restartTargets[target];
  const supervisorPids = new Map<string, number>();

  for (const serviceName of targetConfig.services) {
    supervisorPids.set(serviceName, await readRunningSupervisorPid(serviceName));
  }

  process.stdout.write(`[dev] Building ${targetConfig.label} before restart.\n`);
  const buildSucceeded = await runBuild(targetConfig.filters);
  if (!buildSucceeded) {
    process.exitCode = 1;
    return;
  }

  for (const [serviceName, pid] of supervisorPids) {
    process.kill(pid, "SIGUSR1");
    process.stdout.write(`[dev] Requested ${serviceName} restart.\n`);
  }
}

if (
  process.argv[1] != null &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
