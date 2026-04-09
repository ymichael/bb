import { join } from "node:path";
import { resolveConfiguredDataDir } from "@bb/config/data-dir";
import { DEFAULTS } from "@bb/config/defaults";

interface TurboBuildCommand {
  args: string[];
  command: string;
}

export const DEV_SUPERVISOR_RESTART_ENV = "BB_DEV_SUPERVISOR_RESTART";
export const DEV_SUPERVISOR_RESTART_EXIT_CODE = 75;

export function createTurboBuildCommand(filters: string[]): TurboBuildCommand {
  const args = [
    "exec",
    "turbo",
    "run",
    "build",
    "--no-daemon",
    "--no-update-notifier",
    "--ui",
    "stream",
    "--output-logs",
    "errors-only",
  ];

  for (const filter of filters) {
    args.push("--filter", filter);
  }

  return {
    args,
    command: "pnpm",
  };
}

export function resolveDevDataDir(): string {
  return resolveConfiguredDataDir({
    defaultDirName: DEFAULTS.dataDir.dev,
    env: process.env,
  });
}

export function resolveSupervisorPidPath(serviceName: string): string {
  return join(resolveDevDataDir(), "dev-supervisors", `${serviceName}.pid`);
}
