import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostDaemonConfig } from "@bb/config/host-daemon";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { statusResponseSchema } from "@bb/host-daemon-contract/local";
import {
  createTurboBuildCommand,
  resolveSupervisorPidPath,
} from "../lib/dev-restart-utils.js";
import { readRunningPid } from "../lib/pid-file.js";
import { runScriptProcess } from "../lib/process-helpers.js";

type RestartTarget = "both" | "host-daemon" | "server";
type HostDaemonProtocolCompatibility = "compatible" | "mismatch" | "unknown";

interface RestartTargetConfig {
  filters: string[];
  label: string;
  services: string[];
}

interface RestartOutput {
  write(text: string): void;
}

interface ResolveEffectiveRestartTargetOptions {
  fetchFn?: typeof fetch;
  hostDaemonLocalPort?: number;
  output?: RestartOutput;
}

interface ResolveHostDaemonProtocolCompatibilityArgs {
  fetchFn: typeof fetch;
  hostDaemonLocalPort: number;
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

async function resolveHostDaemonProtocolCompatibility({
  fetchFn,
  hostDaemonLocalPort,
}: ResolveHostDaemonProtocolCompatibilityArgs): Promise<HostDaemonProtocolCompatibility> {
  try {
    const response = await fetchFn(
      `http://127.0.0.1:${hostDaemonLocalPort}/status`,
    );
    if (!response.ok) {
      return "unknown";
    }

    const status = statusResponseSchema.safeParse(await response.json());
    if (!status.success) {
      return "mismatch";
    }

    return status.data.protocolVersion === HOST_DAEMON_PROTOCOL_VERSION
      ? "compatible"
      : "mismatch";
  } catch {
    return "unknown";
  }
}

export async function resolveEffectiveRestartTarget(
  target: RestartTarget,
  options: ResolveEffectiveRestartTargetOptions = {},
): Promise<RestartTarget> {
  if (target !== "server") {
    return target;
  }

  const compatibility = await resolveHostDaemonProtocolCompatibility({
    fetchFn: options.fetchFn ?? fetch,
    hostDaemonLocalPort:
      options.hostDaemonLocalPort ?? hostDaemonConfig.BB_HOST_DAEMON_PORT,
  });
  if (compatibility !== "mismatch") {
    return target;
  }

  (options.output ?? process.stdout).write(
    `[dev] Host-daemon protocol differs from the rebuilt server; restarting host-daemon too.\n`,
  );
  return "both";
}

export async function readRunningSupervisorPid(
  serviceName: string,
): Promise<number> {
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

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const target = await resolveEffectiveRestartTarget(
    parseTarget(argv[0] ?? "both"),
  );
  const targetConfig = restartTargets[target];
  const supervisorPids = new Map<string, number>();

  for (const serviceName of targetConfig.services) {
    supervisorPids.set(
      serviceName,
      await readRunningSupervisorPid(serviceName),
    );
  }

  process.stdout.write(
    `[dev] Building ${targetConfig.label} before restart.\n`,
  );
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
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
