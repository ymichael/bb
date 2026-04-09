import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTurboBuildCommand,
  resolveSupervisorPidPath,
} from "../lib/dev-restart-utils.js";
import { readRunningPid } from "../lib/pid-file.js";
import { runScriptProcess } from "../lib/process-helpers.js";

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
  return readRunningPid({
    pidPath,
    serviceName,
  });
}

async function runBuild(filters: string[]): Promise<boolean> {
  const buildCommand = createTurboBuildCommand(filters);
  const exitCode = await runScriptProcess({
    args: buildCommand.args,
    command: buildCommand.command,
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
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
