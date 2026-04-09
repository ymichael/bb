import { homedir } from "node:os";
import { join } from "node:path";

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
  return process.env.BB_DATA_DIR ?? join(homedir(), ".bb-dev");
}

export function resolveSupervisorPidPath(serviceName: string): string {
  return join(resolveDevDataDir(), "dev-supervisors", `${serviceName}.pid`);
}
