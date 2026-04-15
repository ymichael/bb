import type { ChildProcess } from "node:child_process";
import { resolveSupervisorPidPath } from "./dev-restart-utils.js";
import {
  removePidFileSync,
  writePidFile,
} from "./pid-file.js";
import {
  installTerminationSignalForwarding,
  killProcessIfRunning,
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

interface ScheduleForcedKillArgs {
  child: ChildProcess;
  forceKillAfterMs: number;
  serviceName: string;
}

export interface DevSupervisorOptions {
  childArgs: string[];
  childCommand: string;
  childCwd: string;
  childEnv?: NodeJS.ProcessEnv;
  serviceName: string;
}

const DEV_SUPERVISOR_FORCE_KILL_AFTER_MS = 5_000;

function formatExit(code: number, signal: NodeJS.Signals | null): string {
  if (signal) {
    return `signal ${signal}`;
  }

  return `exit code ${code}`;
}

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function scheduleForcedKill(
  args: ScheduleForcedKillArgs,
): ReturnType<typeof setTimeout> {
  const timeout = setTimeout(() => {
    if (!isChildRunning(args.child)) {
      return;
    }

    process.stderr.write(
      `[dev-supervisor:${args.serviceName}] Child did not exit after ${args.forceKillAfterMs}ms. Forcing shutdown.\n`,
    );
    killProcessIfRunning(args.child, "SIGKILL");
  }, args.forceKillAfterMs);
  timeout.unref();
  return timeout;
}

function spawnChildProcess(args: SpawnChildArgs): ChildProcess {
  return spawnScriptProcess({
    args: args.args,
    command: args.command,
    cwd: args.cwd,
    env: {
      ...process.env,
      ...args.env,
    },
    stdio: "inherit",
  });
}

function waitForChildExit(child: ChildProcess): Promise<ChildExitResult> {
  return waitForProcessExit(child);
}

export async function runDevSupervisor(options: DevSupervisorOptions): Promise<void> {
  const pidPath = resolveSupervisorPidPath(options.serviceName);
  let activeChild: ChildProcess | null = null;
  let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;
  let stopRequested = false;
  let restartRequested = false;

  const cleanupPidFile = () => {
    removePidFileSync(pidPath);
  };

  process.on("exit", cleanupPidFile);

  const clearForceKillTimeout = () => {
    if (!forceKillTimeout) {
      return;
    }

    clearTimeout(forceKillTimeout);
    forceKillTimeout = null;
  };

  const terminateActiveChild = (signal: NodeJS.Signals) => {
    if (!activeChild || !isChildRunning(activeChild)) {
      return;
    }

    killProcessIfRunning(activeChild, signal);
    clearForceKillTimeout();
    forceKillTimeout = scheduleForcedKill({
      child: activeChild,
      forceKillAfterMs: DEV_SUPERVISOR_FORCE_KILL_AFTER_MS,
      serviceName: options.serviceName,
    });
  };

  const requestStop = (signal: NodeJS.Signals) => {
    stopRequested = true;
    terminateActiveChild(signal);
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

    terminateActiveChild("SIGTERM");
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
    clearForceKillTimeout();
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

    process.stderr.write(
      `[dev-supervisor:${options.serviceName}] Child exited unexpectedly with ${formatExit(code, signal)}.\n`,
    );
    process.exitCode = code !== 0 ? code : 1;
    removeSignalForwarding();
    return;
  }
}
