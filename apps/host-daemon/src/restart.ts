import { spawn, type ChildProcess } from "node:child_process";

export interface RestartHostDaemonOptions {
  releaseLock: () => Promise<void>;
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
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

  const spawnProcess = options.spawnProcess ?? spawn;
  const child = spawnProcess(argv[0], argv.slice(1), {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    detached: true,
    stdio: "ignore",
  });

  child.unref();
  (options.exit ?? process.exit)(0);
}

export type RestartedChildProcess = Pick<ChildProcess, "unref">;
