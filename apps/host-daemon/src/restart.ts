import type { ChildProcess } from "node:child_process";
import { spawnPortableProcess } from "@bb/process-utils";

const DEV_SUPERVISOR_RESTART_ENV = "BB_DEV_SUPERVISOR_RESTART";
const DEV_SUPERVISOR_RESTART_EXIT_CODE = 75;

export interface RestartSpawnOptions {
  cwd: string;
  detached: true;
  env: NodeJS.ProcessEnv;
  stdio: "ignore";
}

export type RestartSpawnProcess = (
  command: string,
  args: string[],
  options: RestartSpawnOptions,
) => RestartedChildProcess;

export interface RestartHostDaemonOptions {
  releaseLock: () => Promise<void>;
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: RestartSpawnProcess;
  exit?: (code: number) => never | void;
}

export async function restartHostDaemon(
  options: RestartHostDaemonOptions,
): Promise<void> {
  const argv = options.argv ?? process.argv;
  if (argv.length === 0) {
    throw new Error("Cannot restart host daemon without process argv");
  }

  await options.releaseLock();

  const env = options.env ?? process.env;
  const exit = options.exit ?? process.exit;
  if (env[DEV_SUPERVISOR_RESTART_ENV] === "1") {
    exit(DEV_SUPERVISOR_RESTART_EXIT_CODE);
    return;
  }

  const spawnProcess =
    options.spawnProcess ??
    ((command, args, spawnOptions) =>
      spawnPortableProcess({
        command,
        args,
        cwd: spawnOptions.cwd,
        detached: spawnOptions.detached,
        env: spawnOptions.env,
        stdio: spawnOptions.stdio,
      }));
  const child = spawnProcess(argv[0], argv.slice(1), {
    cwd: options.cwd ?? process.cwd(),
    env,
    detached: true,
    stdio: "ignore",
  });

  child.unref();
  exit(0);
}

export type RestartedChildProcess = Pick<ChildProcess, "unref">;
