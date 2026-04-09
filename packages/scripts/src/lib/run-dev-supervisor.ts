import type { ChildProcess } from "node:child_process";
import {
  createTurboBuildCommand,
  DEV_SUPERVISOR_RESTART_ENV,
  DEV_SUPERVISOR_RESTART_EXIT_CODE,
  resolveSupervisorPidPath,
} from "./dev-restart-utils.js";
import {
  removePidFileSync,
  writePidFile,
} from "./pid-file.js";
import {
  installTerminationSignalForwarding,
  killProcessIfRunning,
  runScriptProcess,
  spawnScriptProcess,
  waitForProcessExit,
} from "./process-helpers.js";

interface ChildExitResult {
  code: number;
  signal: NodeJS.Signals | null;
}

interface SpawnChildArgs {
  args: string[];
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface BuildArgs {
  cwd: string;
  filters: string[];
}

export interface DevSupervisorOptions {
  buildCwd: string;
  buildFilters: string[];
  childArgs: string[];
  childCommand: string;
  childCwd: string;
  childEnv?: NodeJS.ProcessEnv;
  serviceName: string;
}

function formatExit(code: number, signal: NodeJS.Signals | null): string {
  if (signal) {
    return `signal ${signal}`;
  }

  return `exit code ${code}`;
}

function spawnChildProcess(args: SpawnChildArgs): ChildProcess {
  return spawnScriptProcess({
    args: args.args,
    command: args.command,
    cwd: args.cwd,
    env: {
      ...process.env,
      ...args.env,
      [DEV_SUPERVISOR_RESTART_ENV]: "1",
    },
    stdio: "inherit",
  });
}

function waitForChildExit(child: ChildProcess): Promise<ChildExitResult> {
  return waitForProcessExit(child);
}

async function runBuild(args: BuildArgs): Promise<boolean> {
  const buildCommand = createTurboBuildCommand(args.filters);
  const exitCode = await runScriptProcess({
    args: buildCommand.args,
    command: buildCommand.command,
    cwd: args.cwd,
    env: process.env,
    stdio: "inherit",
  });
  return exitCode === 0;
}

export async function runDevSupervisor(options: DevSupervisorOptions): Promise<void> {
  const pidPath = resolveSupervisorPidPath(options.serviceName);
  let activeChild: ChildProcess | null = null;
  let stopRequested = false;
  let restartRequested = false;

  const cleanupPidFile = () => {
    removePidFileSync(pidPath);
  };

  process.on("exit", cleanupPidFile);

  const requestStop = (signal: NodeJS.Signals) => {
    stopRequested = true;

    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      activeChild.kill(signal);
    }
  };

  const removeSignalForwarding = installTerminationSignalForwarding(requestStop);
  process.on("SIGUSR1", () => {
    if (stopRequested || restartRequested) {
      return;
    }

    restartRequested = true;
    process.stdout.write(
      `[dev-supervisor:${options.serviceName}] Restart requested.\n`,
    );

    if (activeChild) {
      killProcessIfRunning(activeChild, "SIGTERM");
    }
  });

  await writePidFile({
    pid: process.pid,
    pidPath,
  });

  while (true) {
    activeChild = spawnChildProcess({
      args: options.childArgs,
      command: options.childCommand,
      cwd: options.childCwd,
      env: options.childEnv,
    });

    const { code, signal } = await waitForChildExit(activeChild);
    activeChild = null;

    if (stopRequested) {
      process.exitCode = 0;
      removeSignalForwarding();
      return;
    }

    if (restartRequested) {
      restartRequested = false;
      continue;
    }

    if (code === DEV_SUPERVISOR_RESTART_EXIT_CODE) {
      process.stdout.write(
        `[dev-supervisor:${options.serviceName}] Rebuilding before supervised restart.\n`,
      );
      const buildSucceeded = await runBuild({
        cwd: options.buildCwd,
        filters: options.buildFilters,
      });

      if (!buildSucceeded) {
        process.stderr.write(
          `[dev-supervisor:${options.serviceName}] Build failed during restart. Falling back to the last successful build.\n`,
        );
      }

      continue;
    }

    process.stderr.write(
      `[dev-supervisor:${options.serviceName}] Child exited unexpectedly with ${formatExit(code, signal)}.\n`,
    );
    process.exitCode = code !== 0 ? code : 1;
    removeSignalForwarding();
    return;
  }
}
